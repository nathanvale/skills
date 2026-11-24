import { createHash } from "node:crypto";

const resourceNameBrand: unique symbol = Symbol("resourceName");
const e164PhoneBrand: unique symbol = Symbol("e164Phone");
const emailAddressBrand: unique symbol = Symbol("emailAddress");
const organizationDomainBrand: unique symbol = Symbol("organizationDomain");
const contactRevisionBrand: unique symbol = Symbol("contactRevision");
const planSealBrand: unique symbol = Symbol("planSeal");

export type ResourceName = {
  readonly [resourceNameBrand]: true;
  readonly value: string;
};

export type E164Phone = {
  readonly [e164PhoneBrand]: true;
  readonly value: string;
};

export type EmailAddress = {
  readonly [emailAddressBrand]: true;
  readonly value: string;
};

export type OrganizationDomain = {
  readonly [organizationDomainBrand]: true;
  readonly value: string;
};

export type ContactRevision = {
  readonly [contactRevisionBrand]: true;
  readonly value: string;
};

export type PlanSeal = {
  readonly [planSealBrand]: true;
  readonly value: string;
};

export type ChangeLane =
  | "phone-normalize"
  | "metadata-enrich"
  | "note-append"
  | "duplicate-merge"
  | "contact-delete";

export type ConfidenceTier = "high" | "medium" | "low";

export type EvidenceLane = "gmail" | "imsg" | "web-queue";

export type FieldMetadataSource = {
  readonly type: string;
  readonly id?: string;
  readonly etag?: string;
  readonly updateTime?: string;
};

export type FieldMetadata = {
  readonly primary?: boolean;
  readonly sourcePrimary?: boolean;
  readonly verified?: boolean;
  readonly source?: FieldMetadataSource;
};

export type ContactName = {
  readonly displayName?: string;
  readonly displayNameLastFirst?: string;
  readonly unstructuredName?: string;
  readonly givenName?: string;
  readonly middleName?: string;
  readonly familyName?: string;
  readonly honorificPrefix?: string;
  readonly honorificSuffix?: string;
  readonly phoneticFullName?: string;
  readonly phoneticGivenName?: string;
  readonly phoneticMiddleName?: string;
  readonly phoneticFamilyName?: string;
  readonly phoneticHonorificPrefix?: string;
  readonly phoneticHonorificSuffix?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactPhone = {
  readonly value: string;
  readonly canonicalForm?: string;
  readonly type?: string;
  readonly formattedType?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactEmail = {
  readonly value: string;
  readonly displayName?: string;
  readonly type?: string;
  readonly formattedType?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactAddress = {
  readonly formattedValue?: string;
  readonly poBox?: string;
  readonly streetAddress?: string;
  readonly extendedAddress?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly country?: string;
  readonly countryCode?: string;
  readonly type?: string;
  readonly formattedType?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactOrganization = {
  readonly name?: string;
  readonly phoneticName?: string;
  readonly title?: string;
  readonly jobDescription?: string;
  readonly department?: string;
  readonly symbol?: string;
  readonly domain?: string;
  readonly location?: string;
  readonly costCenter?: string;
  readonly fullTimeEquivalentMillipercent?: number;
  readonly current?: boolean;
  readonly startDate?: ContactDate;
  readonly endDate?: ContactDate;
  readonly type?: string;
  readonly formattedType?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactBiography = {
  readonly value: string;
  readonly contentType?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactUrl = {
  readonly value: string;
  readonly type?: string;
  readonly formattedType?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactDate = {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
};

export type ContactBirthday = {
  readonly text?: string;
  readonly date?: ContactDate;
  readonly metadata?: FieldMetadata;
};

export type ContactEvent = {
  readonly type?: string;
  readonly formattedType?: string;
  readonly date?: ContactDate;
  readonly metadata?: FieldMetadata;
};

export type ContactRelation = {
  readonly person: string;
  readonly type?: string;
  readonly formattedType?: string;
  readonly metadata?: FieldMetadata;
};

export type ContactRecord = {
  readonly resourceName: string;
  readonly etag: string;
  readonly metadata: {
    readonly sources: readonly FieldMetadataSource[];
  };
  readonly names: readonly ContactName[];
  readonly phoneNumbers: readonly ContactPhone[];
  readonly emailAddresses: readonly ContactEmail[];
  readonly addresses: readonly ContactAddress[];
  readonly organizations: readonly ContactOrganization[];
  readonly biographies: readonly ContactBiography[];
  readonly urls: readonly ContactUrl[];
  readonly birthdays: readonly ContactBirthday[];
  readonly events: readonly ContactEvent[];
  readonly relations: readonly ContactRelation[];
  readonly nonAllowlistedFields: readonly string[];
  readonly updatedAt: string | null;
};

export type ContactSnapshotDoc = {
  readonly schemaVersion: "contacts-snapshot/1";
  readonly account: string;
  readonly capturedAt: string;
  readonly contacts: readonly ContactRecord[];
  readonly missingContacts: readonly string[];
};

export type IdentityAnchor =
  | { readonly kind: "e164-phone"; readonly phone: E164Phone }
  | { readonly kind: "email"; readonly email: EmailAddress }
  | { readonly kind: "org-domain"; readonly domain: OrganizationDomain };

export type CorroboratedAnchors = readonly [
  IdentityAnchor,
  IdentityAnchor,
  ...IdentityAnchor[],
];

export type SerializedIdentityAnchor =
  | { readonly kind: "e164-phone"; readonly value: string }
  | { readonly kind: "email"; readonly value: string }
  | { readonly kind: "org-domain"; readonly value: string };

export type AuditFindingKind =
  | "phone-normalize"
  | "phone-ambiguous"
  | "phone-duplicate"
  | "duplicate-candidate"
  | "sparse-contact"
  | "stale-contact";

export type AuditFinding = {
  readonly id: string;
  readonly kind: AuditFindingKind;
  readonly lane: ChangeLane | null;
  readonly confidence: ConfidenceTier;
  readonly resourceNames: readonly string[];
  readonly summary: string;
  readonly normalizedPhones?: readonly ContactPhone[];
  readonly anchors?: readonly SerializedIdentityAnchor[];
  readonly missingFields?: readonly string[];
};

export type AuditDoc = {
  readonly schemaVersion: "contacts-audit/1";
  readonly account: string;
  readonly defaultRegion: string;
  readonly contactCount: number;
  readonly findings: readonly AuditFinding[];
};

export type EvidenceItem = {
  readonly id: string;
  readonly lane: "gmail" | "imsg" | "web";
  readonly contactResourceName: string;
  readonly anchor: SerializedIdentityAnchor | null;
  readonly sourceRef: string;
  readonly observedAt: string | null;
  readonly excerpt: string;
  readonly query: string | null;
  readonly suggestedFields: {
    readonly organizationName?: string;
    readonly organizationTitle?: string;
    readonly organizationDomain?: string;
    readonly emailAddress?: string;
    readonly phoneNumber?: string;
    readonly url?: string;
    readonly noteLine?: string;
  };
};

export type WebResearchQueueEntry = {
  readonly contactResourceName: string;
  readonly anchorKind: "org-domain" | "name-plus-organization";
  readonly safeQueryTerms: readonly string[];
  readonly suggestedQuery: string;
};

export type EvidenceLaneStatus = {
  readonly status:
    | "ready"
    | "skipped"
    | "unsupported-os"
    | "missing"
    | "outdated"
    | "fda-denied"
    | "unavailable";
  readonly detail: string;
};

export type EvidenceDoc = {
  readonly schemaVersion: "contacts-evidence/1";
  readonly account: string;
  readonly lanesRequested: readonly EvidenceLane[];
  readonly lanesStatus: {
    readonly gmail: EvidenceLaneStatus;
    readonly imsg: EvidenceLaneStatus;
    readonly webQueue: EvidenceLaneStatus;
  };
  readonly items: readonly EvidenceItem[];
  readonly webResearchQueue: readonly WebResearchQueueEntry[];
};

const RESOURCE_NAME_RE = /^people\/[A-Za-z0-9._-]+$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PLAN_SEAL_RE = /^sha256:[0-9a-f]{64}$/;

const CHANGE_LANES: readonly ChangeLane[] = [
  "phone-normalize",
  "metadata-enrich",
  "note-append",
  "duplicate-merge",
  "contact-delete",
];

const CONFIDENCE_TIERS: readonly ConfidenceTier[] = ["high", "medium", "low"];

export function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function asObject(value: unknown): object | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

export function ownValue(target: object, key: string): unknown {
  return Object.hasOwn(target, key) ? Reflect.get(target, key) : undefined;
}

export function ownString(target: object, key: string): string | null {
  const value = ownValue(target, key);
  return typeof value === "string" ? value : null;
}

export function ownBoolean(target: object, key: string): boolean | null {
  const value = ownValue(target, key);
  return typeof value === "boolean" ? value : null;
}

export function ownNumber(target: object, key: string): number | null {
  const value = ownValue(target, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function ownArray(
  target: object,
  key: string,
): readonly unknown[] | null {
  const value = ownValue(target, key);
  return Array.isArray(value) ? value : null;
}

export function parseResourceName(raw: string): ResourceName | null {
  const trimmed = raw.trim();
  if (!RESOURCE_NAME_RE.test(trimmed)) return null;
  return { [resourceNameBrand]: true, value: trimmed };
}

export function parseE164Phone(raw: string): E164Phone | null {
  const trimmed = raw.trim();
  if (!E164_RE.test(trimmed)) return null;
  return { [e164PhoneBrand]: true, value: trimmed };
}

export function parseEmailAddress(raw: string): EmailAddress | null {
  const lowered = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(lowered)) return null;
  return { [emailAddressBrand]: true, value: lowered };
}

export function parseOrganizationDomain(
  raw: string,
): OrganizationDomain | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  if (cleaned === undefined || !DOMAIN_RE.test(cleaned)) return null;
  return { [organizationDomainBrand]: true, value: cleaned };
}

export function parseContactRevision(raw: string): ContactRevision | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return { [contactRevisionBrand]: true, value: trimmed };
}

export function parsePlanSeal(raw: string): PlanSeal | null {
  const trimmed = raw.trim();
  if (!PLAN_SEAL_RE.test(trimmed)) return null;
  return { [planSealBrand]: true, value: trimmed };
}

export function makePlanSeal(hexDigest: string): PlanSeal {
  return { [planSealBrand]: true, value: `sha256:${hexDigest}` };
}

export function parseChangeLane(raw: string): ChangeLane | null {
  for (const lane of CHANGE_LANES) {
    if (lane === raw) return lane;
  }
  return null;
}

export function parseConfidenceTier(raw: string): ConfidenceTier | null {
  for (const tier of CONFIDENCE_TIERS) {
    if (tier === raw) return tier;
  }
  return null;
}

export function confidenceRank(tier: ConfidenceTier): number {
  if (tier === "high") return 3;
  if (tier === "medium") return 2;
  return 1;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareCodeUnit);
  const parts: string[] = [];
  for (const key of keys) {
    const field: unknown = Reflect.get(value, key);
    if (field === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(field)}`);
  }
  return `{${parts.join(",")}}`;
}

export function isContactOwnedMetadata(
  metadata: FieldMetadata | undefined,
): boolean {
  const type = metadata?.source?.type;
  return type === undefined || type === "CONTACT";
}

export function stripNonContactSource<
  T extends { readonly metadata?: FieldMetadata },
>(items: readonly T[]): readonly T[] {
  return items.filter((item) => isContactOwnedMetadata(item.metadata));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
