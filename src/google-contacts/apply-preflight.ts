import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import { SCHEMA_INVALID_INPUT, TRANSIENT_NOT_STARTED } from "./causes.ts";
import { compareCodeUnit } from "./domain/rules.ts";
import type { ContactRecord } from "./domain/rules.ts";
import type { GogRuntimeConfig, PathBoundary } from "./gog.ts";
import {
  batchGetContacts,
  probeGogReadiness,
  readProtectedContacts,
} from "./gog-ops.ts";
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

async function withProtectedDuplicateFields(params: {
  readonly plan: MutationPlanDoc;
  readonly live: ReadonlyMap<string, ContactRecord>;
  readonly read: (
    resourceNames: readonly string[],
  ) => ReturnType<typeof readProtectedContacts>;
}): Promise<
  | { readonly ok: true; readonly live: ReadonlyMap<string, ContactRecord> }
  | { readonly ok: false; readonly failure: PreflightFailure }
> {
  const duplicates = params.plan.mergeClusters.flatMap((cluster) =>
    cluster.duplicates.map((dup) => dup.resourceName),
  );
  if (duplicates.length === 0) return { ok: true, live: params.live };
  const read = await params.read(duplicates);
  if (read.kind !== "ok") {
    return {
      ok: false,
      failure: {
        cause:
          read.kind === "transient"
            ? TRANSIENT_NOT_STARTED
            : "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
        message: read.detail,
      },
    };
  }
  const live = new Map(params.live);
  for (const resourceName of duplicates) {
    const current = live.get(resourceName);
    const shown = read.records.get(resourceName);
    if (current === undefined || shown?.etag !== current.etag) {
      return {
        ok: false,
        failure: {
          cause: "DOMAIN_CONTACTS_REVISION_DRIFT",
          message: `Contact ${resourceName} revision drifted between its batch read and its protected-field read.`,
        },
      };
    }
    const fields = new Set([
      ...current.nonAllowlistedFields,
      ...shown.nonAllowlistedFields,
    ]);
    live.set(resourceName, {
      ...current,
      nonAllowlistedFields: [...fields].sort(compareCodeUnit),
    });
  }
  return { ok: true, live };
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
  const executable = probe.parsedPath;
  const live = await batchGetContacts({
    programs: params.programs,
    executable,
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
  const protectedLive = await withProtectedDuplicateFields({
    plan,
    live: live.found,
    read: (resourceNames) =>
      readProtectedContacts({
        programs: params.programs,
        executable,
        account: plan.account,
        client: params.client,
        config: params.deps.gogConfig,
        aborted: params.aborted,
        resourceNames,
      }),
  });
  if (!protectedLive.ok) return protectedLive;
  const liveErr = verifyPlanAgainstLive(plan, protectedLive.live);
  if (liveErr !== null) {
    return {
      ok: false,
      failure: { cause: "DOMAIN_CONTACTS_PLAN_INVALID", message: liveErr },
    };
  }
  return { ok: true, plan, executable };
}
