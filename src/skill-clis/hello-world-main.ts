import { runProcess } from "agent-cli-kernel";
import { helloWorldContract } from "./hello-world.ts";

await runProcess(helloWorldContract)(process.argv.slice(2));
