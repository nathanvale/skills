import {
  decodeSource,
  decodeStrictList,
  decodeStringList,
  unwrapEnvelopePayload,
} from "../decoders/rules.ts";
import {
  asObject,
  ownArray,
  ownBoolean,
  ownNumber,
  ownString,
  ownValue,
  parseChangeLane,
  parseConfidenceTier,
  parseEmailAddress,
  parsePlanSeal,
  parseResourceName,
} from "../domain/rules.ts";
import type { ConfidenceTier, EvidenceItem } from "../domain/rules.ts";
import {
  decodeEvidenceItem,
  decodeSerializedAnchor,
} from "../evidence-decoders/rules.ts";
import { decodeRecordLists } from "../person-fields/rules.ts";
import type {
  ContactWireFields,
  DeleteBatch,
  MutationPlanDoc,
  PlannedContactUpdate,
  PlannedDeleteTarget,
  PlannedMergeCluster,
  PlannedTarget,
  PlanLeakGuard,
  ProposalItem,
  ProposalsDoc,
  SkippedPlanItem,
  UpdateSubBatch,
} from "../plan-types/rules.ts";

function decodeWireFields(raw: unknown): ContactWireFields | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const lists = decodeRecordLists(obj);
  if (lists === null) return null;
  const has = (key: string): boolean => ownArray(obj, key) !== null;
  return {
    ...(has("names") ? { names: lists.names } : {}),
    ...(has("phoneNumbers") ? { phoneNumbers: lists.phoneNumbers } : {}),
    ...(has("emailAddresses") ? { emailAddresses: lists.emailAddresses } : {}),
    ...(has("addresses") ? { addresses: lists.addresses } : {}),
    ...(has("organizations") ? { organizations: lists.organizations } : {}),
    ...(has("biographies") ? { biographies: lists.biographies } : {}),
    ...(has("urls") ? { urls: lists.urls } : {}),
    ...(has("birthdays") ? { birthdays: lists.birthdays } : {}),
    ...(has("events") ? { events: lists.events } : {}),
    ...(has("relations") ? { relations: lists.relations } : {}),
  };
}

function decodeOptionalStringList(
  obj: object,
  key: string,
):
  | { readonly ok: true; readonly value: readonly string[] | undefined }
  | { readonly ok: false } {
  const raw = ownValue(obj, key);
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = decodeStringList(raw);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

function decodeProposalExtras(obj: object):
  | {
      readonly ok: true;
      readonly confidence?: ConfidenceTier;
      readonly noteLine?: string;
      readonly duplicates?: readonly string[];
      readonly humanConfirmed?: boolean;
      readonly reason?: string;
      readonly evidenceIds?: readonly string[];
    }
  | { readonly ok: false } {
  const confRaw = ownString(obj, "confidence");
  const confidence = confRaw !== null ? parseConfidenceTier(confRaw) : null;
  if (confRaw !== null && confidence === null) return { ok: false };
  const dups = decodeOptionalStringList(obj, "duplicates");
  const evIds = decodeOptionalStringList(obj, "evidenceIds");
  if (!dups.ok || !evIds.ok) return { ok: false };
  const noteLine = ownString(obj, "noteLine");
  const humanConfirmed = ownBoolean(obj, "humanConfirmed");
  const reason = ownString(obj, "reason");
  return {
    ok: true,
    ...(confidence !== null ? { confidence } : {}),
    ...(noteLine !== null ? { noteLine } : {}),
    ...(dups.value !== undefined ? { duplicates: dups.value } : {}),
    ...(humanConfirmed !== null ? { humanConfirmed } : {}),
    ...(reason !== null ? { reason } : {}),
    ...(evIds.value !== undefined ? { evidenceIds: evIds.value } : {}),
  };
}

function decodeProposalItem(raw: unknown): ProposalItem | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const kindRaw = ownString(obj, "kind");
  const target = ownString(obj, "target");
  if (kindRaw === null || target === null) return null;
  const kind = parseChangeLane(kindRaw);
  if (kind === null || parseResourceName(target) === null) return null;
  const fields = decodeWireFields(obj);
  const extras = decodeProposalExtras(obj);
  if (fields === null || !extras.ok) return null;
  return { kind, target, ...fields, ...extras };
}

export function decodeProposalsDoc(raw: unknown): ProposalsDoc | null {
  const obj = asObject(unwrapEnvelopePayload(raw));
  if (obj === null) return null;
  if (ownString(obj, "schemaVersion") !== "contacts-proposals/1") return null;
  const accountRaw = ownString(obj, "account");
  const proposals = decodeStrictList(
    ownArray(obj, "proposals"),
    decodeProposalItem,
  );
  if (accountRaw === null || proposals === null) return null;
  const account = parseEmailAddress(accountRaw);
  if (account === null) return null;
  return {
    schemaVersion: "contacts-proposals/1",
    account: account.value,
    proposals,
  };
}

function decodePlannedUpdate(raw: unknown): PlannedContactUpdate | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const resourceName = ownString(obj, "resourceName");
  const expectedRevision = ownString(obj, "expectedRevision");
  const contactSource = decodeSource(ownValue(obj, "contactSource"));
  const fields = decodeWireFields(ownValue(obj, "fields"));
  const confRaw = ownString(obj, "confidence");
  const confidence = confRaw !== null ? parseConfidenceTier(confRaw) : null;
  if (
    resourceName === null ||
    expectedRevision === null ||
    contactSource === null ||
    fields === null ||
    confidence === null
  ) {
    return null;
  }
  return {
    resourceName,
    expectedRevision,
    contactSource,
    fields,
    existingBiography: ownString(obj, "existingBiography"),
    appendedLine: ownString(obj, "appendedLine"),
    confidence,
  };
}

function decodeSubBatch(raw: unknown): UpdateSubBatch | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const index = ownNumber(obj, "index");
  const payloadBytes = ownNumber(obj, "payloadBytes");
  const fieldMask = decodeStringList(ownValue(obj, "fieldMask"));
  const updates = decodeStrictList(
    ownArray(obj, "updates"),
    decodePlannedUpdate,
  );
  if (
    index === null ||
    payloadBytes === null ||
    fieldMask === null ||
    updates === null
  ) {
    return null;
  }
  return { index, fieldMask, payloadBytes, updates };
}

function decodeDeleteTarget(raw: unknown): PlannedDeleteTarget | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const resourceName = ownString(obj, "resourceName");
  const expectedRevision = ownString(obj, "expectedRevision");
  const reason = ownString(obj, "reason");
  const confirmedByHuman = ownBoolean(obj, "confirmedByHuman");
  if (
    resourceName === null ||
    expectedRevision === null ||
    reason === null ||
    confirmedByHuman === null
  ) {
    return null;
  }
  return {
    resourceName,
    expectedRevision,
    reason,
    confirmedByHuman,
    clusterSurvivor: ownString(obj, "clusterSurvivor"),
  };
}

function decodeDeleteBatch(raw: unknown): DeleteBatch | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const index = ownNumber(obj, "index");
  const targets = decodeStrictList(
    ownArray(obj, "targets"),
    decodeDeleteTarget,
  );
  if (index === null || targets === null) return null;
  return { index, targets };
}

function decodeDuplicateRef(raw: unknown): {
  readonly resourceName: string;
  readonly expectedRevision: string;
  readonly nonAllowlistedFields: readonly string[];
} | null {
  const dupObj = asObject(raw);
  if (dupObj === null) return null;
  const resourceName = ownString(dupObj, "resourceName");
  const expectedRevision = ownString(dupObj, "expectedRevision");
  const nonAllowlistedFields = decodeStringList(
    ownValue(dupObj, "nonAllowlistedFields"),
  );
  if (
    resourceName === null ||
    expectedRevision === null ||
    nonAllowlistedFields === null
  ) {
    return null;
  }
  return { resourceName, expectedRevision, nonAllowlistedFields };
}

function decodeCorroboration(
  raw: unknown,
): PlannedMergeCluster["corroboration"] | null {
  const corrObj = asObject(raw);
  if (corrObj === null) return null;
  const corrKind = ownString(corrObj, "kind");
  if (corrKind === "anchors") {
    const anchors = decodeStrictList(
      ownArray(corrObj, "anchors"),
      decodeSerializedAnchor,
    );
    return anchors === null ? null : { kind: "anchors", anchors };
  }
  if (corrKind === "human-confirmed") {
    const note = ownString(corrObj, "note");
    return note === null ? null : { kind: "human-confirmed", note };
  }
  return null;
}

function decodeMergeCluster(raw: unknown): PlannedMergeCluster | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const survivor = ownString(obj, "survivor");
  const expectedSurvivorRevision = ownString(obj, "expectedSurvivorRevision");
  const duplicates = decodeStrictList(
    ownArray(obj, "duplicates"),
    decodeDuplicateRef,
  );
  const corroboration = decodeCorroboration(ownValue(obj, "corroboration"));
  const provenanceLine = ownString(obj, "provenanceLine");
  const hasConflictingNames = ownBoolean(obj, "hasConflictingNames");
  if (
    survivor === null ||
    expectedSurvivorRevision === null ||
    duplicates === null ||
    corroboration === null ||
    provenanceLine === null ||
    hasConflictingNames === null
  ) {
    return null;
  }
  return {
    survivor,
    expectedSurvivorRevision,
    duplicates,
    corroboration,
    provenanceLine,
    hasConflictingNames,
  };
}

function decodePlannedTarget(raw: unknown): PlannedTarget | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const resourceName = ownString(obj, "resourceName");
  const expectedRevision = ownString(obj, "expectedRevision");
  const role = ownString(obj, "role");
  if (
    resourceName === null ||
    expectedRevision === null ||
    (role !== "update" &&
      role !== "survivor" &&
      role !== "duplicate" &&
      role !== "delete")
  ) {
    return null;
  }
  return { resourceName, expectedRevision, role };
}

function decodeLeakGuard(raw: unknown): PlanLeakGuard | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const privatePhones = decodeStringList(ownValue(obj, "privatePhones"));
  const personalEmails = decodeStringList(ownValue(obj, "personalEmails"));
  const bareNames = decodeStringList(ownValue(obj, "bareNames"));
  const streetAddresses = decodeStringList(ownValue(obj, "streetAddresses"));
  if (
    privatePhones === null ||
    personalEmails === null ||
    bareNames === null ||
    streetAddresses === null
  ) {
    return null;
  }
  return { privatePhones, personalEmails, bareNames, streetAddresses };
}

function decodeSkippedItem(raw: unknown): SkippedPlanItem | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const resourceName = ownString(obj, "resourceName");
  const reason = ownString(obj, "reason");
  return resourceName !== null && reason !== null
    ? { resourceName, reason }
    : null;
}

export function decodeMutationPlanDoc(raw: unknown): MutationPlanDoc | null {
  const obj = asObject(unwrapEnvelopePayload(raw));
  if (obj === null) return null;
  if (ownString(obj, "schemaVersion") !== "contacts-plan/1") return null;
  const account = ownString(obj, "account");
  const laneRaw = ownString(obj, "lane");
  const minConfRaw = ownString(obj, "minConfidence");
  const maxContacts = ownNumber(obj, "maxContacts");
  const targetCount = ownNumber(obj, "targetCount");
  const sealRaw = ownString(obj, "seal");
  const leakGuard = decodeLeakGuard(ownValue(obj, "leakGuard"));
  const lane = laneRaw !== null ? parseChangeLane(laneRaw) : null;
  const minConfidence =
    minConfRaw !== null ? parseConfidenceTier(minConfRaw) : null;
  const seal = sealRaw !== null ? parsePlanSeal(sealRaw) : null;
  const targets = decodeStrictList(
    ownArray(obj, "targets"),
    decodePlannedTarget,
  );
  const updateSubBatches = decodeStrictList(
    ownArray(obj, "updateSubBatches"),
    decodeSubBatch,
  );
  const deleteBatches = decodeStrictList(
    ownArray(obj, "deleteBatches"),
    decodeDeleteBatch,
  );
  const mergeClusters = decodeStrictList(
    ownArray(obj, "mergeClusters"),
    decodeMergeCluster,
  );
  const evidenceSummary = decodeStrictList<EvidenceItem>(
    ownArray(obj, "evidenceSummary"),
    decodeEvidenceItem,
  );
  const skipped = decodeStrictList(ownArray(obj, "skipped"), decodeSkippedItem);
  if (
    account === null ||
    lane === null ||
    minConfidence === null ||
    maxContacts === null ||
    targetCount === null ||
    seal === null ||
    leakGuard === null ||
    targets === null ||
    updateSubBatches === null ||
    deleteBatches === null ||
    mergeClusters === null ||
    evidenceSummary === null ||
    skipped === null
  ) {
    return null;
  }
  return {
    schemaVersion: "contacts-plan/1",
    account,
    lane,
    minConfidence,
    maxContacts,
    targetCount,
    targets,
    updateSubBatches,
    deleteBatches,
    mergeClusters,
    evidenceSummary,
    leakGuard,
    skipped,
    seal: seal.value,
  };
}
