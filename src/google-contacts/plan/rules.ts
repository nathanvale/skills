import type { CountryCode } from "libphonenumber-js/min";
import { confidenceRank, stripNonContactSource } from "../domain/rules.ts";
import type {
  AuditDoc,
  AuditFinding,
  ChangeLane,
  ConfidenceTier,
  ContactRecord,
  ContactSnapshotDoc,
  EvidenceItem,
} from "../domain/rules.ts";
import { primaryContactSource } from "../merge/rules.ts";
import { planPhoneNormalization } from "../phone/rules.ts";
import { compileProposalsForLane } from "../plan-proposals/rules.ts";
import type { LaneBuildOutput } from "../plan-proposals/rules.ts";
import {
  HARD_MAX_CONTACTS,
  partitionSubBatches,
} from "../plan-subbatch/rules.ts";
import { computePlanSeal } from "../plan-types/rules.ts";
import type {
  DeleteBatch,
  MutationPlanBody,
  MutationPlanDoc,
  PlannedContactUpdate,
  PlannedTarget,
  ProposalsDoc,
  SkippedPlanItem,
} from "../plan-types/rules.ts";
import { buildLeakGuard, refuseWebEvidence } from "../web-firewall/rules.ts";

export type CompilePlanInput = {
  readonly snapshot: ContactSnapshotDoc;
  readonly lane: ChangeLane;
  readonly accountOverride: string | null;
  readonly audit: AuditDoc | null;
  readonly proposals: ProposalsDoc | null;
  readonly evidenceItems: readonly EvidenceItem[];
  readonly contactFilter: readonly string[];
  readonly minConfidence: ConfidenceTier;
  readonly maxContacts: number;
  readonly defaultRegion: CountryCode;
};

export type CompilePlanResult =
  | { readonly ok: true; readonly plan: MutationPlanDoc }
  | { readonly ok: false; readonly reason: string };

function applyPhoneAuditFinding(params: {
  readonly finding: AuditFinding;
  readonly contactMap: ReadonlyMap<string, ContactRecord>;
  readonly filterSet: ReadonlySet<string> | null;
  readonly minConfidence: ConfidenceTier;
  readonly maxContacts: number;
  readonly defaultRegion: CountryCode;
  readonly seen: Set<string>;
  readonly updates: PlannedContactUpdate[];
  readonly skipped: SkippedPlanItem[];
}): void {
  const { finding } = params;
  const rn = finding.resourceNames[0];
  if (
    finding.lane !== "phone-normalize" ||
    rn === undefined ||
    params.seen.has(rn)
  ) {
    return;
  }
  if (params.filterSet !== null && !params.filterSet.has(rn)) return;
  if (
    confidenceRank(finding.confidence) < confidenceRank(params.minConfidence)
  ) {
    params.skipped.push({ resourceName: rn, reason: "below-min-confidence" });
    return;
  }
  const contact = params.contactMap.get(rn);
  if (contact === undefined) return;
  if (params.updates.length >= params.maxContacts) {
    params.skipped.push({ resourceName: rn, reason: "max-contacts-cap" });
    return;
  }
  const phones = planPhoneNormalization(
    stripNonContactSource(contact.phoneNumbers),
    finding.normalizedPhones !== undefined
      ? stripNonContactSource(finding.normalizedPhones)
      : null,
    params.defaultRegion,
  ).phones;
  params.seen.add(rn);
  params.updates.push({
    resourceName: contact.resourceName,
    expectedRevision: contact.etag,
    contactSource: primaryContactSource(contact),
    fields: { phoneNumbers: phones },
    existingBiography: null,
    appendedLine: null,
    confidence: finding.confidence,
  });
}

function compilePhoneFromAudit(
  audit: AuditDoc,
  contactMap: ReadonlyMap<string, ContactRecord>,
  filterSet: ReadonlySet<string> | null,
  minConfidence: ConfidenceTier,
  maxContacts: number,
  defaultRegion: CountryCode,
): LaneBuildOutput {
  const updates: PlannedContactUpdate[] = [];
  const skipped: SkippedPlanItem[] = [];
  const seen = new Set<string>();
  for (const finding of audit.findings) {
    applyPhoneAuditFinding({
      finding,
      contactMap,
      filterSet,
      minConfidence,
      maxContacts,
      defaultRegion,
      seen,
      updates,
      skipped,
    });
  }
  return { updates, deletes: [], clusters: [], skipped };
}

function checkAccountsMatch(input: CompilePlanInput): string | null {
  const snapAcct = input.snapshot.account.toLowerCase();
  if (
    input.accountOverride !== null &&
    input.accountOverride.toLowerCase() !== snapAcct
  ) {
    return "Specified --account does not match snapshot account.";
  }
  if (input.audit !== null && input.audit.account.toLowerCase() !== snapAcct) {
    return "Audit account does not match snapshot account.";
  }
  if (
    input.proposals !== null &&
    input.proposals.account.toLowerCase() !== snapAcct
  ) {
    return "Proposals account does not match snapshot account.";
  }
  return null;
}

function validatePlanPreconditions(input: CompilePlanInput): string | null {
  const webErr = refuseWebEvidence(input.evidenceItems);
  if (webErr !== null) return webErr;
  if (input.maxContacts < 1 || input.maxContacts > HARD_MAX_CONTACTS) {
    return `maxContacts must be between 1 and ${String(HARD_MAX_CONTACTS)}.`;
  }
  return checkAccountsMatch(input);
}

function buildPlanTargets(built: LaneBuildOutput): readonly PlannedTarget[] {
  const survivorSet = new Set(built.clusters.map((c) => c.survivor));
  const targets: PlannedTarget[] = [];
  for (const update of built.updates) {
    targets.push({
      resourceName: update.resourceName,
      expectedRevision: update.expectedRevision,
      role: survivorSet.has(update.resourceName) ? "survivor" : "update",
    });
  }
  for (const del of built.deletes) {
    targets.push({
      resourceName: del.resourceName,
      expectedRevision: del.expectedRevision,
      role: del.clusterSurvivor !== null ? "duplicate" : "delete",
    });
  }
  return targets;
}

function buildLaneOutputs(
  input: CompilePlanInput,
):
  | { readonly ok: true; readonly out: LaneBuildOutput }
  | { readonly ok: false; readonly reason: string } {
  const contactMap = new Map(
    input.snapshot.contacts.map((contact) => [contact.resourceName, contact]),
  );
  const filterSet =
    input.contactFilter.length > 0 ? new Set(input.contactFilter) : null;
  if (input.audit !== null) {
    if (input.lane !== "phone-normalize") {
      return {
        ok: false,
        reason:
          "Compiling from --audit is supported only for --lane phone-normalize; pass --proposals for other lanes.",
      };
    }
    return {
      ok: true,
      out: compilePhoneFromAudit(
        input.audit,
        contactMap,
        filterSet,
        input.minConfidence,
        input.maxContacts,
        input.defaultRegion,
      ),
    };
  }
  const evidenceMap = new Map(input.evidenceItems.map((ev) => [ev.id, ev]));
  return compileProposalsForLane(input, contactMap, filterSet, evidenceMap);
}

export function compileMutationPlan(
  input: CompilePlanInput,
): CompilePlanResult {
  const preErr = validatePlanPreconditions(input);
  if (preErr !== null) return { ok: false, reason: preErr };
  const builtRes = buildLaneOutputs(input);
  if (!builtRes.ok) return builtRes;
  const built = builtRes.out;
  const subRes = partitionSubBatches(built.updates);
  if (!subRes.ok) return subRes;
  const targets = buildPlanTargets(built);
  if (targets.length === 0) {
    return {
      ok: false,
      reason: "No eligible contacts matched the lane and confidence filters.",
    };
  }
  const deleteBatches: DeleteBatch[] =
    built.deletes.length > 0 ? [{ index: 0, targets: built.deletes }] : [];
  const body: MutationPlanBody = {
    schemaVersion: "contacts-plan/1",
    account: input.snapshot.account,
    lane: input.lane,
    minConfidence: input.minConfidence,
    maxContacts: input.maxContacts,
    targetCount: targets.length,
    targets,
    updateSubBatches: subRes.batches,
    deleteBatches,
    mergeClusters: built.clusters,
    evidenceSummary: input.evidenceItems,
    leakGuard: buildLeakGuard(input.snapshot.contacts),
    skipped: built.skipped,
  };
  return { ok: true, plan: { ...body, seal: computePlanSeal(body).value } };
}
