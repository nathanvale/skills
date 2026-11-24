import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

function readSeal(data: unknown): string {
  return typeof data === "object" && data !== null
    ? String(Reflect.get(data, "seal"))
    : "";
}

test("apply covers contact-delete success/pre-delete drift, preflight failures, unconfirmed faults, and corrupt ledger", async () => {
  const dir = testFolder("gc-apply-faults-");
  try {
    const ledgerDir = join(dir, "ledger");
    const env = { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir };
    const c1 = sampleContact("c1");
    const c2 = sampleContact("c2");
    const snapFile = join(dir, "snap.json");
    writeFileSync(snapFile, JSON.stringify(sampleSnapshot([c1, c2])), "utf8");
    const delProps = join(dir, "del-props.json");
    writeFileSync(
      delProps,
      JSON.stringify({
        schemaVersion: "contacts-proposals/1",
        account: "owner@example.com",
        proposals: [
          {
            kind: "contact-delete",
            target: "people/c1",
            humanConfirmed: true,
            reason: "Stale test entry",
          },
        ],
      }),
      "utf8",
    );
    const delPlanRes = await runCli({ env }, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "contact-delete",
      "--proposals",
      delProps,
    ]);
    const delPlanFile = join(dir, "del-plan.json");
    writeFileSync(delPlanFile, JSON.stringify({ result: delPlanRes }), "utf8");
    const delSeal = readSeal(delPlanRes.data);

    const badPlanFile = join(dir, "bad-plan.json");
    writeFileSync(badPlanFile, "{bad", "utf8");
    expect(
      (
        await runCli({ env }, [
          "apply",
          "--plan",
          badPlanFile,
          "--seal",
          delSeal,
        ])
      ).causeCode,
    ).toBe("SCHEMA_INVALID_INPUT");

    const preDelDriftDir = join(dir, "predel-drift");
    mkdirSync(preDelDriftDir, { recursive: true });
    const preDelDriftGog = createGogStub(preDelDriftDir, {
      account: "owner@example.com",
      contacts: [c1],
      behavior: { driftTargetBeforeDelete: "people/c1" },
    });
    const preDelDrift = await runCli({ env, gogBin: preDelDriftGog.binPath }, [
      "apply",
      "--plan",
      delPlanFile,
      "--seal",
      delSeal,
    ]);
    expect(preDelDrift.causeCode).toBe("DOMAIN_CONTACTS_APPLY_REJECTED");
    expect(
      preDelDriftGog.readLog().some((r) => r.args.includes("delete")),
    ).toBe(false);

    const delOkDir = join(dir, "del-ok");
    mkdirSync(delOkDir, { recursive: true });
    const delOkGog = createGogStub(delOkDir, {
      account: "owner@example.com",
      contacts: [c1, c2],
    });
    expect(
      (
        await runCli({ env, gogBin: delOkGog.binPath }, [
          "apply",
          "--plan",
          delPlanFile,
          "--seal",
          delSeal,
        ])
      ).causeCode,
    ).toBe("SUCCESS_COMPLETED");
    expect(delOkGog.readState().contacts.map((c) => c.resourceName)).toEqual([
      "people/c2",
    ]);

    expect(
      (
        await runCli({ env, gogBin: delOkGog.binPath }, [
          "apply",
          "--plan",
          delPlanFile,
          "--seal",
          delSeal,
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_REVISION_DRIFT");

    const unauthDir = join(dir, "unauth");
    mkdirSync(unauthDir, { recursive: true });
    const unauthGog = createGogStub(unauthDir, {
      account: "owner@example.com",
      contacts: [c1],
      behavior: { authWriteScope: false },
    });
    expect(
      (
        await runCli({ env, gogBin: unauthGog.binPath }, [
          "apply",
          "--plan",
          delPlanFile,
          "--seal",
          delSeal,
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_GOG_UNAVAILABLE");

    const transientDir = join(dir, "transient");
    mkdirSync(transientDir, { recursive: true });
    const transientGog = createGogStub(transientDir, {
      account: "owner@example.com",
      contacts: [c1],
      behavior: { batchGetExit: 7 },
    });
    expect(
      (
        await runCli({ env, gogBin: transientGog.binPath }, [
          "apply",
          "--plan",
          delPlanFile,
          "--seal",
          delSeal,
        ])
      ).causeCode,
    ).toBe("TRANSIENT_NOT_STARTED");

    const audit = await runCli({ env }, ["audit", "--snapshot", snapFile]);
    const auditFile = join(dir, "audit.json");
    writeFileSync(auditFile, JSON.stringify({ result: audit }), "utf8");
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
    const sealC2 = readSeal(planC2.data);

    const unconfirmedCases: readonly {
      readonly name: string;
      readonly behavior: Readonly<Record<string, unknown>>;
      readonly timeoutMilliseconds?: number;
    }[] = [
      { name: "mismatch", behavior: { updateReturnMismatch: true } },
      { name: "trunc-readback", behavior: { postReadBackTruncate: true } },
      { name: "trunc-update", behavior: { updateTruncate: true } },
      {
        name: "timeout",
        behavior: { hangOnContact: "people/c2" },
        timeoutMilliseconds: 5_000,
      },
    ];
    for (const item of unconfirmedCases) {
      const caseDir = join(dir, item.name);
      mkdirSync(caseDir, { recursive: true });
      const stub = createGogStub(caseDir, {
        account: "owner@example.com",
        contacts: [c2],
        behavior: item.behavior,
      });
      const caseLedger = join(caseDir, "ledger");
      const res = await runCli(
        {
          env: { GOOGLE_CONTACTS_LEDGER_DIR: caseLedger },
          gogBin: stub.binPath,
          ...(item.timeoutMilliseconds !== undefined
            ? { timeoutMilliseconds: item.timeoutMilliseconds }
            : {}),
        },
        ["apply", "--plan", planC2File, "--seal", sealC2],
      );
      expect(res.causeCode).toBe("DOMAIN_CONTACTS_APPLY_UNCONFIRMED");
      expect(res.transactionState).toBe("unknown");
      expect(
        (
          await runCli({ env: { GOOGLE_CONTACTS_LEDGER_DIR: caseLedger } }, [
            "pending",
          ])
        ).data,
      ).toMatchObject({
        unfinished: [{ targets: ["owner@example.com:people/c2"] }],
      });
    }

    const corruptDir = join(dir, "corrupt-ledger");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "format"), "not-json", "utf8");
    expect(
      (
        await runCli({ env: { GOOGLE_CONTACTS_LEDGER_DIR: corruptDir } }, [
          "pending",
        ])
      ).causeCode,
    ).toBe("DOMAIN_CONTACTS_LEDGER_UNREADABLE");
  } finally {
    removeOwnedFolder(dir);
  }
});
