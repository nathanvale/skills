import { canonicalJson, makePlanSeal, sha256Hex } from "../domain/rules.ts";
import type {
  ChangeLane,
  ConfidenceTier,
  ContactAddress,
  ContactBiography,
  ContactBirthday,
  ContactEmail,
  ContactEvent,
  ContactName,
  ContactOrganization,
  ContactPhone,
  ContactRelation,
  ContactUrl,
  EvidenceItem,
  FieldMetadataSource,
  PlanSeal,
  SerializedIdentityAnchor,
} from "../domain/rules.ts";

export type ProposalItem = {
  readonly kind: ChangeLane;
  readonly target: string;
  readonly confidence?: ConfidenceTier;
  readonly phoneNumbers?: readonly ContactPhone[];
  readonly names?: readonly ContactName[];
  readonly organizations?: readonly ContactOrganization[];
  readonly addresses?: readonly ContactAddress[];
  readonly urls?: readonly ContactUrl[];
  readonly emailAddresses?: readonly ContactEmail[];
  readonly birthdays?: readonly ContactBirthday[];
  readonly events?: readonly ContactEvent[];
  readonly relations?: readonly ContactRelation[];
  readonly noteLine?: string;
  readonly duplicates?: readonly string[];
  readonly humanConfirmed?: boolean;
  readonly reason?: string;
  readonly evidenceIds?: readonly string[];
};

export type ProposalsDoc = {
  readonly schemaVersion: "contacts-proposals/1";
  readonly account: string;
  readonly proposals: readonly ProposalItem[];
};

export type ContactWireFields = {
  readonly names?: readonly ContactName[];
  readonly phoneNumbers?: readonly ContactPhone[];
  readonly emailAddresses?: readonly ContactEmail[];
  readonly addresses?: readonly ContactAddress[];
  readonly organizations?: readonly ContactOrganization[];
  readonly biographies?: readonly ContactBiography[];
  readonly urls?: readonly ContactUrl[];
  readonly birthdays?: readonly ContactBirthday[];
  readonly events?: readonly ContactEvent[];
  readonly relations?: readonly ContactRelation[];
};

export type PlannedContactUpdate = {
  readonly resourceName: string;
  readonly expectedRevision: string;
  readonly contactSource: FieldMetadataSource;
  readonly fields: ContactWireFields;
  readonly existingBiography: string | null;
  readonly appendedLine: string | null;
  readonly confidence: ConfidenceTier;
};

export type UpdateSubBatch = {
  readonly index: number;
  readonly fieldMask: readonly string[];
  readonly payloadBytes: number;
  readonly updates: readonly PlannedContactUpdate[];
};

export type PlannedDeleteTarget = {
  readonly resourceName: string;
  readonly expectedRevision: string;
  readonly reason: string;
  readonly confirmedByHuman: boolean;
  readonly clusterSurvivor: string | null;
};

export type DeleteBatch = {
  readonly index: number;
  readonly targets: readonly PlannedDeleteTarget[];
};

export type PlannedMergeCluster = {
  readonly survivor: string;
  readonly expectedSurvivorRevision: string;
  readonly duplicates: readonly {
    readonly resourceName: string;
    readonly expectedRevision: string;
    readonly nonAllowlistedFields: readonly string[];
  }[];
  readonly corroboration:
    | {
        readonly kind: "anchors";
        readonly anchors: readonly SerializedIdentityAnchor[];
      }
    | { readonly kind: "human-confirmed"; readonly note: string };
  readonly provenanceLine: string;
  readonly hasConflictingNames: boolean;
};

export type PlannedTarget = {
  readonly resourceName: string;
  readonly expectedRevision: string;
  readonly role: "update" | "survivor" | "duplicate" | "delete";
};

export type SkippedPlanItem = {
  readonly resourceName: string;
  readonly reason: string;
};

export type PlanLeakGuard = {
  readonly privatePhones: readonly string[];
  readonly personalEmails: readonly string[];
  readonly bareNames: readonly string[];
  readonly streetAddresses: readonly string[];
};

export type MutationPlanBody = {
  readonly schemaVersion: "contacts-plan/1";
  readonly account: string;
  readonly lane: ChangeLane;
  readonly minConfidence: ConfidenceTier;
  readonly maxContacts: number;
  readonly targetCount: number;
  readonly targets: readonly PlannedTarget[];
  readonly updateSubBatches: readonly UpdateSubBatch[];
  readonly deleteBatches: readonly DeleteBatch[];
  readonly mergeClusters: readonly PlannedMergeCluster[];
  readonly evidenceSummary: readonly EvidenceItem[];
  readonly leakGuard: PlanLeakGuard;
  readonly skipped: readonly SkippedPlanItem[];
};

export type MutationPlanDoc = MutationPlanBody & {
  readonly seal: string;
};

export function computePlanSeal(body: MutationPlanBody): PlanSeal {
  return makePlanSeal(sha256Hex(canonicalJson(body)));
}
