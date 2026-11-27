import { runInProcess } from "agent-cli-kernel";
import type { Envelope } from "agent-cli-kernel";
import { createCvTailorCli } from "../../src/cv-tailor/cli.ts";
import type { CvTailorCliOptions } from "../../src/cv-tailor/cli.ts";

export type CvTailorRunOutput = {
  readonly exitCode: number;
  readonly message: string;
  readonly result: Envelope["result"];
};

export function createCvTailorRunner(
  options?: CvTailorCliOptions,
): (argv: readonly string[]) => Promise<CvTailorRunOutput> {
  const runtime = createCvTailorCli(options);
  const execute = runInProcess(runtime.contract, runtime.setup);
  return async (argv: readonly string[]): Promise<CvTailorRunOutput> => {
    const response = await execute(argv);
    if (response.kind !== "envelope") {
      throw new Error(`Expected envelope response, got ${response.kind}`);
    }
    return {
      exitCode: response.exitCode,
      message: response.envelope.message,
      result: response.envelope.result,
    };
  };
}
