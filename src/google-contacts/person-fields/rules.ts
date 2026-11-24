import {
  asObject,
  canonicalJson,
  ownNumber,
  ownString,
  ownValue,
} from "../domain/rules.ts";
import type {
  ContactAddress,
  ContactBiography,
  ContactBirthday,
  ContactDate,
  ContactEmail,
  ContactEvent,
  ContactName,
  ContactOrganization,
  ContactPhone,
  ContactRecord,
  ContactRelation,
  ContactUrl,
  FieldMetadata,
  FieldMetadataSource,
} from "../domain/rules.ts";

export type ContactListField =
  | "names"
  | "phoneNumbers"
  | "emailAddresses"
  | "addresses"
  | "organizations"
  | "biographies"
  | "urls"
  | "birthdays"
  | "events"
  | "relations";

const OUTPUT_ONLY_SUBFIELDS: {
  readonly [K in ContactListField]: ReadonlySet<string>;
} = {
  names: new Set(["displayName", "displayNameLastFirst"]),
  phoneNumbers: new Set(["canonicalForm", "formattedType"]),
  emailAddresses: new Set(["formattedType"]),
  addresses: new Set(["formattedType"]),
  organizations: new Set(["formattedType"]),
  biographies: new Set(),
  urls: new Set(["formattedType"]),
  birthdays: new Set(),
  events: new Set(["formattedType"]),
  relations: new Set(["formattedType"]),
};

const NAME_KEYS = [
  "displayName",
  "displayNameLastFirst",
  "unstructuredName",
  "givenName",
  "middleName",
  "familyName",
  "honorificPrefix",
  "honorificSuffix",
  "phoneticFullName",
  "phoneticGivenName",
  "phoneticMiddleName",
  "phoneticFamilyName",
  "phoneticHonorificPrefix",
  "phoneticHonorificSuffix",
] as const;

const PHONE_OPTIONAL_KEYS = ["canonicalForm", "type", "formattedType"] as const;

const EMAIL_OPTIONAL_KEYS = ["displayName", "type", "formattedType"] as const;

const ADDRESS_KEYS = [
  "formattedValue",
  "poBox",
  "streetAddress",
  "extendedAddress",
  "city",
  "region",
  "postalCode",
  "country",
  "countryCode",
  "type",
  "formattedType",
] as const;

const ORG_STRING_KEYS = [
  "name",
  "phoneticName",
  "title",
  "jobDescription",
  "department",
  "symbol",
  "domain",
  "location",
  "costCenter",
  "type",
  "formattedType",
] as const;

const ORG_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "metadata",
  ...ORG_STRING_KEYS,
  "fullTimeEquivalentMillipercent",
  "current",
  "startDate",
  "endDate",
]);

const BIOGRAPHY_OPTIONAL_KEYS = ["contentType"] as const;
const URL_OPTIONAL_KEYS = ["type", "formattedType"] as const;
const BIRTHDAY_STRING_KEYS = ["text"] as const;
const EVENT_STRING_KEYS = ["type", "formattedType"] as const;
const RELATION_OPTIONAL_KEYS = ["type", "formattedType"] as const;
const RELATION_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "metadata",
  "person",
  ...RELATION_OPTIONAL_KEYS,
]);

const DATE_KEYS = ["year", "month", "day"] as const;
const DATE_KEY_SET: ReadonlySet<string> = new Set(DATE_KEYS);
const SOURCE_KEYS = ["type", "id", "etag", "updateTime"] as const;
const SOURCE_KEY_SET: ReadonlySet<string> = new Set(SOURCE_KEYS);
const METADATA_BOOL_KEYS = ["primary", "sourcePrimary", "verified"] as const;
const METADATA_KEY_SET: ReadonlySet<string> = new Set([
  ...METADATA_BOOL_KEYS,
  "source",
]);

export function writableSubfieldKeys(
  field: ContactListField,
  entry: object,
): readonly string[] {
  const outputOnly = OUTPUT_ONLY_SUBFIELDS[field];
  return Object.keys(entry).filter(
    (key) => key !== "metadata" && !outputOnly.has(key),
  );
}

const WRITABLE_METADATA_FLAGS = ["sourcePrimary"] as const;

export function entryIdentity(field: ContactListField, entry: object): string {
  const kept: Record<string, unknown> = {};
  for (const key of writableSubfieldKeys(field, entry)) {
    kept[key] = ownValue(entry, key);
  }
  const metadata = asObject(ownValue(entry, "metadata"));
  for (const flag of WRITABLE_METADATA_FLAGS) {
    if (metadata !== null && ownValue(metadata, flag) === true) {
      kept[`metadata.${flag}`] = true;
    }
  }
  return canonicalJson(kept);
}

function attachUnmodelled<T extends object>(
  decoded: T,
  source: object,
  knownKeys: ReadonlySet<string>,
): T {
  for (const key of Object.keys(source)) {
    if (!knownKeys.has(key)) {
      Object.defineProperty(decoded, key, {
        value: ownValue(source, key),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return decoded;
}

function decodeOptionalStrings<K extends string>(
  obj: object,
  keys: readonly K[],
): Partial<Record<K, string>> | null {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    if (!Object.hasOwn(obj, key)) continue;
    const value = ownValue(obj, key);
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

function decodeContactDate(value: unknown): ContactDate | null {
  const obj = asObject(value);
  if (obj === null) return null;
  const out: { year?: number; month?: number; day?: number } = {};
  for (const key of DATE_KEYS) {
    const part = ownValue(obj, key);
    if (part === undefined) continue;
    const num = ownNumber(obj, key);
    if (num === null) return null;
    out[key] = num;
  }
  return attachUnmodelled(out, obj, DATE_KEY_SET);
}

function decodeOptionalDate(
  obj: object,
  key: string,
): { readonly ok: true; readonly date?: ContactDate } | { readonly ok: false } {
  if (!Object.hasOwn(obj, key)) return { ok: true };
  const date = decodeContactDate(ownValue(obj, key));
  return date === null ? { ok: false } : { ok: true, date };
}

function decodeFieldMetadataSource(
  raw: unknown,
): Partial<FieldMetadataSource> | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const out: Partial<Record<(typeof SOURCE_KEYS)[number], string>> = {};
  for (const key of SOURCE_KEYS) {
    const value = ownValue(obj, key);
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return attachUnmodelled(out, obj, SOURCE_KEY_SET);
}

function decodeFieldMetadata(raw: unknown): FieldMetadata | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const flags: Partial<Record<(typeof METADATA_BOOL_KEYS)[number], boolean>> =
    {};
  for (const key of METADATA_BOOL_KEYS) {
    const value = ownValue(obj, key);
    if (value === undefined) continue;
    if (typeof value !== "boolean") return null;
    flags[key] = value;
  }
  const rawSource = ownValue(obj, "source");
  if (rawSource === undefined) {
    return attachUnmodelled({ ...flags }, obj, METADATA_KEY_SET);
  }
  const source = decodeFieldMetadataSource(rawSource);
  if (source === null) return null;
  return attachUnmodelled({ ...flags, source }, obj, METADATA_KEY_SET);
}

function decodeEntryMetadata(
  obj: object,
):
  | { readonly ok: true; readonly metadata?: FieldMetadata }
  | { readonly ok: false } {
  if (!Object.hasOwn(obj, "metadata")) return { ok: true };
  const metadata = decodeFieldMetadata(ownValue(obj, "metadata"));
  return metadata === null ? { ok: false } : { ok: true, metadata };
}

function decodeStringEntry<K extends string>(
  raw: unknown,
  keys: readonly K[],
): (Partial<Record<K, string>> & { readonly metadata?: FieldMetadata }) | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const strings = decodeOptionalStrings(obj, keys);
  const meta = decodeEntryMetadata(obj);
  if (strings === null || !meta.ok) return null;
  const decoded = {
    ...strings,
    ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
  };
  return attachUnmodelled(decoded, obj, new Set(["metadata", ...keys]));
}

function decodeValueEntry<K extends string>(
  raw: unknown,
  optionalKeys: readonly K[],
):
  | ({ readonly value: string; readonly metadata?: FieldMetadata } & Partial<
      Record<K, string>
    >)
  | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const value = ownString(obj, "value");
  const rest = decodeOptionalStrings(obj, optionalKeys);
  const meta = decodeEntryMetadata(obj);
  if (value === null || rest === null || !meta.ok) return null;
  const decoded = {
    value,
    ...rest,
    ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
  };
  return attachUnmodelled(
    decoded,
    obj,
    new Set(["metadata", "value", ...optionalKeys]),
  );
}

function decodeDatedEntry<K extends string>(
  raw: unknown,
  stringKeys: readonly K[],
):
  | (Partial<Record<K, string>> & {
      readonly date?: ContactDate;
      readonly metadata?: FieldMetadata;
    })
  | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const strings = decodeOptionalStrings(obj, stringKeys);
  const date = decodeOptionalDate(obj, "date");
  const meta = decodeEntryMetadata(obj);
  if (strings === null || !date.ok || !meta.ok) return null;
  const decoded = {
    ...strings,
    ...(date.date !== undefined ? { date: date.date } : {}),
    ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
  };
  return attachUnmodelled(
    decoded,
    obj,
    new Set(["metadata", "date", ...stringKeys]),
  );
}

function decodeName(raw: unknown): ContactName | null {
  return decodeStringEntry(raw, NAME_KEYS);
}

export function decodePhone(raw: unknown): ContactPhone | null {
  return decodeValueEntry(raw, PHONE_OPTIONAL_KEYS);
}

function decodeEmail(raw: unknown): ContactEmail | null {
  return decodeValueEntry(raw, EMAIL_OPTIONAL_KEYS);
}

function decodeAddress(raw: unknown): ContactAddress | null {
  return decodeStringEntry(raw, ADDRESS_KEYS);
}

function decodeOrganization(raw: unknown): ContactOrganization | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const strings = decodeOptionalStrings(obj, ORG_STRING_KEYS);
  const startDate = decodeOptionalDate(obj, "startDate");
  const endDate = decodeOptionalDate(obj, "endDate");
  const meta = decodeEntryMetadata(obj);
  if (strings === null || !startDate.ok || !endDate.ok || !meta.ok) return null;
  const hasFte = Object.hasOwn(obj, "fullTimeEquivalentMillipercent");
  const fte = hasFte ? ownNumber(obj, "fullTimeEquivalentMillipercent") : null;
  if (hasFte && fte === null) return null;
  const hasCurrent = Object.hasOwn(obj, "current");
  const rawCurrent = hasCurrent ? ownValue(obj, "current") : undefined;
  if (hasCurrent && typeof rawCurrent !== "boolean") return null;
  const decoded: ContactOrganization = {
    ...strings,
    ...(fte !== null ? { fullTimeEquivalentMillipercent: fte } : {}),
    ...(typeof rawCurrent === "boolean" ? { current: rawCurrent } : {}),
    ...(startDate.date !== undefined ? { startDate: startDate.date } : {}),
    ...(endDate.date !== undefined ? { endDate: endDate.date } : {}),
    ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
  };
  return attachUnmodelled(decoded, obj, ORG_KNOWN_KEYS);
}

function decodeBiography(raw: unknown): ContactBiography | null {
  return decodeValueEntry(raw, BIOGRAPHY_OPTIONAL_KEYS);
}

function decodeUrl(raw: unknown): ContactUrl | null {
  return decodeValueEntry(raw, URL_OPTIONAL_KEYS);
}

function decodeBirthday(raw: unknown): ContactBirthday | null {
  return decodeDatedEntry(raw, BIRTHDAY_STRING_KEYS);
}

function decodeEvent(raw: unknown): ContactEvent | null {
  return decodeDatedEntry(raw, EVENT_STRING_KEYS);
}

function decodeRelation(raw: unknown): ContactRelation | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const person = ownString(obj, "person");
  const rest = decodeOptionalStrings(obj, RELATION_OPTIONAL_KEYS);
  const meta = decodeEntryMetadata(obj);
  if (person === null || rest === null || !meta.ok) return null;
  const decoded: ContactRelation = {
    person,
    ...rest,
    ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
  };
  return attachUnmodelled(decoded, obj, RELATION_KNOWN_KEYS);
}

function decodeEntryList<T>(
  raw: unknown,
  itemDecoder: (entry: unknown) => T | null,
): readonly T[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const item of raw) {
    const decoded = itemDecoder(item);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

export function decodeRecordLists(
  obj: object,
): Pick<ContactRecord, ContactListField> | null {
  const names = decodeEntryList(ownValue(obj, "names"), decodeName);
  const phoneNumbers = decodeEntryList(
    ownValue(obj, "phoneNumbers"),
    decodePhone,
  );
  const emailAddresses = decodeEntryList(
    ownValue(obj, "emailAddresses"),
    decodeEmail,
  );
  const addresses = decodeEntryList(ownValue(obj, "addresses"), decodeAddress);
  const organizations = decodeEntryList(
    ownValue(obj, "organizations"),
    decodeOrganization,
  );
  const biographies = decodeEntryList(
    ownValue(obj, "biographies"),
    decodeBiography,
  );
  const urls = decodeEntryList(ownValue(obj, "urls"), decodeUrl);
  const birthdays = decodeEntryList(ownValue(obj, "birthdays"), decodeBirthday);
  const events = decodeEntryList(ownValue(obj, "events"), decodeEvent);
  const relations = decodeEntryList(ownValue(obj, "relations"), decodeRelation);
  if (
    names === null ||
    phoneNumbers === null ||
    emailAddresses === null ||
    addresses === null ||
    organizations === null ||
    biographies === null ||
    urls === null ||
    birthdays === null ||
    events === null ||
    relations === null
  ) {
    return null;
  }
  return {
    names,
    phoneNumbers,
    emailAddresses,
    addresses,
    organizations,
    biographies,
    urls,
    birthdays,
    events,
    relations,
  };
}
