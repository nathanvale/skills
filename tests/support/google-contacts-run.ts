import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { createGoogleContactsCli } from "../../src/google-contacts/cli.ts";
import type { GoogleContactsCliOptions } from "../../src/google-contacts/cli.ts";
import type { ContactRecord } from "../../src/google-contacts/domain/rules.ts";
import { sampleSnapshot } from "./google-contacts-stubs.ts";

export type CliRun = {
  readonly causeCode: string;
  readonly data: unknown;
  readonly message: string;
};

export async function runContactsCli(
  options: GoogleContactsCliOptions,
  argv: readonly string[],
): Promise<CliRun> {
  const cli = createGoogleContactsCli(options);
  const ran = await runInProcess(cli.contract, cli.setup)(argv);
  if (ran.kind !== "envelope") {
    throw new Error(`Expected envelope, got ${ran.kind}.`);
  }
  return {
    causeCode: String(ran.envelope.result.causeCode),
    data: ran.envelope.result.data,
    message: ran.envelope.message,
  };
}

function sealOf(data: unknown): string {
  return typeof data === "object" && data !== null
    ? String(Reflect.get(data, "seal"))
    : "";
}

export async function planFromContacts(params: {
  readonly dir: string;
  readonly contacts: readonly ContactRecord[];
  readonly lane: string;
  readonly proposals: readonly unknown[];
  readonly extraArgs?: readonly string[];
}): Promise<{
  readonly run: CliRun;
  readonly planFile: string;
  readonly seal: string;
}> {
  const snapFile = join(params.dir, "snap.json");
  writeFileSync(
    snapFile,
    JSON.stringify(sampleSnapshot(params.contacts)),
    "utf8",
  );
  const propFile = join(params.dir, "props.json");
  writeFileSync(
    propFile,
    JSON.stringify({
      schemaVersion: "contacts-proposals/1",
      account: "owner@example.com",
      proposals: params.proposals,
    }),
    "utf8",
  );
  const run = await runContactsCli({ env: {} }, [
    "plan",
    "--snapshot",
    snapFile,
    "--lane",
    params.lane,
    "--proposals",
    propFile,
    "--min-confidence",
    "low",
    ...(params.extraArgs ?? []),
  ]);
  const planFile = join(params.dir, "plan.json");
  writeFileSync(planFile, JSON.stringify({ result: run }), "utf8");
  return { run, planFile, seal: sealOf(run.data) };
}
