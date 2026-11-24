import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import { SCHEMA_INVALID_INPUT, TRANSIENT_NOT_STARTED } from "./causes.ts";
import type { GogRuntimeConfig, PathBoundary } from "./gog.ts";
import { batchGetContacts, probeGogReadiness } from "./gog-ops.ts";
import { readJsonFile } from "./inputs.ts";
import type { LedgerResolution } from "./ledger.ts";
import { decodeMutationPlanDoc } from "./plan-decoders/rules.ts";
import { verifyPlanAgainstLive } from "./plan-integrity/rules.ts";
import type { MutationPlanDoc } from "./plan-types/rules.ts";
import {
  validateMutationPlan,
  verifyPlanSealMatch,
} from "./plan-validate/rules.ts";

export type ApplyCommandDeps = {
  readonly getBoundary: () => PathBoundary;
  readonly ledgerResolution: LedgerResolution;
  readonly state: ReturnType<typeof stateAddon>;
  readonly gogConfig: GogRuntimeConfig;
};

export type PreflightFailure =
  | { readonly cause: typeof SCHEMA_INVALID_INPUT; readonly message: string }
  | { readonly cause: "DOMAIN_CONTACTS_PLAN_INVALID"; readonly message: string }
  | {
      readonly cause: "DOMAIN_CONTACTS_SEAL_MISMATCH";
      readonly message: string;
    }
  | {
      readonly cause: "DOMAIN_CONTACTS_APPLY_UNAVAILABLE";
      readonly message: string;
    }
  | {
      readonly cause: "DOMAIN_CONTACTS_GOG_UNAVAILABLE";
      readonly message: string;
    }
  | { readonly cause: typeof TRANSIENT_NOT_STARTED; readonly message: string }
  | {
      readonly cause: "DOMAIN_CONTACTS_REVISION_DRIFT";
      readonly message: string;
    };

export type PreflightOutcome =
  | {
      readonly ok: true;
      readonly plan: MutationPlanDoc;
      readonly executable: ParsedPath;
    }
  | { readonly ok: false; readonly failure: PreflightFailure };

function validateOfflinePlanFile(
  planPath: string,
  seal: string,
  ledgerResolution: LedgerResolution,
):
  | { readonly ok: true; readonly plan: MutationPlanDoc }
  | { readonly ok: false; readonly failure: PreflightFailure } {
  const raw = readJsonFile(planPath);
  if (!raw.ok) {
    return {
      ok: false,
      failure: { cause: SCHEMA_INVALID_INPUT, message: raw.reason },
    };
  }
  const plan = decodeMutationPlanDoc(raw.value);
  if (plan === null) {
    return {
      ok: false,
      failure: {
        cause: SCHEMA_INVALID_INPUT,
        message: "File does not contain a valid contacts-plan/1 payload.",
      },
    };
  }
  const planErr = validateMutationPlan(plan);
  if (planErr !== null) {
    return {
      ok: false,
      failure: { cause: "DOMAIN_CONTACTS_PLAN_INVALID", message: planErr },
    };
  }
  if (!verifyPlanSealMatch(plan, seal)) {
    return {
      ok: false,
      failure: {
        cause: "DOMAIN_CONTACTS_SEAL_MISMATCH",
        message: "Provided --seal does not match canonical SHA-256 Plan seal.",
      },
    };
  }
  if (!ledgerResolution.ok) {
    return {
      ok: false,
      failure: {
        cause: "DOMAIN_CONTACTS_APPLY_UNAVAILABLE",
        message: ledgerResolution.detail,
      },
    };
  }
  return { ok: true, plan };
}

export async function runApplyPreflight(params: {
  readonly planPath: string;
  readonly seal: string;
  readonly client: string | undefined;
  readonly programs: ProgramsCapability;
  readonly aborted: () => boolean;
  readonly deps: ApplyCommandDeps;
}): Promise<PreflightOutcome> {
  const offline = validateOfflinePlanFile(
    params.planPath,
    params.seal,
    params.deps.ledgerResolution,
  );
  if (!offline.ok) return offline;
  const { plan } = offline;
  const probe = await probeGogReadiness({
    programs: params.programs,
    boundary: params.deps.getBoundary(),
    config: params.deps.gogConfig,
    account: plan.account,
    client: params.client,
    aborted: params.aborted,
  });
  if (probe.transient) {
    return {
      ok: false,
      failure: { cause: TRANSIENT_NOT_STARTED, message: probe.detail },
    };
  }
  if (
    probe.parsedPath === null ||
    !probe.versionOk ||
    !probe.schemaOk ||
    !probe.authOk
  ) {
    return {
      ok: false,
      failure: {
        cause: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
        message: probe.detail,
      },
    };
  }
  const live = await batchGetContacts({
    programs: params.programs,
    executable: probe.parsedPath,
    account: plan.account,
    client: params.client,
    resourceNames: plan.targets.map((target) => target.resourceName),
    config: params.deps.gogConfig,
    aborted: params.aborted,
  });
  if (live.kind === "transient" || live.kind === "unconfirmed") {
    return {
      ok: false,
      failure: { cause: TRANSIENT_NOT_STARTED, message: live.detail },
    };
  }
  if (live.kind === "unavailable") {
    return {
      ok: false,
      failure: {
        cause: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
        message: live.detail,
      },
    };
  }
  for (const target of plan.targets) {
    const current = live.found.get(target.resourceName);
    if (current === undefined || current.etag !== target.expectedRevision) {
      return {
        ok: false,
        failure: {
          cause: "DOMAIN_CONTACTS_REVISION_DRIFT",
          message: `Contact ${target.resourceName} revision drifted or disappeared since snapshot.`,
        },
      };
    }
  }
  const liveErr = verifyPlanAgainstLive(plan, live.found);
  if (liveErr !== null) {
    return {
      ok: false,
      failure: { cause: "DOMAIN_CONTACTS_PLAN_INVALID", message: liveErr },
    };
  }
  return { ok: true, plan, executable: probe.parsedPath };
}
