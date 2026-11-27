import { runProcess } from "agent-cli-kernel";
import { createGoogleContactsCli } from "./cli.ts";

const runtime = createGoogleContactsCli();
await runProcess(runtime.contract, runtime.setup)(process.argv.slice(2));
