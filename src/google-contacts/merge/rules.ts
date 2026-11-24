import type { CountryCode } from "libphonenumber-js/min";
import {
  extractIdentityAnchors,
  findSwitchboardPhones,
  serializeAnchor,
  sharedIndependentAnchors,
} from "../anchors/rules.ts";
import { canonicalJson, compareCodeUnit } from "../domain/rules.ts";
import type {
  ContactBiography,
  ContactName,
  ContactRecord,
  FieldMetadata,
  FieldMetadataSource,
} from "../domain/rules.ts";
import { deduplicatePhoneList } from "../phone/rules.ts";
import type {
  ContactWireFields,
  PlannedMergeCluster,
} from "../plan-types/rules.ts";

export const MERGE_ALLOWLIST_FIELDS: ReadonlySet<string> = new Set([
  "names",
  "phoneNumbers",
  "emailAddresses",
  "addresses",
  "organizations",
  "biographies",
  "urls",
  "birthdays",
  "events",
  "relations",
]);

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

export function primaryContactSource(
  contact: ContactRecord,
): FieldMetadataSource {
  const existing = contact.metadata.sources.find(
    (src) => src.type === "CONTACT",
  );
  if (existing !== undefined) {
    return {
      type: "CONTACT",
      ...(existing.id !== undefined ? { id: existing.id } : {}),
      etag: contact.etag,
    };
  }
  const fallbackId = contact.resourceName.replace(/^people\//, "");
  return { type: "CONTACT", id: fallbackId, etag: contact.etag };
}

function dedupeByCanonical<T extends { readonly metadata?: FieldMetadata }>(
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of stripNonContactSource(items)) {
    const keyObj: Record<string, unknown> = {};
    for (const key of Object.keys(item)) {
      if (key === "metadata") continue;
      keyObj[key] = Reflect.get(item, key);
    }
    const sig = canonicalJson(keyObj).toLowerCase();
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(item);
  }
  return out;
}

const NAME_PARTS = [
  "givenName",
  "middleName",
  "familyName",
  "honorificPrefix",
  "honorificSuffix",
  "phoneticGivenName",
  "phoneticMiddleName",
  "phoneticFamilyName",
] as const;

function hasConflictingNames(
  survivor: ContactRecord,
  duplicate: ContactRecord,
): boolean {
  const survName = stripNonContactSource(survivor.names)[0];
  const dupName = stripNonContactSource(duplicate.names)[0];
  if (survName === undefined || dupName === undefined) return false;
  for (const part of NAME_PARTS) {
    const sVal = (survName[part] ?? "").trim();
    const dVal = (dupName[part] ?? "").trim();
    if (
      sVal.length > 0 &&
      dVal.length > 0 &&
      sVal.toLowerCase() !== dVal.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

function firstNonEmptyNamePart(
  duplicates: readonly ContactRecord[],
  part: "givenName" | "middleName",
): string | undefined {
  for (const dup of duplicates) {
    const val = stripNonContactSource(dup.names)[0]?.[part];
    if (val !== undefined && val.trim().length > 0) return val;
  }
  return undefined;
}

function mergeSurvivorNames(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
): readonly ContactName[] | undefined {
  const baseList = stripNonContactSource(survivor.names);
  const current = baseList[0];
  if (current === undefined) return undefined;
  const givenMissing = (current.givenName ?? "").trim().length === 0;
  const middleMissing = (current.middleName ?? "").trim().length === 0;
  const givenFill = givenMissing
    ? firstNonEmptyNamePart(duplicates, "givenName")
    : undefined;
  const middleFill = middleMissing
    ? firstNonEmptyNamePart(duplicates, "middleName")
    : undefined;
  if (givenFill === undefined && middleFill === undefined) return undefined;
  return [
    {
      ...current,
      ...(givenFill !== undefined ? { givenName: givenFill } : {}),
      ...(middleFill !== undefined ? { middleName: middleFill } : {}),
    },
    ...baseList.slice(1),
  ];
}

export function existingBiographyText(contact: ContactRecord): string {
  const owned = stripNonContactSource(contact.biographies);
  return owned[0]?.value ?? "";
}

export function buildAppendedBiography(
  existing: string,
  line: string,
): { readonly value: string; readonly changed: boolean } {
  const trimmedLine = line.trim();
  const lines = existing
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (lines.includes(trimmedLine)) {
    return { value: existing, changed: false };
  }
  if (existing.length === 0) {
    return { value: trimmedLine, changed: true };
  }
  const separator = existing.endsWith("\n") ? "" : "\n";
  return { value: `${existing}${separator}${trimmedLine}`, changed: true };
}

function buildMergedBiography(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
  provenanceLine: string,
): readonly ContactBiography[] {
  let merged = existingBiographyText(survivor);
  for (const dup of duplicates) {
    const dupBio = existingBiographyText(dup).trim();
    if (dupBio.length > 0) {
      merged = buildAppendedBiography(merged, dupBio).value;
    }
  }
  merged = buildAppendedBiography(merged, provenanceLine).value;
  return [{ value: merged, contentType: "TEXT_PLAIN" }];
}

function validateMergeDuplicates(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
): string | null {
  if (duplicates.length === 0) {
    return "Duplicate merge requires at least one Duplicate contact.";
  }
  const seenIds = new Set<string>([survivor.resourceName]);
  for (const dup of duplicates) {
    if (seenIds.has(dup.resourceName)) {
      return `Self-merge or duplicate target cycle detected on ${dup.resourceName}.`;
    }
    seenIds.add(dup.resourceName);
    if (dup.nonAllowlistedFields.length > 0) {
      return `Duplicate contact ${dup.resourceName} has non-allowlisted fields: ${dup.nonAllowlistedFields.join(", ")}.`;
    }
    if (hasConflictingNames(survivor, dup)) {
      return `Conflicting name parts between survivor ${survivor.resourceName} and duplicate ${dup.resourceName}.`;
    }
  }
  return null;
}

function buildMergedFields(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
  provenanceLine: string,
): ContactWireFields {
  const allPhones = [
    ...stripNonContactSource(survivor.phoneNumbers),
    ...duplicates.flatMap((dup) => stripNonContactSource(dup.phoneNumbers)),
  ];
  const mergedPhones = deduplicatePhoneList(allPhones);
  const mergedEmails = dedupeByCanonical([
    ...survivor.emailAddresses,
    ...duplicates.flatMap((dup) => dup.emailAddresses),
  ]);
  const mergedAddresses = dedupeByCanonical([
    ...survivor.addresses,
    ...duplicates.flatMap((dup) => dup.addresses),
  ]);
  const mergedOrgs = dedupeByCanonical([
    ...survivor.organizations,
    ...duplicates.flatMap((dup) => dup.organizations),
  ]);
  const mergedUrls = dedupeByCanonical([
    ...survivor.urls,
    ...duplicates.flatMap((dup) => dup.urls),
  ]);
  const mergedBirthdays = dedupeByCanonical([
    ...survivor.birthdays,
    ...duplicates.flatMap((dup) => dup.birthdays),
  ]);
  const mergedEvents = dedupeByCanonical([
    ...survivor.events,
    ...duplicates.flatMap((dup) => dup.events),
  ]);
  const mergedRelations = dedupeByCanonical([
    ...survivor.relations,
    ...duplicates.flatMap((dup) => dup.relations),
  ]);
  const mergedNames = mergeSurvivorNames(survivor, duplicates);
  const mergedBiographies = buildMergedBiography(
    survivor,
    duplicates,
    provenanceLine,
  );
  return {
    ...(mergedNames !== undefined ? { names: mergedNames } : {}),
    ...(mergedPhones.length > 0 ? { phoneNumbers: mergedPhones } : {}),
    ...(mergedEmails.length > 0 ? { emailAddresses: mergedEmails } : {}),
    ...(mergedAddresses.length > 0 ? { addresses: mergedAddresses } : {}),
    ...(mergedOrgs.length > 0 ? { organizations: mergedOrgs } : {}),
    biographies: mergedBiographies,
    ...(mergedUrls.length > 0 ? { urls: mergedUrls } : {}),
    ...(mergedBirthdays.length > 0 ? { birthdays: mergedBirthdays } : {}),
    ...(mergedEvents.length > 0 ? { events: mergedEvents } : {}),
    ...(mergedRelations.length > 0 ? { relations: mergedRelations } : {}),
  };
}

export type MergeComputationResult =
  | {
      readonly ok: true;
      readonly cluster: PlannedMergeCluster;
      readonly survivorFields: ContactWireFields;
      readonly existingBiography: string;
    }
  | { readonly ok: false; readonly reason: string };

export function computeDuplicateMerge(params: {
  readonly survivor: ContactRecord;
  readonly duplicates: readonly ContactRecord[];
  readonly allContacts: readonly ContactRecord[];
  readonly defaultRegion: CountryCode;
  readonly humanConfirmed: boolean;
  readonly reason: string | null;
}): MergeComputationResult {
  const validationError = validateMergeDuplicates(
    params.survivor,
    params.duplicates,
  );
  if (validationError !== null) return { ok: false, reason: validationError };
  const switchboards = findSwitchboardPhones(
    params.allContacts,
    params.defaultRegion,
  );
  const survAnchors = extractIdentityAnchors(
    params.survivor,
    params.defaultRegion,
    switchboards,
  );
  const sharedAll = params.duplicates.map((dup) =>
    sharedIndependentAnchors(
      survAnchors,
      extractIdentityAnchors(dup, params.defaultRegion, switchboards),
    ),
  );
  const corroboratedByAnchors = sharedAll.every((items) => items.length >= 2);
  if (!corroboratedByAnchors && !params.humanConfirmed) {
    return {
      ok: false,
      reason:
        "Duplicate merge requires at least 2 independent Identity anchors per duplicate or an explicit Human confirmation marker.",
    };
  }
  const trimmedReason = (params.reason ?? "").trim();
  if (!corroboratedByAnchors && trimmedReason.length === 0) {
    return {
      ok: false,
      reason: "Human confirmation marker requires a non-empty reason.",
    };
  }
  const dupIds = params.duplicates
    .map((dup) => dup.resourceName)
    .sort(compareCodeUnit);
  const provenanceLine = `[merged-from] ${dupIds.join(", ")}`;
  const firstShared = sharedAll[0] ?? [];
  return {
    ok: true,
    cluster: {
      survivor: params.survivor.resourceName,
      expectedSurvivorRevision: params.survivor.etag,
      duplicates: params.duplicates.map((dup) => ({
        resourceName: dup.resourceName,
        expectedRevision: dup.etag,
        nonAllowlistedFields: dup.nonAllowlistedFields,
      })),
      corroboration: corroboratedByAnchors
        ? { kind: "anchors", anchors: firstShared.map(serializeAnchor) }
        : { kind: "human-confirmed", note: trimmedReason },
      provenanceLine,
      hasConflictingNames: false,
    },
    survivorFields: buildMergedFields(
      params.survivor,
      params.duplicates,
      provenanceLine,
    ),
    existingBiography: existingBiographyText(params.survivor),
  };
}
