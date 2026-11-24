import type { CountryCode } from "libphonenumber-js/min";
import { confidenceRank, stripNonContactSource } from "../domain/rules.ts";
import type {
  ChangeLane,
  ConfidenceTier,
  ContactRecord,
  ContactSnapshotDoc,
  EvidenceItem,
  FieldMetadata,
} from "../domain/rules.ts";
import {
  biographyEntryWithValue,
  buildAppendedBiography,
  computeDuplicateMerge,
  existingBiographyText,
  primaryContactSource,
} from "../merge/rules.ts";
import { planPhoneNormalization } from "../phone/rules.ts";
import { fieldMaskOf } from "../plan-subbatch/rules.ts";
import type {
  ContactWireFields,
  PlannedContactUpdate,
  PlannedDeleteTarget,
  PlannedMergeCluster,
  ProposalItem,
  ProposalsDoc,
  SkippedPlanItem,
} from "../plan-types/rules.ts";
import { containsUntrustedSentinel } from "../web-firewall/rules.ts";

export type LaneBuildOutput = {
  readonly updates: readonly PlannedContactUpdate[];
  readonly deletes: readonly PlannedDeleteTarget[];
  readonly clusters: readonly PlannedMergeCluster[];
  readonly skipped: readonly SkippedPlanItem[];
};

type ProposalAccumulator = {
  readonly updates: PlannedContactUpdate[];
  readonly deletes: PlannedDeleteTarget[];
  readonly clusters: PlannedMergeCluster[];
  readonly skipped: SkippedPlanItem[];
  readonly touched: Set<string>;
};

export type ProposalCompileContext = {
  readonly snapshot: ContactSnapshotDoc;
  readonly lane: ChangeLane;
  readonly proposals: ProposalsDoc | null;
  readonly minConfidence: ConfidenceTier;
  readonly maxContacts: number;
  readonly defaultRegion: CountryCode;
};

function privateAnchorKey(ev: EvidenceItem): string {
  return ev.anchor !== null
    ? `${ev.lane}:${ev.anchor.kind}:${ev.anchor.value}`
    : `${ev.lane}:${ev.sourceRef}`;
}

function resolveProposalConfidence(
  proposal: ProposalItem,
  evidenceMap: ReadonlyMap<string, EvidenceItem>,
): ConfidenceTier {
  const ids = proposal.evidenceIds ?? [];
  if (ids.length === 0) return proposal.confidence ?? "medium";
  const matched = ids
    .map((id) => evidenceMap.get(id))
    .filter((item) => item !== undefined);
  if (matched.length === 0) return proposal.confidence ?? "low";
  const privateItems = matched.filter((ev) => ev.lane !== "web");
  if (privateItems.length === 0) {
    const requested = proposal.confidence ?? "medium";
    return requested === "high" ? "medium" : requested;
  }
  const distinct = new Set(privateItems.map(privateAnchorKey));
  return distinct.size >= 2 ? "high" : "medium";
}

function mergeArray<T extends { readonly metadata?: FieldMetadata }>(
  existing: readonly T[],
  added: readonly T[] | undefined,
): readonly T[] | undefined {
  if (added === undefined) return undefined;
  return [...stripNonContactSource(existing), ...stripNonContactSource(added)];
}

function buildMetadataFields(
  contact: ContactRecord,
  proposal: ProposalItem,
): ContactWireFields {
  const names = mergeArray(contact.names, proposal.names);
  const organizations = mergeArray(
    contact.organizations,
    proposal.organizations,
  );
  const addresses = mergeArray(contact.addresses, proposal.addresses);
  const urls = mergeArray(contact.urls, proposal.urls);
  const emailAddresses = mergeArray(
    contact.emailAddresses,
    proposal.emailAddresses,
  );
  const birthdays = mergeArray(contact.birthdays, proposal.birthdays);
  const events = mergeArray(contact.events, proposal.events);
  const relations = mergeArray(contact.relations, proposal.relations);
  return {
    ...(names !== undefined ? { names } : {}),
    ...(organizations !== undefined ? { organizations } : {}),
    ...(addresses !== undefined ? { addresses } : {}),
    ...(urls !== undefined ? { urls } : {}),
    ...(emailAddresses !== undefined ? { emailAddresses } : {}),
    ...(birthdays !== undefined ? { birthdays } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(relations !== undefined ? { relations } : {}),
  };
}

function resolveDuplicatesFromMap(
  dupIds: readonly string[],
  contactMap: ReadonlyMap<string, ContactRecord>,
):
  | { readonly ok: true; readonly records: readonly ContactRecord[] }
  | { readonly ok: false; readonly reason: string } {
  const records: ContactRecord[] = [];
  for (const dupId of dupIds) {
    const rec = contactMap.get(dupId);
    if (rec === undefined) {
      return {
        ok: false,
        reason: `Duplicate target ${dupId} is not present in snapshot.`,
      };
    }
    records.push(rec);
  }
  return { ok: true, records };
}

function handleMergeProposal(
  input: ProposalCompileContext,
  contact: ContactRecord,
  prop: ProposalItem,
  contactMap: ReadonlyMap<string, ContactRecord>,
  acc: ProposalAccumulator,
): string | null {
  const dupIds = prop.duplicates ?? [];
  const dupRes = resolveDuplicatesFromMap(dupIds, contactMap);
  if (!dupRes.ok) return dupRes.reason;
  const dupRecords = dupRes.records;
  if (acc.touched.size + 1 + dupRecords.length > input.maxContacts) {
    if (acc.touched.size === 0) {
      return `Merge cluster for ${prop.target} exceeds maxContacts (${String(input.maxContacts)}).`;
    }
    acc.skipped.push({ resourceName: prop.target, reason: "max-contacts-cap" });
    return null;
  }
  if ([prop.target, ...dupIds].some((id) => acc.touched.has(id))) {
    return `Contact in merge cluster for ${prop.target} appears in multiple proposals.`;
  }
  const merged = computeDuplicateMerge({
    survivor: contact,
    duplicates: dupRecords,
    allContacts: input.snapshot.contacts,
    defaultRegion: input.defaultRegion,
    humanConfirmed: prop.humanConfirmed === true,
    reason: prop.reason ?? null,
  });
  if (!merged.ok) return merged.reason;
  acc.touched.add(contact.resourceName);
  for (const dup of dupRecords) acc.touched.add(dup.resourceName);
  acc.clusters.push(merged.cluster);
  acc.updates.push({
    resourceName: contact.resourceName,
    expectedRevision: contact.etag,
    contactSource: primaryContactSource(contact),
    fields: merged.survivorFields,
    existingBiography: merged.existingBiography,
    appendedLine: merged.cluster.provenanceLine,
    confidence: "high",
  });
  for (const dup of dupRecords) {
    acc.deletes.push({
      resourceName: dup.resourceName,
      expectedRevision: dup.etag,
      reason: `Merged into ${contact.resourceName}`,
      confirmedByHuman: prop.humanConfirmed === true,
      clusterSurvivor: contact.resourceName,
    });
  }
  return null;
}

function handleNoteProposal(
  input: ProposalCompileContext,
  contact: ContactRecord,
  prop: ProposalItem,
  conf: ConfidenceTier,
  acc: ProposalAccumulator,
): string | null {
  const line = (prop.noteLine ?? "").trim();
  if (line.length === 0 || containsUntrustedSentinel(line)) {
    return `Invalid or untrusted noteLine for ${contact.resourceName}.`;
  }
  const existing = existingBiographyText(contact);
  const appended = buildAppendedBiography(existing, line);
  if (!appended.changed) {
    acc.skipped.push({
      resourceName: contact.resourceName,
      reason: "note-already-present",
    });
    return null;
  }
  if (confidenceRank(conf) < confidenceRank(input.minConfidence)) {
    acc.skipped.push({
      resourceName: contact.resourceName,
      reason: "below-min-confidence",
    });
    return null;
  }
  acc.touched.add(contact.resourceName);
  acc.updates.push({
    resourceName: contact.resourceName,
    expectedRevision: contact.etag,
    contactSource: primaryContactSource(contact),
    fields: {
      biographies: [biographyEntryWithValue([contact], appended.value)],
    },
    existingBiography: existing,
    appendedLine: line,
    confidence: conf,
  });
  return null;
}

function handleUpdateProposal(
  input: ProposalCompileContext,
  contact: ContactRecord,
  prop: ProposalItem,
  conf: ConfidenceTier,
  acc: ProposalAccumulator,
): string | null {
  if (confidenceRank(conf) < confidenceRank(input.minConfidence)) {
    acc.skipped.push({
      resourceName: contact.resourceName,
      reason: "below-min-confidence",
    });
    return null;
  }
  if (input.lane === "phone-normalize") {
    const norm = planPhoneNormalization(
      stripNonContactSource(contact.phoneNumbers),
      prop.phoneNumbers !== undefined
        ? stripNonContactSource(prop.phoneNumbers)
        : null,
      input.defaultRegion,
    );
    if (norm.ambiguousValues.length > 0) {
      return `Ambiguous phone numbers on ${contact.resourceName}: ${norm.ambiguousValues.join(", ")}.`;
    }
    acc.touched.add(contact.resourceName);
    acc.updates.push({
      resourceName: contact.resourceName,
      expectedRevision: contact.etag,
      contactSource: primaryContactSource(contact),
      fields: { phoneNumbers: norm.phones },
      existingBiography: null,
      appendedLine: null,
      confidence: conf,
    });
    return null;
  }
  const fields = buildMetadataFields(contact, prop);
  if (fieldMaskOf(fields).length === 0) {
    acc.skipped.push({
      resourceName: contact.resourceName,
      reason: "no-metadata-fields",
    });
    return null;
  }
  acc.touched.add(contact.resourceName);
  acc.updates.push({
    resourceName: contact.resourceName,
    expectedRevision: contact.etag,
    contactSource: primaryContactSource(contact),
    fields,
    existingBiography: null,
    appendedLine: null,
    confidence: conf,
  });
  return null;
}

function handleStandardProposal(
  input: ProposalCompileContext,
  contact: ContactRecord,
  prop: ProposalItem,
  evidenceMap: ReadonlyMap<string, EvidenceItem>,
  acc: ProposalAccumulator,
): string | null {
  if (acc.touched.has(contact.resourceName)) {
    return `Contact ${contact.resourceName} appears in multiple updates in one plan.`;
  }
  if (acc.touched.size >= input.maxContacts) {
    acc.skipped.push({
      resourceName: contact.resourceName,
      reason: "max-contacts-cap",
    });
    return null;
  }
  if (input.lane === "contact-delete") {
    const reason = (prop.reason ?? "").trim();
    if (prop.humanConfirmed !== true || reason.length === 0) {
      return `contact-delete on ${contact.resourceName} requires humanConfirmed: true and a non-empty reason.`;
    }
    acc.touched.add(contact.resourceName);
    acc.deletes.push({
      resourceName: contact.resourceName,
      expectedRevision: contact.etag,
      reason,
      confirmedByHuman: true,
      clusterSurvivor: null,
    });
    return null;
  }
  const conf = resolveProposalConfidence(prop, evidenceMap);
  return input.lane === "note-append"
    ? handleNoteProposal(input, contact, prop, conf, acc)
    : handleUpdateProposal(input, contact, prop, conf, acc);
}

export function compileProposalsForLane(
  input: ProposalCompileContext,
  contactMap: ReadonlyMap<string, ContactRecord>,
  filterSet: ReadonlySet<string> | null,
  evidenceMap: ReadonlyMap<string, EvidenceItem>,
):
  | { readonly ok: true; readonly out: LaneBuildOutput }
  | { readonly ok: false; readonly reason: string } {
  const acc: ProposalAccumulator = {
    updates: [],
    deletes: [],
    clusters: [],
    skipped: [],
    touched: new Set<string>(),
  };
  const list = (input.proposals?.proposals ?? []).filter(
    (item) => item.kind === input.lane,
  );
  for (const prop of list) {
    if (filterSet !== null && !filterSet.has(prop.target)) continue;
    const contact = contactMap.get(prop.target);
    if (contact === undefined) {
      return {
        ok: false,
        reason: `Proposal target ${prop.target} is not present in snapshot.`,
      };
    }
    const err =
      input.lane === "duplicate-merge"
        ? handleMergeProposal(input, contact, prop, contactMap, acc)
        : handleStandardProposal(input, contact, prop, evidenceMap, acc);
    if (err !== null) return { ok: false, reason: err };
  }
  return { ok: true, out: acc };
}
