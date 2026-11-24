import type { CountryCode } from "libphonenumber-js/min";
import {
  extractIdentityAnchors,
  findSwitchboardPhones,
  serializeAnchor,
  sharedIndependentAnchors,
} from "../anchors/rules.ts";
import {
  compareCodeUnit,
  parseContactRevision,
  parseResourceName,
  stripNonContactSource,
} from "../domain/rules.ts";
import type {
  ContactBiography,
  ContactRecord,
  ContactRevision,
  CorroboratedAnchors,
  FieldMetadata,
  FieldMetadataSource,
  IdentityAnchor,
  ResourceName,
} from "../domain/rules.ts";
import { entryIdentity } from "../person-fields/rules.ts";
import type { ContactListField } from "../person-fields/rules.ts";
import {
  hasConflictingNames,
  mergedNameConflicts,
  mergeSurvivorNames,
} from "../merge-names/rules.ts";
import { deduplicatePhoneList } from "../phone/rules.ts";
import type {
  ContactWireFields,
  PlannedMergeCluster,
} from "../plan-types/rules.ts";

export type DuplicateMergePatch = {
  readonly lane: "duplicate-merge";
  readonly survivor: ResourceName;
  readonly expectedSurvivorRevision: ContactRevision;
  readonly duplicates: readonly [
    {
      readonly target: ResourceName;
      readonly expectedRevision: ContactRevision;
    },
    ...{
      readonly target: ResourceName;
      readonly expectedRevision: ContactRevision;
    }[],
  ];
  readonly corroboration:
    | { readonly kind: "anchors"; readonly anchors: CorroboratedAnchors }
    | { readonly kind: "human-confirmed"; readonly note: string };
};

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

function dedupeByIdentity<T extends { readonly metadata?: FieldMetadata }>(
  field: ContactListField,
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of stripNonContactSource(items)) {
    const valueOnly = Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== "metadata"),
    );
    const sig = entryIdentity(field, valueOnly).toLowerCase();
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(item);
  }
  return out;
}

export function existingBiographyText(contact: ContactRecord): string {
  const owned = stripNonContactSource(contact.biographies);
  return owned[0]?.value ?? "";
}

export function biographyEntryWithValue(
  contacts: readonly ContactRecord[],
  value: string,
): ContactBiography {
  const existing = contacts
    .map((contact) => stripNonContactSource(contact.biographies)[0])
    .find((entry) => entry !== undefined);
  return existing !== undefined
    ? { ...existing, value }
    : { value, contentType: "TEXT_PLAIN" };
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
  return [biographyEntryWithValue([survivor, ...duplicates], merged)];
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
  return mergedNameConflicts(survivor, duplicates);
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
  const mergedEmails = dedupeByIdentity("emailAddresses", [
    ...survivor.emailAddresses,
    ...duplicates.flatMap((dup) => dup.emailAddresses),
  ]);
  const mergedAddresses = dedupeByIdentity("addresses", [
    ...survivor.addresses,
    ...duplicates.flatMap((dup) => dup.addresses),
  ]);
  const mergedOrgs = dedupeByIdentity("organizations", [
    ...survivor.organizations,
    ...duplicates.flatMap((dup) => dup.organizations),
  ]);
  const mergedUrls = dedupeByIdentity("urls", [
    ...survivor.urls,
    ...duplicates.flatMap((dup) => dup.urls),
  ]);
  const mergedBirthdays = dedupeByIdentity("birthdays", [
    ...survivor.birthdays,
    ...duplicates.flatMap((dup) => dup.birthdays),
  ]);
  const mergedEvents = dedupeByIdentity("events", [
    ...survivor.events,
    ...duplicates.flatMap((dup) => dup.events),
  ]);
  const mergedRelations = dedupeByIdentity("relations", [
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

function buildTypedMergePatch(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
  corroboration:
    | { readonly kind: "anchors"; readonly anchors: readonly IdentityAnchor[] }
    | { readonly kind: "human-confirmed"; readonly note: string },
): DuplicateMergePatch | null {
  const survRn = parseResourceName(survivor.resourceName);
  const survRev = parseContactRevision(survivor.etag);
  if (survRn === null || survRev === null) return null;
  const parsedDups: {
    readonly target: ResourceName;
    readonly expectedRevision: ContactRevision;
  }[] = [];
  for (const dup of duplicates) {
    const rn = parseResourceName(dup.resourceName);
    const rev = parseContactRevision(dup.etag);
    if (rn === null || rev === null) return null;
    parsedDups.push({ target: rn, expectedRevision: rev });
  }
  const firstDup = parsedDups[0];
  if (firstDup === undefined) return null;
  if (corroboration.kind === "anchors") {
    const firstAnchor = corroboration.anchors[0];
    const secondAnchor = corroboration.anchors[1];
    if (firstAnchor === undefined || secondAnchor === undefined) return null;
    return {
      lane: "duplicate-merge",
      survivor: survRn,
      expectedSurvivorRevision: survRev,
      duplicates: [firstDup, ...parsedDups.slice(1)],
      corroboration: {
        kind: "anchors",
        anchors: [firstAnchor, secondAnchor, ...corroboration.anchors.slice(2)],
      },
    };
  }
  return {
    lane: "duplicate-merge",
    survivor: survRn,
    expectedSurvivorRevision: survRev,
    duplicates: [firstDup, ...parsedDups.slice(1)],
    corroboration,
  };
}

function mergeProvenanceLine(duplicateNames: readonly string[]): string {
  return `[merged-from] ${[...duplicateNames].sort(compareCodeUnit).join(", ")}`;
}

export function deriveMergedSurvivorFields(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
):
  | {
      readonly ok: true;
      readonly fields: ContactWireFields;
      readonly provenanceLine: string;
    }
  | { readonly ok: false; readonly reason: string } {
  const validationError = validateMergeDuplicates(survivor, duplicates);
  if (validationError !== null) return { ok: false, reason: validationError };
  const provenanceLine = mergeProvenanceLine(
    duplicates.map((dup) => dup.resourceName),
  );
  return {
    ok: true,
    fields: buildMergedFields(survivor, duplicates, provenanceLine),
    provenanceLine,
  };
}

export type MergeComputationResult =
  | {
      readonly ok: true;
      readonly patch: DuplicateMergePatch;
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
  const provenanceLine = mergeProvenanceLine(
    params.duplicates.map((dup) => dup.resourceName),
  );
  const firstShared = sharedAll[0] ?? [];
  const patch = buildTypedMergePatch(
    params.survivor,
    params.duplicates,
    corroboratedByAnchors
      ? { kind: "anchors", anchors: firstShared }
      : { kind: "human-confirmed", note: trimmedReason },
  );
  if (patch === null) {
    return { ok: false, reason: "Invalid resourceName or revision in merge." };
  }
  return {
    ok: true,
    patch,
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
