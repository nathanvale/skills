import type {
  ParsedPath,
  ProgramsCapability,
  RecordedEffect,
} from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import type { ContactRecord } from "./domain/rules.ts";
import { buildGogBaseArgs, OUTPUT_LIMIT_MEDIUM, runGogDomain } from "./gog.ts";
import type { GogRuntimeConfig } from "./gog.ts";
import { batchGetContacts } from "./gog-ops.ts";
import { serializeSubBatchWireMap } from "./plan-subbatch/rules.ts";
import type {
  MutationPlanDoc,
  PlannedContactUpdate,
  PlannedDeleteTarget,
} from "./plan-types/rules.ts";
import {
  flattenSubBatchUpdates,
  verifyPlannedUpdateLanded,
} from "./plan-validate/rules.ts";

export type ExecutionTracker = {
  readonly sentUpdates: Set<string>;
  readonly sentDeletes: Set<string>;
  cleanFailureDetail: string | null;
  hardUnconfirmedReason: string | null;
  finalDisposition: "succeeded" | "rejected" | "unconfirmed";
  summaryLine: string;
};

type ExecParams = {
  readonly plan: MutationPlanDoc;
  readonly client?: string | undefined;
  readonly executable: ParsedPath;
  readonly programs: ProgramsCapability;
  readonly recorded: RecordedEffect<"contacts.mutate">;
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
  readonly tracker: ExecutionTracker;
};

function verifyMergePreDelete(
  plan: MutationPlanDoc,
  found: ReadonlyMap<string, ContactRecord>,
  tracker: ExecutionTracker,
): boolean {
  const updateMap = new Map<string, PlannedContactUpdate>();
  for (const update of flattenSubBatchUpdates(plan.updateSubBatches)) {
    updateMap.set(update.resourceName, update);
  }
  for (const cluster of plan.mergeClusters) {
    const survUpdate = updateMap.get(cluster.survivor);
    const liveSurv = found.get(cluster.survivor);
    if (
      survUpdate === undefined ||
      liveSurv === undefined ||
      !verifyPlannedUpdateLanded(liveSurv, survUpdate)
    ) {
      tracker.hardUnconfirmedReason = `Survivor ${cluster.survivor} did not confirm all merged fields before duplicate deletion.`;
      return false;
    }
    const driftedDup = cluster.duplicates.find((dup) => {
      const liveDup = found.get(dup.resourceName);
      return liveDup === undefined || liveDup.etag !== dup.expectedRevision;
    });
    if (driftedDup !== undefined) {
      tracker.cleanFailureDetail = `Duplicate ${driftedDup.resourceName} revision drifted before delete; aborted before batch delete.`;
      return false;
    }
  }
  return true;
}

function verifyStandalonePreDelete(
  plan: MutationPlanDoc,
  found: ReadonlyMap<string, ContactRecord>,
  tracker: ExecutionTracker,
): boolean {
  for (const delBatch of plan.deleteBatches) {
    const drifted = delBatch.targets.find((target) => {
      const liveTarget = found.get(target.resourceName);
      return (
        liveTarget === undefined || liveTarget.etag !== target.expectedRevision
      );
    });
    if (drifted !== undefined) {
      tracker.cleanFailureDetail = `Delete target ${drifted.resourceName} revision drifted before delete; aborted before batch delete.`;
      return false;
    }
  }
  return true;
}

async function verifyPreDeleteBarrier(params: ExecParams): Promise<boolean> {
  const live = await batchGetContacts({
    programs: params.programs,
    executable: params.executable,
    account: params.plan.account,
    client: params.client,
    resourceNames: params.plan.targets.map((target) => target.resourceName),
    config: params.config,
    aborted: params.aborted,
  });
  if (live.kind !== "ok") {
    params.tracker.hardUnconfirmedReason = `Pre-delete read-back failed: ${live.detail}`;
    return false;
  }
  return params.plan.lane === "duplicate-merge"
    ? verifyMergePreDelete(params.plan, live.found, params.tracker)
    : verifyStandalonePreDelete(params.plan, live.found, params.tracker);
}

async function runUpdateSubBatches(params: ExecParams): Promise<boolean> {
  const { plan, tracker } = params;
  for (const batch of plan.updateSubBatches) {
    const { json } = serializeSubBatchWireMap(batch.updates);
    for (const update of batch.updates) {
      tracker.sentUpdates.add(update.resourceName);
    }
    const res = await runGogDomain(
      params.programs,
      params.recorded,
      params.executable,
      [
        "contacts",
        "batch",
        "update",
        "--from-file",
        "-",
        ...buildGogBaseArgs({
          enableCommand: "contacts.batch.update",
          account: plan.account,
          client: params.client,
        }),
      ],
      OUTPUT_LIMIT_MEDIUM,
      params.config,
      params.aborted,
      new TextEncoder().encode(json),
    );
    if (
      res.kind === "unconfirmed" ||
      programDetails(res.raw)?.stdoutTruncated === true
    ) {
      tracker.hardUnconfirmedReason =
        res.kind === "unconfirmed"
          ? res.detail
          : `Update sub-batch ${String(batch.index)} stdout was truncated.`;
      return false;
    }
    if (res.kind !== "ok") {
      tracker.cleanFailureDetail =
        res.kind === "empty"
          ? `Update sub-batch ${String(batch.index)} returned unexpected empty exit 3.`
          : `Update sub-batch ${String(batch.index)} failed: ${res.detail}`;
      return false;
    }
  }
  return true;
}

async function runDeleteBatches(params: ExecParams): Promise<void> {
  const { plan, tracker } = params;
  for (const delBatch of plan.deleteBatches) {
    const rns = delBatch.targets.map((target) => target.resourceName);
    for (const rn of rns) tracker.sentDeletes.add(rn);
    const res = await runGogDomain(
      params.programs,
      params.recorded,
      params.executable,
      [
        "contacts",
        "batch",
        "delete",
        ...rns,
        "--force",
        ...buildGogBaseArgs({
          enableCommand: "contacts.batch.delete",
          account: plan.account,
          client: params.client,
        }),
      ],
      OUTPUT_LIMIT_MEDIUM,
      params.config,
      params.aborted,
    );
    if (
      res.kind === "unconfirmed" ||
      programDetails(res.raw)?.stdoutTruncated === true
    ) {
      tracker.hardUnconfirmedReason =
        res.kind === "unconfirmed"
          ? res.detail
          : `Delete batch ${String(delBatch.index)} stdout was truncated.`;
      return;
    }
    if (res.kind !== "ok") {
      tracker.cleanFailureDetail =
        res.kind === "empty"
          ? `Delete batch ${String(delBatch.index)} returned unexpected empty exit 3.`
          : `Delete batch ${String(delBatch.index)} failed: ${res.detail}`;
      return;
    }
  }
}

export async function executeUpdatesAndDeletes(
  params: ExecParams,
): Promise<void> {
  const updatesOk = await runUpdateSubBatches(params);
  if (!updatesOk || params.plan.deleteBatches.length === 0) return;
  const okToDelete = await verifyPreDeleteBarrier(params);
  if (!okToDelete) return;
  await runDeleteBatches(params);
}

function classifyCleanSuccess(
  plan: MutationPlanDoc,
  allUpdates: readonly PlannedContactUpdate[],
  allDeletes: readonly PlannedDeleteTarget[],
  found: ReadonlyMap<string, ContactRecord>,
  tracker: ExecutionTracker,
): boolean {
  for (const update of allUpdates) {
    const live = found.get(update.resourceName);
    if (live === undefined || !verifyPlannedUpdateLanded(live, update)) {
      tracker.finalDisposition = "unconfirmed";
      tracker.summaryLine = `Update for ${update.resourceName} was not confirmed on read-back.`;
      return false;
    }
  }
  for (const del of allDeletes) {
    if (found.has(del.resourceName)) {
      tracker.finalDisposition = "unconfirmed";
      tracker.summaryLine = `Deleted contact ${del.resourceName} still present on read-back.`;
      return false;
    }
  }
  tracker.finalDisposition = "succeeded";
  tracker.summaryLine = `Applied ${plan.lane} plan to ${String(plan.targetCount)} contact(s).`;
  return true;
}

type RejectionBuckets = {
  readonly landed: string[];
  readonly untouched: string[];
  readonly driftedExternally: string[];
};

function observeUpdateTarget(
  update: PlannedContactUpdate,
  sent: boolean,
  live: ContactRecord | undefined,
  buckets: RejectionBuckets,
): boolean {
  if (!sent) {
    if (live === undefined || live.etag !== update.expectedRevision) {
      buckets.driftedExternally.push(update.resourceName);
    } else {
      buckets.untouched.push(update.resourceName);
    }
    return true;
  }
  if (live === undefined) return false;
  if (live.etag === update.expectedRevision) {
    buckets.untouched.push(update.resourceName);
    return true;
  }
  if (verifyPlannedUpdateLanded(live, update)) {
    buckets.landed.push(update.resourceName);
    return true;
  }
  return false;
}

function observeDeleteTarget(
  del: PlannedDeleteTarget,
  sent: boolean,
  live: ContactRecord | undefined,
  buckets: RejectionBuckets,
): boolean {
  if (!sent) {
    if (live === undefined || live.etag !== del.expectedRevision) {
      buckets.driftedExternally.push(del.resourceName);
    } else {
      buckets.untouched.push(del.resourceName);
    }
    return true;
  }
  if (live === undefined) {
    buckets.landed.push(del.resourceName);
    return true;
  }
  if (live.etag === del.expectedRevision) {
    buckets.untouched.push(del.resourceName);
    return true;
  }
  return false;
}

export function classifyReadBack(
  plan: MutationPlanDoc,
  found: ReadonlyMap<string, ContactRecord>,
  tracker: ExecutionTracker,
): boolean {
  const allUpdates = flattenSubBatchUpdates(plan.updateSubBatches);
  const allDeletes = plan.deleteBatches.flatMap((batch) => batch.targets);
  if (tracker.cleanFailureDetail === null) {
    return classifyCleanSuccess(plan, allUpdates, allDeletes, found, tracker);
  }
  const buckets: RejectionBuckets = {
    landed: [],
    untouched: [],
    driftedExternally: [],
  };
  for (const update of allUpdates) {
    const ok = observeUpdateTarget(
      update,
      tracker.sentUpdates.has(update.resourceName),
      found.get(update.resourceName),
      buckets,
    );
    if (!ok) {
      tracker.finalDisposition = "unconfirmed";
      return false;
    }
  }
  for (const del of allDeletes) {
    const ok = observeDeleteTarget(
      del,
      tracker.sentDeletes.has(del.resourceName),
      found.get(del.resourceName),
      buckets,
    );
    if (!ok) {
      tracker.finalDisposition = "unconfirmed";
      return false;
    }
  }
  tracker.finalDisposition = "rejected";
  tracker.summaryLine = `${tracker.cleanFailureDetail} Confirmed read-back: landed=[${buckets.landed.join(",")}], untouched=[${buckets.untouched.join(",")}], externalDrift=[${buckets.driftedExternally.join(",")}].`;
  return true;
}
