import { contractFor } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { cvTailorCauses } from "./causes.ts";
import { createCvBuildCommand } from "./cv/build.ts";
import { createCvCheckCommand } from "./cv/check.ts";
import { createCvTextCommand } from "./cv/text.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createPendingCommand } from "./pending.ts";
import { createPileMakeCommand } from "./pile/make.ts";
import { createSearchRunCommand } from "./search/run.ts";
import { resolveStateDir } from "./settings.ts";
import type { PathBoundary } from "./settings.ts";
import { createSettingsShowCommand } from "./settings-show.ts";
import { createTermReportCommand } from "./term/report.ts";

export type CvTailorCliOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly sofficeTimeoutMilliseconds?: number;
};

export function createCvTailorCli(options?: CvTailorCliOptions) {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const stateResolution = resolveStateDir(env);
  const state = stateAddon({
    root: stateResolution.ok ? stateResolution.root : stateResolution.path,
    report: "cv-tailor.pending",
  });

  let contractBoundary: PathBoundary | null = null;
  const getBoundary = (): PathBoundary => {
    if (contractBoundary === null) {
      throw new Error("Contract boundary accessed before initialization.");
    }
    return contractBoundary;
  };

  const doctor = createDoctorCommand({ env, getBoundary, cwd });
  const settingsShow = createSettingsShowCommand({ env, cwd });
  const cvText = createCvTextCommand({ env, getBoundary, cwd });
  const termReport = createTermReportCommand({ env, getBoundary, cwd });
  const searchRun = createSearchRunCommand({ env, getBoundary, cwd });
  const cvCheck = createCvCheckCommand({ env, getBoundary, cwd });
  const cvBuild = createCvBuildCommand({
    env,
    getBoundary,
    stateResolution,
    state,
    cwd,
    sofficeTimeoutMilliseconds: options?.sofficeTimeoutMilliseconds,
  });
  const pileMake = createPileMakeCommand({
    env,
    stateResolution,
    state,
    cwd,
  });
  const pending = createPendingCommand({ stateResolution, state });

  const contract = contractFor({
    cli: "cv-tailor",
    commands: [
      doctor,
      settingsShow,
      cvText,
      termReport,
      searchRun,
      cvCheck,
      cvBuild,
      pileMake,
      pending,
    ],
    causes: cvTailorCauses,
    state: state.descriptor,
    installedAddons: ["state", "programs"],
  });
  contractBoundary = contract.boundary;

  return {
    contract,
    setup: {
      addons: { programs: programsAddon() },
      emergencyRecord: state.emergencyRecord,
    },
  };
}
