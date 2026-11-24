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

test("doctor checks readiness read-only without creating ledger dir and handles imsg degradation", async () => {
  const dir = testFolder("gc-doctor-");
  try {
    const ledgerDir = join(dir, "uncreated-ledger");
    const gog = createGogStub(dir, {
      account: "owner@example.com",
      contacts: [],
    });
    const imsgBin = createImsgStub(dir, { chatsExit: 1 });
    const res = await runCli(
      {
        env: {
          GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir,
          TERM_PROGRAM: "Ghostty",
        },
        platform: "darwin",
        gogBin: gog.binPath,
        imsgBin,
      },
      ["doctor", "--account", "owner@example.com"],
    );
    expect(res.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(existsSync(ledgerDir)).toBe(false);
    expect(res.data).toMatchObject({
      ready: true,
      imsg: { status: "fda-denied", owningAppHint: "Ghostty" },
      ledger: { ready: true, status: "missing-will-create-on-apply" },
    });

    const relRes = await runCli(
      {
        env: { GOOGLE_CONTACTS_LEDGER_DIR: "rel/ledger" },
        platform: "linux",
        gogBin: gog.binPath,
      },
      ["doctor"],
    );
    expect(relRes.data).toMatchObject({
      ready: false,
      imsg: { status: "unsupported-os" },
      ledger: { ready: false, status: "invalid-path" },
    });
  } finally {
    removeOwnedFolder(dir);
  }
});

test("snapshot, audit, evidence, and plan cover core read and error stations", async () => {
  const dir = testFolder("gc-read-");
  try {
    const c1 = sampleContact("c1");
    const gog = createGogStub(dir, {
      account: "owner@example.com",
      contacts: [c1],
      gmailThreads: { t1: { snippet: "Met at Acme", date: "2026-11-20" } },
    });
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") };
    const snap = await runCli({ env, gogBin: gog.binPath, platform: "linux" }, [
      "snapshot",
      "--account",
      "owner@example.com",
    ]);
    expect(snap.causeCode).toBe("SUCCESS_UNCHANGED");
    const snapFile = join(dir, "snap-envelope.json");
    writeFileSync(snapFile, JSON.stringify({ result: snap }), "utf8");

    const audited = await runCli(
      { env, gogBin: gog.binPath, platform: "linux" },
      ["audit", "--snapshot", snapFile],
    );
    expect(audited.causeCode).toBe("SUCCESS_UNCHANGED");
    const auditFile = join(dir, "audit-envelope.json");
    writeFileSync(auditFile, JSON.stringify({ result: audited }), "utf8");

    const ev = await runCli({ env, gogBin: gog.binPath, platform: "linux" }, [
      "evidence",
      "--snapshot",
      snapFile,
    ]);
    expect(ev.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(ev.data).toMatchObject({
      lanesStatus: {
        gmail: { status: "ready" },
        imsg: { status: "unsupported-os" },
        webQueue: { status: "skipped" },
      },
    });

    const imsgOnly = await runCli(
      { env, gogBin: gog.binPath, platform: "linux" },
      ["evidence", "--snapshot", snapFile, "--lane", "imsg"],
    );
    expect(imsgOnly.causeCode).toBe("DOMAIN_CONTACTS_LANE_UNAVAILABLE");

    const planned = await runCli(
      { env, gogBin: gog.binPath, platform: "linux" },
      [
        "plan",
        "--snapshot",
        snapFile,
        "--lane",
        "phone-normalize",
        "--audit",
        auditFile,
      ],
    );
    expect(planned.causeCode).toBe("SUCCESS_UNCHANGED");

    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{bad", "utf8");
    expect(
      (await runCli({ env }, ["audit", "--snapshot", badJson])).causeCode,
    ).toBe("SCHEMA_INVALID_INPUT");
    expect(
      (await runCli({ env }, ["evidence", "--snapshot", badJson])).causeCode,
    ).toBe("SCHEMA_INVALID_INPUT");
    expect(
      (
        await runCli({ env }, [
          "plan",
          "--snapshot",
          badJson,
          "--lane",
          "phone-normalize",
          "--audit",
          auditFile,
        ])
      ).causeCode,
    ).toBe("SCHEMA_INVALID_INPUT");

    const failDir = join(dir, "fail-gog");
    mkdirSync(failDir, { recursive: true });
    const authFailGog = createGogStub(failDir, {
      account: "owner@example.com",
      contacts: [],
      behavior: { listExit: 4, gmailSearchExit: 7 },
    });
    expect(
      (
        await runCli({ env, gogBin: authFailGog.binPath, platform: "linux" }, [
          "snapshot",
          "--account",
          "owner@example.com",
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_GOG_UNAVAILABLE");
    expect(
      (
        await runCli({ env, gogBin: authFailGog.binPath, platform: "linux" }, [
          "evidence",
          "--snapshot",
          snapFile,
          "--lane",
          "gmail",
        ])
      ).causeCode,
    ).toBe("TRANSIENT_NOT_STARTED");
  } finally {
    removeOwnedFolder(dir);
  }
});

test("apply verifies wire etag, settles clean rejections, and isolates unconfirmed mutations", async () => {
  const dir = testFolder("gc-apply-");
  try {
    const ledgerDir = join(dir, "ledger");
    const c1 = sampleContact("c1");
    const c2 = sampleContact("c2", {
      phoneNumbers: [{ value: "0491 570 102", type: "mobile" }],
      emailAddresses: [{ value: "c2@acme.example.com", type: "work" }],
    });
    const gog = createGogStub(dir, {
      account: "owner@example.com",
      contacts: [c1, c2],
    });
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir };
    const snapFile = join(dir, "snap.json");
    writeFileSync(snapFile, JSON.stringify(sampleSnapshot([c1, c2])), "utf8");
    const audit = await runCli({ env }, ["audit", "--snapshot", snapFile]);
    const auditFile = join(dir, "audit.json");
    writeFileSync(auditFile, JSON.stringify({ result: audit }), "utf8");

    const planC1 = await runCli({ env }, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "phone-normalize",
      "--audit",
      auditFile,
      "--contact",
      "people/c1",
    ]);
    expect(planC1.causeCode).toBe("SUCCESS_UNCHANGED");
    const planFile = join(dir, "plan-c1.json");
    writeFileSync(planFile, JSON.stringify({ result: planC1 }), "utf8");
    const seal =
      typeof planC1.data === "object" && planC1.data !== null
        ? String(Reflect.get(planC1.data, "seal"))
        : "";

    expect(
      (
        await runCli({ env, gogBin: gog.binPath }, [
          "apply",
          "--plan",
          planFile,
          "--seal",
          `sha256:${"0".repeat(64)}`,
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_SEAL_MISMATCH");

    expect(
      (
        await runCli(
          {
            env: { GOOGLE_CONTACTS_LEDGER_DIR: "rel/path" },
            gogBin: gog.binPath,
          },
          ["apply", "--plan", planFile, "--seal", seal],
        )
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_APPLY_UNAVAILABLE");

    const applied = await runCli({ env, gogBin: gog.binPath }, [
      "apply",
      "--plan",
      planFile,
      "--seal",
      seal,
    ]);
    expect(applied.causeCode).toBe("SUCCESS_COMPLETED");
    const updateCall = gog
      .readLog()
      .find((entry) => entry.args.includes("update"));
    expect(updateCall?.stdin).toContain("etag-c1-v1");
    expect(updateCall?.stdin).toContain("CONTACT");

    expect(
      (
        await runCli({ env, gogBin: gog.binPath }, [
          "apply",
          "--plan",
          planFile,
          "--seal",
          seal,
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_REVISION_DRIFT");

    expect((await runCli({ env }, ["pending"])).data).toMatchObject({
      unfinished: [],
    });
    expect(
      (
        await runCli({ env: { GOOGLE_CONTACTS_LEDGER_DIR: "rel/path" } }, [
          "pending",
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_LEDGER_UNREADABLE");

    const planC2 = await runCli({ env }, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "phone-normalize",
      "--audit",
      auditFile,
      "--contact",
      "people/c2",
    ]);
    const planC2File = join(dir, "plan-c2.json");
    writeFileSync(planC2File, JSON.stringify({ result: planC2 }), "utf8");
    const sealC2 =
      typeof planC2.data === "object" && planC2.data !== null
        ? String(Reflect.get(planC2.data, "seal"))
        : "";

    const rejectDir = join(dir, "reject");
    mkdirSync(rejectDir, { recursive: true });
    const rejectGog = createGogStub(rejectDir, {
      account: "owner@example.com",
      contacts: [c2],
      behavior: { batchUpdateExit: 1 },
    });
    const rejected = await runCli({ env, gogBin: rejectGog.binPath }, [
      "apply",
      "--plan",
      planC2File,
      "--seal",
      sealC2,
    ]);
    expect(rejected.causeCode).toBe("DOMAIN_CONTACTS_APPLY_REJECTED");
    expect(rejected.transactionState).toBe("completed");
    expect((await runCli({ env }, ["pending"])).data).toMatchObject({
      unfinished: [],
    });

    const unconfirmedDir = join(dir, "unconfirmed");
    mkdirSync(unconfirmedDir, { recursive: true });
    const unconfirmedGog = createGogStub(unconfirmedDir, {
      account: "owner@example.com",
      contacts: [c2],
      behavior: { postReadBackExit: 1 },
    });
    const unconfirmed = await runCli({ env, gogBin: unconfirmedGog.binPath }, [
      "apply",
      "--plan",
      planC2File,
      "--seal",
      sealC2,
    ]);
    expect(unconfirmed.causeCode).toBe("DOMAIN_CONTACTS_APPLY_UNCONFIRMED");
    expect(unconfirmed.transactionState).toBe("unknown");

    expect((await runCli({ env }, ["pending"])).data).toMatchObject({
      unfinished: [
        {
          commandIdentity: "google-contacts.apply",
          targets: ["owner@example.com:people/c2"],
        },
      ],
    });
    expect(
      (
        await runCli({ env, gogBin: rejectGog.binPath }, [
          "apply",
          "--plan",
          planC2File,
          "--seal",
          sealC2,
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_APPLY_UNRESOLVED");
  } finally {
    removeOwnedFolder(dir);
  }
});
