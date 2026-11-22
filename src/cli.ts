import { commands, skillCauses } from "./commands.ts";
import { contractFor, runProcess } from "agent-cli-kernel";

const contract = contractFor({
  cli: "skills",
  causes: skillCauses,
  commands,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
