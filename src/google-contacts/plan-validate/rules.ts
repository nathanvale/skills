import { countIndependentSerializedAnchors } from "../anchors/rules.ts";
import {
  canonicalJson,
  compareCodeUnit,
  isContactOwnedMetadata,
  ownValue,
  parseContactRevision,
  parseEmailAddress,
  parseResourceName,
} from "../domain/rules.ts";
import type { ContactRecord } from "../domain/rules.ts";
import { MERGE_ALLOWLIST_FIELDS } from "../merge/rules.ts";
import { writableSubfieldKeys } from "../person-fields/rules.ts";
import { validatePlanMembership } from "../plan-integrity/rules.ts";
import type { ContactListField } from "../person-fields/rules.ts";
import {
  fieldMaskOf,
  HARD_MAX_CONTACTS,
  MAX_STDIN_PAYLOAD_BYTES,
  serializeSubBatchWireMap,
} from "../plan-subbatch/rules.ts";
import { computePlanSeal } from "../plan-types/rules.ts";
import type {
  MutationPlanDoc,
  PlannedContactUpdate,
  PlannedDeleteTarget,
  PlannedMergeCluster,
  UpdateSubBatch,
} from "../plan-types/rules.ts";
import {
  containsUntrustedSentinel,
  detectWebQueryLeak,
} from "../web-firewall/rules.ts";

const METADATA_FIELDS = new Set([
  "names",
  "organizations",
  "addresses",
  "urls",
  "emailAddresses",
  "birthdays",
  "events",
  "relations",
]);

function checkAllowedMaskForLane(
  lane: MutationPlanDoc["lane"],
  mask: readonly string[],
): string | null {
  if (mask.length === 0) return "Update sub-batch has an empty fieldMask.";
  if (lane === "phone-normalize") {
    return mask.length === 1 && mask[0] === "phoneNumbers"
      ? null
      : "phone-normalize sub-batch may only touch phoneNumbers.";
  }
  if (lane === "note-append") {
    return mask.length === 1 && mask[0] === "biographies"
      ? null
      : "note-append sub-batch may only touch biographies.";
  }
  if (lane === "contact-delete") {
    return "contact-delete cannot include update sub-batches.";
  }
  const allowed =
    lane === "metadata-enrich" ? METADATA_FIELDS : MERGE_ALLOWLIST_FIELDS;
  const disallowed = mask.find((key) => !allowed.has(key));
  return disallowed === undefined
    ? null
    : `${lane} sub-batch cannot touch field ${disallowed}.`;
}

function hasForeignSourceEntries(update: PlannedContactUpdate): boolean {
  const fields = update.fields;
  const arrays = [
    fields.names,
    fields.phoneNumbers,
    fields.emailAddresses,
    fields.addresses,
    fields.organizations,
    fields.biographies,
    fields.urls,
    fields.birthdays,
    fields.events,
    fields.relations,
  ];
  for (const list of arrays) {
    if (
      list !== undefined &&
      list.some((item) => !isContactOwnedMetadata(item.metadata))
    ) {
      return true;
    }
  }
  return false;
}

function validateBiographyLaneUpdate(
  lane: "note-append" | "duplicate-merge",
  update: PlannedContactUpdate,
): string | null {
  const bio = update.fields.biographies?.[0]?.value ?? "";
  const existing = update.existingBiography ?? "";
  if (!bio.startsWith(existing)) {
    return `${lane} update for ${update.resourceName} overwrites existing biography prefix.`;
  }
  if (lane === "note-append" && containsUntrustedSentinel(bio)) {
    return `note-append update for ${update.resourceName} contains untrusted sentinel markers.`;
  }
  if (
    lane === "duplicate-merge" &&
    update.appendedLine !== null &&
    !bio.includes(update.appendedLine)
  ) {
    return `duplicate-merge update for ${update.resourceName} omits merge provenance line.`;
  }
  return null;
}

function validateLaneUpdateFields(
  lane: MutationPlanDoc["lane"],
  update: PlannedContactUpdate,
): string | null {
  if (lane === "note-append" || lane === "duplicate-merge") {
    return validateBiographyLaneUpdate(lane, update);
  }
  return null;
}

function validateSingleUpdate(
  lane: MutationPlanDoc["lane"],
  update: PlannedContactUpdate,
  expectedMask: readonly string[],
): string | null {
  if (parseResourceName(update.resourceName) === null) {
    return `Invalid update resourceName: ${update.resourceName}.`;
  }
  if (parseContactRevision(update.expectedRevision) === null) {
    return `Invalid expectedRevision for ${update.resourceName}.`;
  }
  if (
    update.contactSource.type !== "CONTACT" ||
    update.contactSource.etag !== update.expectedRevision
  ) {
    return `Update for ${update.resourceName} must carry CONTACT source with matching etag.`;
  }
  if (hasForeignSourceEntries(update)) {
    return `Update for ${update.resourceName} contains non-CONTACT source entries.`;
  }
  if (fieldMaskOf(update.fields).join(",") !== expectedMask.join(",")) {
    return `Update for ${update.resourceName} field mask disagrees with sub-batch fieldMask.`;
  }
  return validateLaneUpdateFields(lane, update);
}

function validateOneSubBatch(
  lane: MutationPlanDoc["lane"],
  batch: UpdateSubBatch,
  seenUpdateTargets: Map<string, string>,
): string | null {
  const sortedMask = [...batch.fieldMask].sort(compareCodeUnit);
  if (sortedMask.join(",") !== batch.fieldMask.join(",")) {
    return `Sub-batch ${String(batch.index)} fieldMask is not sorted.`;
  }
  const maskErr = checkAllowedMaskForLane(lane, batch.fieldMask);
  if (maskErr !== null) return maskErr;
  if (batch.updates.length === 0) {
    return `Sub-batch ${String(batch.index)} contains zero updates.`;
  }
  for (const update of batch.updates) {
    if (seenUpdateTargets.has(update.resourceName)) {
      return `Contact ${update.resourceName} appears in multiple update sub-batches.`;
    }
    seenUpdateTargets.set(update.resourceName, update.expectedRevision);
    const err = validateSingleUpdate(lane, update, batch.fieldMask);
    if (err !== null) return err;
  }
  if (
    serializeSubBatchWireMap(batch.updates).bytes >= MAX_STDIN_PAYLOAD_BYTES
  ) {
    return `Sub-batch ${String(batch.index)} exceeds ${String(MAX_STDIN_PAYLOAD_BYTES)} UTF-8 bytes.`;
  }
  return null;
}

function validateClusterCorroboration(
  cluster: PlannedMergeCluster,
): string | null {
  if (cluster.corroboration.kind === "anchors") {
    return countIndependentSerializedAnchors(cluster.corroboration.anchors) < 2
      ? `Merge cluster for ${cluster.survivor} has fewer than 2 independent anchors.`
      : null;
  }
  return cluster.corroboration.note.trim().length === 0
    ? `Merge cluster for ${cluster.survivor} has empty human confirmation note.`
    : null;
}

function validateOneMergeCluster(
  cluster: PlannedMergeCluster,
  seenAll: Set<string>,
  seenUpdateTargets: ReadonlyMap<string, string>,
  deleteTargetSet: ReadonlyMap<string, string>,
): string | null {
  if (seenAll.has(cluster.survivor)) {
    return `Merge cluster cycle or duplicate survivor: ${cluster.survivor}.`;
  }
  seenAll.add(cluster.survivor);
  if (!seenUpdateTargets.has(cluster.survivor)) {
    return `Survivor ${cluster.survivor} is missing from updateSubBatches.`;
  }
  if (cluster.hasConflictingNames || cluster.duplicates.length === 0) {
    return `Merge cluster for ${cluster.survivor} has conflicting names or zero duplicates.`;
  }
  const corrErr = validateClusterCorroboration(cluster);
  if (corrErr !== null) return corrErr;
  for (const dup of cluster.duplicates) {
    if (seenAll.has(dup.resourceName)) {
      return `Self-merge or cycle on ${dup.resourceName}.`;
    }
    seenAll.add(dup.resourceName);
    if (dup.nonAllowlistedFields.length > 0) {
      return `Duplicate ${dup.resourceName} carries non-allowlisted fields: ${dup.nonAllowlistedFields.join(", ")}.`;
    }
    if (!deleteTargetSet.has(dup.resourceName)) {
      return `Duplicate ${dup.resourceName} is missing from deleteBatches.`;
    }
  }
  return null;
}

function validateMergeClusters(
  plan: MutationPlanDoc,
  seenUpdateTargets: ReadonlyMap<string, string>,
  deleteTargetSet: ReadonlyMap<string, string>,
): string | null {
  if (plan.lane !== "duplicate-merge") {
    return plan.mergeClusters.length === 0
      ? null
      : `Lane ${plan.lane} cannot carry mergeClusters.`;
  }
  if (plan.mergeClusters.length === 0) {
    return "duplicate-merge plan must carry at least one Merge cluster.";
  }
  const seenAll = new Set<string>();
  for (const cluster of plan.mergeClusters) {
    const err = validateOneMergeCluster(
      cluster,
      seenAll,
      seenUpdateTargets,
      deleteTargetSet,
    );
    if (err !== null) return err;
  }
  return null;
}

function validateDeleteTarget(
  lane: MutationPlanDoc["lane"],
  target: PlannedDeleteTarget,
  deleteTargetSet: Map<string, string>,
): string | null {
  if (parseResourceName(target.resourceName) === null) {
    return `Invalid delete resourceName: ${target.resourceName}.`;
  }
  if (parseContactRevision(target.expectedRevision) === null) {
    return `Invalid delete expectedRevision for ${target.resourceName}.`;
  }
  if (deleteTargetSet.has(target.resourceName)) {
    return `Duplicate delete target ${target.resourceName}.`;
  }
  deleteTargetSet.set(target.resourceName, target.expectedRevision);
  if (
    lane === "contact-delete" &&
    (!target.confirmedByHuman || target.reason.trim().length === 0)
  ) {
    return `contact-delete target ${target.resourceName} requires confirmedByHuman and non-empty reason.`;
  }
  return null;
}

function validateDeleteBatches(
  plan: MutationPlanDoc,
  deleteTargetSet: Map<string, string>,
): string | null {
  const allowsDeletes =
    plan.lane === "contact-delete" || plan.lane === "duplicate-merge";
  if (!allowsDeletes) {
    return plan.deleteBatches.length === 0
      ? null
      : `Lane ${plan.lane} cannot carry deleteBatches.`;
  }
  for (const batch of plan.deleteBatches) {
    for (const target of batch.targets) {
      const err = validateDeleteTarget(plan.lane, target, deleteTargetSet);
      if (err !== null) return err;
    }
  }
  return deleteTargetSet.size === 0
    ? `Lane ${plan.lane} requires at least one delete target.`
    : null;
}

function validatePlanHeaderAndEvidence(plan: MutationPlanDoc): string | null {
  if (parseEmailAddress(plan.account) === null) {
    return "Plan account is not a valid email address.";
  }
  if (plan.maxContacts < 1 || plan.maxContacts > HARD_MAX_CONTACTS) {
    return `Plan maxContacts must be between 1 and ${String(HARD_MAX_CONTACTS)}.`;
  }
  if (
    plan.targetCount < 1 ||
    plan.targetCount > HARD_MAX_CONTACTS ||
    plan.targetCount !== plan.targets.length ||
    plan.targetCount > plan.maxContacts
  ) {
    return "Plan targetCount is out of bounds or disagrees with targets.";
  }
  for (const item of plan.evidenceSummary) {
    if (item.lane !== "web") continue;
    if (item.query === null || item.query.trim().length === 0) {
      return `Web evidence ${item.id} is missing its recorded query string.`;
    }
    const leak = detectWebQueryLeak(item.query, plan.leakGuard);
    if (leak !== null) return `${item.id}: ${leak}`;
  }
  return null;
}

function validateTargetRevisions(
  plan: MutationPlanDoc,
  seenUpdates: ReadonlyMap<string, string>,
  deleteMap: ReadonlyMap<string, string>,
): string | null {
  const targetMap = new Map<string, string>();
  for (const target of plan.targets) {
    if (
      parseResourceName(target.resourceName) === null ||
      parseContactRevision(target.expectedRevision) === null ||
      targetMap.has(target.resourceName)
    ) {
      return `Invalid or duplicate target ${target.resourceName}.`;
    }
    targetMap.set(target.resourceName, target.expectedRevision);
  }
  for (const [rn, rev] of seenUpdates) {
    if (deleteMap.has(rn) || targetMap.get(rn) !== rev) {
      return `Update target ${rn} disagrees with plan targets or overlaps delete set.`;
    }
  }
  for (const [rn, rev] of deleteMap) {
    if (targetMap.get(rn) !== rev) {
      return `Delete target ${rn} disagrees with plan targets.`;
    }
  }
  return targetMap.size === seenUpdates.size + deleteMap.size
    ? null
    : "Plan targets do not match scheduled updates and deletes.";
}

export function validateMutationPlan(plan: MutationPlanDoc): string | null {
  const headerErr = validatePlanHeaderAndEvidence(plan);
  if (headerErr !== null) return headerErr;
  const seenUpdates = new Map<string, string>();
  for (const batch of plan.updateSubBatches) {
    const err = validateOneSubBatch(plan.lane, batch, seenUpdates);
    if (err !== null) return err;
  }
  const deleteMap = new Map<string, string>();
  const delErr = validateDeleteBatches(plan, deleteMap);
  if (delErr !== null) return delErr;
  return (
    validateTargetRevisions(plan, seenUpdates, deleteMap) ??
    validateMergeClusters(plan, seenUpdates, deleteMap) ??
    validatePlanMembership(plan)
  );
}

export function verifyPlanSealMatch(
  plan: MutationPlanDoc,
  providedSeal: string,
): boolean {
  const { seal: existingSeal, ...body } = plan;
  const computed = computePlanSeal(body).value;
  return existingSeal === computed && providedSeal.trim() === computed;
}

function entryContainsPlannedFields(
  field: ContactListField,
  live: object,
  planned: object,
): boolean {
  return writableSubfieldKeys(field, planned).every(
    (key) =>
      canonicalJson(ownValue(live, key)) ===
      canonicalJson(ownValue(planned, key)),
  );
}

const LANDED_LIST_FIELDS = [
  "names",
  "phoneNumbers",
  "emailAddresses",
  "organizations",
  "addresses",
  "urls",
  "birthdays",
  "events",
  "relations",
] as const;

export function verifyPlannedUpdateLanded(
  live: ContactRecord,
  update: PlannedContactUpdate,
): boolean {
  if (live.etag === update.expectedRevision) return false;
  const fields = update.fields;
  for (const field of LANDED_LIST_FIELDS) {
    const planned: readonly object[] | undefined = fields[field];
    const actual: readonly object[] = live[field];
    if (
      planned !== undefined &&
      !planned.every((entry) =>
        actual.some((liveEntry) =>
          entryContainsPlannedFields(field, liveEntry, entry),
        ),
      )
    ) {
      return false;
    }
  }
  if (
    fields.biographies !== undefined &&
    fields.biographies.length > 0 &&
    !live.biographies.some((bio) =>
      bio.value.includes(fields.biographies?.[0]?.value ?? ""),
    )
  ) {
    return false;
  }
  return true;
}

export function flattenSubBatchUpdates(
  batches: readonly UpdateSubBatch[],
): readonly PlannedContactUpdate[] {
  const out: PlannedContactUpdate[] = [];
  for (const batch of batches) {
    for (const update of batch.updates) out.push(update);
  }
  return out;
}
