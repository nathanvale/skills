import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { createGoogleContactsCli } from "../src/google-contacts/cli.ts";
import type { GoogleContactsCliOptions } from "../src/google-contacts/cli.ts";
import {
  createGogStub,
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

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
  return { ...ran.envelope.result, message: ran.envelope.message };
}

function readSeal(data: unknown): string {
  return typeof data === "object" && data !== null
    ? String(Reflect.get(data, "seal"))
    : "";
}

test("apply executes heterogeneous sub-batches with exact wire contract and Google-computed formattedType", async () => {
  const dir = testFolder("gc-apply-wire-");
  try {
    const ledgerDir = join(dir, "ledger");
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir };
    const c1 = sampleContact("c1", { organizations: [], urls: [] });
    const c2 = sampleContact("c2", { organizations: [], urls: [] });
    const snapFile = join(dir, "snap.json");
    writeFileSync(snapFile, JSON.stringify(sampleSnapshot([c1, c2])), "utf8");
    const propFile = join(dir, "props.json");
    writeFileSync(
      propFile,
      JSON.stringify({
        schemaVersion: "contacts-proposals/1",
        account: "owner@example.com",
        proposals: [
          {
            kind: "metadata-enrich",
            target: "people/c1",
            confidence: "high",
            organizations: [{ name: "Northwind", title: "Lead" }],
          },
          {
            kind: "metadata-enrich",
            target: "people/c2",
            confidence: "high",
            urls: [{ value: "https://northwind.example.org" }],
          },
        ],
      }),
      "utf8",
    );
    const planned = await runCli({ env }, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "metadata-enrich",
      "--proposals",
      propFile,
    ]);
    expect(planned.causeCode).toBe("SUCCESS_UNCHANGED");
    const planFile = join(dir, "plan.json");
    writeFileSync(planFile, JSON.stringify({ result: planned }), "utf8");
    const seal = readSeal(planned.data);

    const gog = createGogStub(dir, {
      account: "owner@example.com",
      contacts: [c1, c2],
      behavior: { addFormattedTypeOnUpdate: true },
    });
    const applied = await runCli({ env, gogBin: gog.binPath }, [
      "apply",
      "--plan",
      planFile,
      "--seal",
      seal,
      "--client",
      "work-oauth",
    ]);
    expect(applied.causeCode).toBe("SUCCESS_COMPLETED");
    const updateCalls = gog
      .readLog()
      .filter((entry) => entry.args.includes("update"));
    expect(updateCalls.length).toBe(2);
    for (const call of updateCalls) {
      for (const expectedArg of [
        "contacts",
        "batch",
        "update",
        "--from-file",
        "-",
        "--no-input",
        "--json",
        "--enable-commands-exact=contacts.batch.update",
        "--account",
        "owner@example.com",
        "--client",
        "work-oauth",
      ]) {
        expect(call.args).toContain(expectedArg);
      }
      expect(call.stdin).toBeDefined();
      expect(
        new TextEncoder().encode(call.stdin ?? "").byteLength,
      ).toBeLessThan(900_000);
    }
    const firstPayload: unknown = JSON.parse(updateCalls[0]?.stdin ?? "{}");
    expect(firstPayload).toMatchObject({
      "people/c1": {
        etag: "etag-c1-v1",
        metadata: { sources: [{ type: "CONTACT" }] },
        organizations: [{ name: "Northwind", title: "Lead" }],
      },
    });
    const secondPayload: unknown = JSON.parse(updateCalls[1]?.stdin ?? "{}");
    expect(secondPayload).toMatchObject({
      "people/c2": {
        etag: "etag-c2-v1",
        metadata: { sources: [{ type: "CONTACT" }] },
        urls: [{ value: "https://northwind.example.org" }],
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply settles sub-batch k=1 rejection with unsent external drift and 404 cleanly", async () => {
  const dir = testFolder("gc-apply-reject-k1-");
  try {
    const ledgerDir = join(dir, "ledger");
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir };
    const c1 = sampleContact("c1", { organizations: [], urls: [] });
    const c2 = sampleContact("c2", { organizations: [], urls: [] });
    const c3 = sampleContact("c3", {
      organizations: [],
      urls: [],
      addresses: [],
    });
    const snapFile = join(dir, "snap.json");
    writeFileSync(
      snapFile,
      JSON.stringify(sampleSnapshot([c1, c2, c3])),
      "utf8",
    );
    const propFile = join(dir, "props.json");
    writeFileSync(
      propFile,
      JSON.stringify({
        schemaVersion: "contacts-proposals/1",
        account: "owner@example.com",
        proposals: [
          {
            kind: "metadata-enrich",
            target: "people/c1",
            confidence: "high",
            addresses: [{ city: "Sydney" }],
          },
          {
            kind: "metadata-enrich",
            target: "people/c2",
            confidence: "high",
            organizations: [{ name: "Acme", title: "Staff" }],
          },
          {
            kind: "metadata-enrich",
            target: "people/c3",
            confidence: "high",
            urls: [{ value: "https://acme.example.com" }],
          },
        ],
      }),
      "utf8",
    );
    const planned = await runCli({ env }, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "metadata-enrich",
      "--proposals",
      propFile,
    ]);
    const planFile = join(dir, "plan.json");
    writeFileSync(planFile, JSON.stringify({ result: planned }), "utf8");
    const seal = readSeal(planned.data);

    const driftDir = join(dir, "ext-drift");
    mkdirSync(driftDir, { recursive: true });
    const driftGog = createGogStub(driftDir, {
      account: "owner@example.com",
      contacts: [c1, c2, c3],
      behavior: {
        failOnUpdateCall: 2,
        failOnUpdateExit: 1,
        externalDriftOnUpdateCall: {
          call: 2,
          resourceName: "people/c3",
          action: "drift",
        },
      },
    });
    const rejectedDrift = await runCli({ env, gogBin: driftGog.binPath }, [
      "apply",
      "--plan",
      planFile,
      "--seal",
      seal,
    ]);
    expect(rejectedDrift.causeCode).toBe("DOMAIN_CONTACTS_APPLY_REJECTED");
    expect(rejectedDrift.transactionState).toBe("completed");
    expect(rejectedDrift.message).toContain("landed=[people/c1]");
    expect(rejectedDrift.message).toContain("untouched=[people/c2]");
    expect(rejectedDrift.message).toContain("externalDrift=[people/c3]");
    expect((await runCli({ env }, ["pending"])).data).toMatchObject({
      unfinished: [],
    });

    const delDir = join(dir, "ext-404");
    mkdirSync(delDir, { recursive: true });
    const extDelGog = createGogStub(delDir, {
      account: "owner@example.com",
      contacts: [c1, c2, c3],
      behavior: {
        failOnUpdateCall: 2,
        failOnUpdateExit: 1,
        externalDriftOnUpdateCall: {
          call: 2,
          resourceName: "people/c3",
          action: "delete",
        },
      },
    });
    const rejected404 = await runCli({ env, gogBin: extDelGog.binPath }, [
      "apply",
      "--plan",
      planFile,
      "--seal",
      seal,
    ]);
    expect(rejected404.causeCode).toBe("DOMAIN_CONTACTS_APPLY_REJECTED");
    expect(rejected404.transactionState).toBe("completed");
    expect(rejected404.message).toContain("externalDrift=[people/c3]");

    const okDir = join(dir, "retry-ok");
    mkdirSync(okDir, { recursive: true });
    const okGog = createGogStub(okDir, {
      account: "owner@example.com",
      contacts: [c1, c2, c3],
    });
    const retryOk = await runCli({ env, gogBin: okGog.binPath }, [
      "apply",
      "--plan",
      planFile,
      "--seal",
      seal,
    ]);
    expect(retryOk.causeCode).toBe("SUCCESS_COMPLETED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
