import { runProcess } from "agent-cli-kernel";
import { createCvTailorCli } from "./cli.ts";

const runtime = createCvTailorCli();
await runProcess(runtime.contract, runtime.setup)(process.argv.slice(2));
