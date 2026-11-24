import { contractFor } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { googleContactsCauses } from "./causes.ts";
import { createApplyCommand } from "./commands-apply.ts";
import { createEvidenceCommand } from "./commands-evidence.ts";
import {
  createAuditCommand,
  createDoctorCommand,
  createSnapshotCommand,
} from "./commands-inspect.ts";
import {
  createPendingCommand,
  createPlanCommand,
} from "./commands-plan-pending.ts";
import { DEFAULT_SHUTDOWN_MS, DEFAULT_TIMEOUT_MS } from "./gog.ts";
import type { PathBoundary } from "./gog.ts";
import { resolveLedgerRoot } from "./ledger.ts";

export type GoogleContactsCliOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly gogBin?: string;
  readonly imsgBin?: string;
  readonly timeoutMilliseconds?: number;
  readonly shutdownMilliseconds?: number;
  readonly nowIso?: () => string;
};

export function createGoogleContactsCli(options?: GoogleContactsCliOptions) {
  const env = options?.env ?? process.env;
  const ledgerResolution = resolveLedgerRoot(env);
  const state = stateAddon({
    root: ledgerResolution.ok ? ledgerResolution.root : ledgerResolution.path,
    report: "google-contacts.pending",
  });
  const timeoutMilliseconds =
    options?.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MS;
  const shutdownMilliseconds =
    options?.shutdownMilliseconds ?? DEFAULT_SHUTDOWN_MS;
  const gogConfig = {
    env,
    gogBinOverride: options?.gogBin,
    timeoutMilliseconds,
    shutdownMilliseconds,
  };
  const imsgConfig = {
    platform: options?.platform ?? process.platform,
    env,
    imsgBinOverride: options?.imsgBin,
    timeoutMilliseconds,
    shutdownMilliseconds,
  };
  const nowIso = options?.nowIso ?? (() => new Date().toISOString());

  let contractBoundary: PathBoundary | null = null;
  const getBoundary = (): PathBoundary => {
    if (contractBoundary === null) {
      throw new Error("Contract boundary accessed before initialization.");
    }
    return contractBoundary;
  };

  const doctor = createDoctorCommand({
    getBoundary,
    ledgerResolution,
    state,
    gogConfig,
    imsgConfig,
    nowIso,
  });
  const snapshot = createSnapshotCommand({
    getBoundary,
    ledgerResolution,
    state,
    gogConfig,
    imsgConfig,
    nowIso,
  });
  const audit = createAuditCommand();
  const evidence = createEvidenceCommand({
    getBoundary,
    gogConfig,
    imsgConfig,
  });
  const plan = createPlanCommand();
  const apply = createApplyCommand({
    getBoundary,
    ledgerResolution,
    state,
    gogConfig,
  });
  const pending = createPendingCommand({
    ledgerResolution,
    state,
  });

  const contract = contractFor({
    cli: "google-contacts",
    commands: [doctor, snapshot, audit, evidence, plan, apply, pending],
    causes: googleContactsCauses,
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
