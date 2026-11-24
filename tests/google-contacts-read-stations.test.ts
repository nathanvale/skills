import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { createGoogleContactsCli } from "../src/google-contacts/cli.ts";
import type { GoogleContactsCliOptions } from "../src/google-contacts/cli.ts";
import {
  createGogStub,
  createImsgStub,
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";

setDefaultTimeout(30_000);

async function runCli(
  options: GoogleContactsCliOptions,
  argv: readonly string[],
) {
  const cli = createGoogleContactsCli(options);
  const ran = await runInProcess(cli.contract, cli.setup)(argv);
  if (ran.kind !== "envelope") {
    throw new Error(`Expected envelope, got ${ran.kind}.`);
  }
  return ran.envelope.result;
}

test("doctor verifies all gog, imsg, and ledger readiness states without touching disk", async () => {
  const dir = testFolder("gc-doc-all-");
  try {
    const ledgerDir = join(dir, "uncreated-ledger");
    const okGog = createGogStub(dir, {
      account: "owner@example.com",
      contacts: [],
    });
    const okImsg = createImsgStub(dir, { version: "0.21.1", chats: [] });
    const readyRes = await runCli(
      {
        env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir },
        platform: "darwin",
        gogBin: okGog.binPath,
        imsgBin: okImsg,
      },
      ["doctor", "--account", "owner@example.com"],
    );
    expect(readyRes.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(readyRes.data).toMatchObject({
      ready: true,
      imsg: { status: "ready", version: "0.21.1" },
      ledger: { ready: true, status: "missing-will-create-on-apply" },
    });
    expect(existsSync(ledgerDir)).toBe(false);

    const oldDir = join(dir, "old-imsg");
    mkdirSync(oldDir, { recursive: true });
    const oldImsg = createImsgStub(oldDir, { version: "0.20.9" });
    expect(
      (
        await runCli(
          {
            env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir },
            platform: "darwin",
            gogBin: okGog.binPath,
            imsgBin: oldImsg,
          },
          ["doctor"],
        )
      ).data,
    ).toMatchObject({ ready: true, imsg: { status: "outdated" } });

    expect(
      (
        await runCli(
          {
            env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir, PATH: "" },
            platform: "darwin",
            gogBin: okGog.binPath,
          },
          ["doctor"],
        )
      ).data,
    ).toMatchObject({ ready: true, imsg: { status: "missing" } });

    const fdaDir = join(dir, "fda-imsg");
    mkdirSync(fdaDir, { recursive: true });
    const fdaImsg = createImsgStub(fdaDir, { chatsExit: 1 });
    expect(
      (
        await runCli(
          {
            env: {
              GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir,
              __CFBundleIdentifier: "com.example.AgentHost",
            },
            platform: "darwin",
            gogBin: okGog.binPath,
            imsgBin: fdaImsg,
          },
          ["doctor"],
        )
      ).data,
    ).toMatchObject({
      ready: true,
      imsg: { status: "fda-denied", owningAppHint: "com.example.AgentHost" },
    });

    expect(
      (
        await runCli(
          {
            env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir },
            platform: "darwin",
            gogBin: okGog.binPath,
            imsgBin: fdaImsg,
          },
          ["doctor"],
        )
      ).data,
    ).toMatchObject({
      ready: true,
      imsg: {
        status: "fda-denied",
        owningAppHint: "your terminal or agent host application",
      },
    });

    const badGogCases: readonly {
      readonly name: string;
      readonly behavior: Readonly<Record<string, unknown>>;
    }[] = [
      { name: "outdated", behavior: { version: "0.47.9" } },
      { name: "schema-bad", behavior: { schemaExit: 2 } },
      { name: "auth-exit4", behavior: { authExit: 4 } },
      { name: "readonly-scope", behavior: { authWriteScope: false } },
    ];
    for (const item of badGogCases) {
      const sub = join(dir, item.name);
      mkdirSync(sub, { recursive: true });
      const stub = createGogStub(sub, {
        account: "owner@example.com",
        contacts: [],
        behavior: item.behavior,
      });
      const res = await runCli(
        {
          env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir },
          platform: "linux",
          gogBin: stub.binPath,
        },
        ["doctor"],
      );
      expect(res.data).toMatchObject({ ready: false });
    }

    const corruptLedger = join(dir, "corrupt-ledger");
    mkdirSync(corruptLedger, { recursive: true });
    writeFileSync(join(corruptLedger, "format"), "{corrupt-format", "utf8");
    expect(
      (
        await runCli(
          {
            env: { GOOGLE_CONTACTS_LEDGER_DIR: corruptLedger },
            platform: "linux",
            gogBin: okGog.binPath,
          },
          ["doctor"],
        )
      ).data,
    ).toMatchObject({ ready: false, ledger: { ready: false } });
  } finally {
    removeOwnedFolder(dir);
  }
});

test("snapshot covers multi-page list, targeted batch get with missing, empty exit 3, unavailable, and transient", async () => {
  const dir = testFolder("gc-snap-all-");
  try {
    const c1 = sampleContact("c1");
    const c2 = sampleContact("c2");
    const pageGog = createGogStub(dir, {
      account: "owner@example.com",
      contacts: [c1, c2],
      behavior: { listPages: [[c1], [c2]] },
    });
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") };
    const paged = await runCli({ env, gogBin: pageGog.binPath }, [
      "snapshot",
      "--account",
      "owner@example.com",
      "--client",
      "work-oauth",
    ]);
    expect(paged.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(paged.data).toMatchObject({
      schemaVersion: "contacts-snapshot/1",
      contacts: [{ resourceName: "people/c1" }, { resourceName: "people/c2" }],
    });
    const listLogs = pageGog
      .readLog()
      .filter((entry) => entry.args.includes("list"));
    expect(listLogs.length).toBe(2);
    expect(listLogs[1]?.args).toContain("--page");
    expect(listLogs[0]?.args).toContain("--client");

    const targeted = await runCli({ env, gogBin: pageGog.binPath }, [
      "snapshot",
      "--account",
      "owner@example.com",
      "--contact",
      "people/c1",
      "--contact",
      "people/vanished",
    ]);
    expect(targeted.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(targeted.data).toMatchObject({
      contacts: [{ resourceName: "people/c1" }],
      missingContacts: ["people/vanished"],
    });

    const emptyDir = join(dir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const emptyGog = createGogStub(emptyDir, {
      account: "owner@example.com",
      contacts: [],
      behavior: { listExit: 3 },
    });
    const emptyRes = await runCli({ env, gogBin: emptyGog.binPath }, [
      "snapshot",
      "--account",
      "owner@example.com",
    ]);
    expect(emptyRes.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(emptyRes.data).toMatchObject({ contacts: [] });

    const transDir = join(dir, "trans");
    mkdirSync(transDir, { recursive: true });
    const transGog = createGogStub(transDir, {
      account: "owner@example.com",
      contacts: [],
      behavior: { listExit: 8, batchGetExit: 7 },
    });
    expect(
      (
        await runCli({ env, gogBin: transGog.binPath }, [
          "snapshot",
          "--account",
          "owner@example.com",
        ])
      ).causeCode,
    ).toBe("TRANSIENT_NOT_STARTED");
    expect(
      (
        await runCli({ env, gogBin: transGog.binPath }, [
          "snapshot",
          "--account",
          "owner@example.com",
          "--contact",
          "people/c1",
        ])
      ).causeCode,
    ).toBe("TRANSIENT_NOT_STARTED");
  } finally {
    removeOwnedFolder(dir);
  }
});

test("audit preserves labels, skips PROFILE phones, finds duplicates/sparse/stale, and filters by --lane", async () => {
  const dir = testFolder("gc-audit-all-");
  try {
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") };
    const c1 = sampleContact("c1", {
      phoneNumbers: [
        { value: "0491 570 111", type: "work", formattedType: "Work" },
      ],
      emailAddresses: [{ value: "dup@acme.example.com", type: "work" }],
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const c2 = sampleContact("c2", {
      phoneNumbers: [{ value: "+61491570111", type: "mobile" }],
      emailAddresses: [{ value: "dup@acme.example.com", type: "work" }],
      organizations: [],
    });
    const profileOnly = sampleContact("prof", {
      phoneNumbers: [
        {
          value: "0491 570 112",
          type: "work",
          metadata: { source: { type: "PROFILE" } },
        },
      ],
    });
    const rawFile = join(dir, "raw-snap.json");
    writeFileSync(
      rawFile,
      JSON.stringify(sampleSnapshot([c1, c2, profileOnly])),
      "utf8",
    );
    const fullAudit = await runCli({ env }, ["audit", "--snapshot", rawFile]);
    expect(fullAudit.causeCode).toBe("SUCCESS_UNCHANGED");
    const findings: unknown =
      typeof fullAudit.data === "object" && fullAudit.data !== null
        ? Reflect.get(fullAudit.data, "findings")
        : [];
    expect(Array.isArray(findings)).toBe(true);
    const list = Array.isArray(findings) ? findings : [];
    expect(
      list.some(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          Reflect.get(f, "id") === "phone-normalize:people/prof",
      ),
    ).toBe(false);
    expect(
      list.some(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          Reflect.get(f, "kind") === "duplicate-candidate" &&
          Reflect.get(f, "confidence") === "high",
      ),
    ).toBe(true);
    expect(
      list.some(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          Reflect.get(f, "kind") === "stale-contact",
      ),
    ).toBe(true);
    expect(
      list.some(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          Reflect.get(f, "kind") === "sparse-contact",
      ),
    ).toBe(true);

    const phoneOnly = await runCli({ env }, [
      "audit",
      "--snapshot",
      rawFile,
      "--lane",
      "phone-normalize",
    ]);
    expect(phoneOnly.data).toMatchObject({
      findings: [
        {
          id: "phone-normalize:people/c1",
          normalizedPhones: [
            { value: "+61491570111", type: "work", formattedType: "Work" },
          ],
        },
      ],
    });
  } finally {
    removeOwnedFolder(dir);
  }
});
