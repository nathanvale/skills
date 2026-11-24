import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { createGoogleContactsCli } from "../src/google-contacts/cli.ts";
import type { GoogleContactsCliOptions } from "../src/google-contacts/cli.ts";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";
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

test("duplicate-merge updates Survivor before deleting Duplicate and aborts before delete on duplicate drift", async () => {
  const dir = testFolder("gc-merge-e2e-");
  try {
    const ledgerDir = join(dir, "ledger");
    const survivor = sampleContact("surv", {
      names: [{ givenName: "Jordan", familyName: "Ng" }],
      phoneNumbers: [{ value: "+61491570401", type: "mobile" }],
      emailAddresses: [{ value: "jordan@acme.example.com", type: "work" }],
      biographies: [{ value: "Original bio" }],
    });
    const dup = sampleContact("dup", {
      names: [{ givenName: "Jordan", familyName: "Ng" }],
      phoneNumbers: [
        { value: "+61491570401", type: "mobile" },
        { value: "+61491570402", type: "work" },
      ],
      emailAddresses: [{ value: "jordan@acme.example.com", type: "work" }],
      biographies: [],
    });
    const snapFile = join(dir, "snap.json");
    writeFileSync(
      snapFile,
      JSON.stringify(sampleSnapshot([survivor, dup])),
      "utf8",
    );
    const propFile = join(dir, "proposals.json");
    writeFileSync(
      propFile,
      JSON.stringify({
        schemaVersion: "contacts-proposals/1",
        account: "owner@example.com",
        proposals: [
          {
            kind: "duplicate-merge",
            target: "people/surv",
            duplicates: ["people/dup"],
          },
        ],
      }),
      "utf8",
    );
    const planRes = await runCli(
      { env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir } },
      [
        "plan",
        "--snapshot",
        snapFile,
        "--lane",
        "duplicate-merge",
        "--proposals",
        propFile,
      ],
    );
    expect(planRes.causeCode).toBe("SUCCESS_UNCHANGED");
    const planFile = join(dir, "merge-plan.json");
    writeFileSync(planFile, JSON.stringify({ result: planRes }), "utf8");
    const seal =
      typeof planRes.data === "object" && planRes.data !== null
        ? String(Reflect.get(planRes.data, "seal"))
        : "";

    const driftDir = join(dir, "drift-case");
    mkdirSync(driftDir, { recursive: true });
    const driftGog = createGogStub(driftDir, {
      account: "owner@example.com",
      contacts: [survivor, dup],
      behavior: { driftDupBeforeDelete: "people/dup" },
    });
    const drifted = await runCli(
      {
        env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir },
        gogBin: driftGog.binPath,
      },
      ["apply", "--plan", planFile, "--seal", seal],
    );
    expect(drifted.causeCode).toBe("DOMAIN_CONTACTS_APPLY_REJECTED");
    expect(drifted.transactionState).toBe("completed");
    expect(driftGog.readLog().some((row) => row.args.includes("delete"))).toBe(
      false,
    );

    const okDir = join(dir, "ok-case");
    mkdirSync(okDir, { recursive: true });
    const okGog = createGogStub(okDir, {
      account: "owner@example.com",
      contacts: [survivor, dup],
    });
    const merged = await runCli(
      {
        env: { GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir },
        gogBin: okGog.binPath,
      },
      ["apply", "--plan", planFile, "--seal", seal],
    );
    expect(merged.causeCode).toBe("SUCCESS_COMPLETED");
    const cmds = okGog.readLog().map((row) => row.args.slice(0, 3).join(" "));
    const updateIdx = cmds.indexOf("contacts batch update");
    const deleteIdx = cmds.indexOf("contacts batch delete");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(updateIdx);
    expect(okGog.readState().contacts.map((c) => c.resourceName)).toEqual([
      "people/surv",
    ]);
  } finally {
    removeOwnedFolder(dir);
  }
});

test("bundled dist/cli.mjs executes end-to-end in a sterile working directory", () => {
  const dir = testFolder("gc-bundle-e2e-");
  try {
    const cliBundle = join(
      repositoryRoot(),
      "skills",
      "in-progress",
      "google-contacts",
      "dist",
      "cli.mjs",
    );
    const ledgerDir = join(
      dir,
      "xdg",
      "nathanvale-skills",
      "google-contacts",
      "ledger",
    );
    const env = {
      PATH: dirname(process.execPath),
      XDG_STATE_HOME: join(dir, "xdg"),
      HOME: join(dir, "home"),
    };
    const pending = Bun.spawnSync(
      [process.execPath, cliBundle, "pending", "--json"],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    expect({
      exitCode: pending.exitCode,
      stderr: pending.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    const parsed: unknown = JSON.parse(pending.stdout.toString());
    expect(parsed).toMatchObject({
      result: {
        commandIdentity: "google-contacts.pending",
        causeCode: "SUCCESS_UNCHANGED",
        data: { ledgerRoot: ledgerDir, unfinished: [] },
      },
    });
    expect(existsSync(ledgerDir)).toBe(false);
  } finally {
    removeOwnedFolder(dir);
  }
});
