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
  ContactEmail,
  ContactEvent,
  ContactName,
  ContactOrganization,
  ContactPhone,
  ContactRecord,
  ContactRelation,
  ContactUrl,
} from "../domain/rules.ts";

type SubfieldKind = "string" | "boolean" | "number" | "date";

type EntryKey<T> = Exclude<keyof T, "metadata"> & string;

type EntrySchema<T> = {
  readonly required: readonly EntryKey<T>[];
  readonly outputOnly: readonly EntryKey<T>[];
  readonly subfields: { readonly [K in EntryKey<T>]-?: SubfieldKind };
};

const NAME_SCHEMA: EntrySchema<ContactName> = {
  required: [],
  outputOnly: ["displayName", "displayNameLastFirst"],
  subfields: {
    displayName: "string",
    displayNameLastFirst: "string",
    unstructuredName: "string",
    givenName: "string",
    middleName: "string",
    familyName: "string",
    honorificPrefix: "string",
    honorificSuffix: "string",
    phoneticFullName: "string",
    phoneticGivenName: "string",
    phoneticMiddleName: "string",
    phoneticFamilyName: "string",
    phoneticHonorificPrefix: "string",
    phoneticHonorificSuffix: "string",
  },
};

const PHONE_SCHEMA: EntrySchema<ContactPhone> = {
  required: ["value"],
  outputOnly: ["canonicalForm", "formattedType"],
  subfields: {
    value: "string",
    canonicalForm: "string",
    type: "string",
    formattedType: "string",
  },
};

const EMAIL_SCHEMA: EntrySchema<ContactEmail> = {
  required: ["value"],
  outputOnly: ["formattedType"],
  subfields: {
    value: "string",
    displayName: "string",
    type: "string",
    formattedType: "string",
  },
};

const ADDRESS_SCHEMA: EntrySchema<ContactAddress> = {
  required: [],
  outputOnly: ["formattedType"],
  subfields: {
    formattedValue: "string",
    poBox: "string",
    streetAddress: "string",
    extendedAddress: "string",
    city: "string",
    region: "string",
    postalCode: "string",
    country: "string",
    countryCode: "string",
    type: "string",
    formattedType: "string",
  },
};

const ORGANIZATION_SCHEMA: EntrySchema<ContactOrganization> = {
  required: [],
  outputOnly: ["formattedType"],
  subfields: {
    name: "string",
    phoneticName: "string",
    title: "string",
    jobDescription: "string",
    department: "string",
    symbol: "string",
    domain: "string",
    location: "string",
    costCenter: "string",
    fullTimeEquivalentMillipercent: "number",
    current: "boolean",
    startDate: "date",
    endDate: "date",
    type: "string",
    formattedType: "string",
  },
};

const BIOGRAPHY_SCHEMA: EntrySchema<ContactBiography> = {
  required: ["value"],
  outputOnly: [],
  subfields: { value: "string", contentType: "string" },
};

const URL_SCHEMA: EntrySchema<ContactUrl> = {
  required: ["value"],
  outputOnly: ["formattedType"],
  subfields: { value: "string", type: "string", formattedType: "string" },
};

const BIRTHDAY_SCHEMA: EntrySchema<ContactBirthday> = {
  required: [],
  outputOnly: [],
  subfields: { text: "string", date: "date" },
};

const EVENT_SCHEMA: EntrySchema<ContactEvent> = {
  required: [],
  outputOnly: ["formattedType"],
  subfields: { type: "string", formattedType: "string", date: "date" },
};

const RELATION_SCHEMA: EntrySchema<ContactRelation> = {
  required: ["person"],
  outputOnly: ["formattedType"],
  subfields: { person: "string", type: "string", formattedType: "string" },
};

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
  names: new Set(NAME_SCHEMA.outputOnly),
  phoneNumbers: new Set(PHONE_SCHEMA.outputOnly),
  emailAddresses: new Set(EMAIL_SCHEMA.outputOnly),
  addresses: new Set(ADDRESS_SCHEMA.outputOnly),
  organizations: new Set(ORGANIZATION_SCHEMA.outputOnly),
  biographies: new Set(BIOGRAPHY_SCHEMA.outputOnly),
  urls: new Set(URL_SCHEMA.outputOnly),
  birthdays: new Set(BIRTHDAY_SCHEMA.outputOnly),
  events: new Set(EVENT_SCHEMA.outputOnly),
  relations: new Set(RELATION_SCHEMA.outputOnly),
};

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

function isOptionalString(obj: object, key: string): boolean {
  const value = ownValue(obj, key);
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(obj: object, key: string): boolean {
  const value = ownValue(obj, key);
  return value === undefined || typeof value === "boolean";
}

function isDateValue(value: unknown): boolean {
  const obj = asObject(value);
  if (obj === null) return false;
  return ["year", "month", "day"].every((key) => {
    const part = ownValue(obj, key);
    return part === undefined || ownNumber(obj, key) !== null;
  });
}

function isFieldMetadataValue(value: unknown): boolean {
  const obj = asObject(value);
  if (obj === null) return false;
  if (
    !["primary", "sourcePrimary", "verified"].every((key) =>
      isOptionalBoolean(obj, key),
    )
  ) {
    return false;
  }
  const source = ownValue(obj, "source");
  if (source === undefined) return true;
  const sourceObj = asObject(source);
  return (
    sourceObj !== null &&
    ["type", "id", "etag", "updateTime"].every((key) =>
      isOptionalString(sourceObj, key),
    )
  );
}

function matchesSubfieldKind(kind: SubfieldKind, value: unknown): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return isDateValue(value);
}

function subfieldKindOf<T>(
  schema: EntrySchema<T>,
  key: string,
): SubfieldKind | undefined {
  const kind: unknown = ownValue(schema.subfields, key);
  return kind === "string" ||
    kind === "boolean" ||
    kind === "number" ||
    kind === "date"
    ? kind
    : undefined;
}

function entryMatchesSchema<T extends object>(
  entry: object,
  schema: EntrySchema<T>,
): entry is T {
  for (const key of Object.keys(entry)) {
    const value = ownValue(entry, key);
    if (key === "metadata") {
      if (!isFieldMetadataValue(value)) return false;
      continue;
    }
    const kind = subfieldKindOf(schema, key);
    if (kind !== undefined && !matchesSubfieldKind(kind, value)) return false;
  }
  return schema.required.every((key) => ownString(entry, key) !== null);
}

function decodeEntry<T extends object>(
  raw: unknown,
  schema: EntrySchema<T>,
): T | null {
  const obj = asObject(raw);
  return obj !== null && entryMatchesSchema(obj, schema) ? obj : null;
}

function decodeName(raw: unknown): ContactName | null {
  return decodeEntry(raw, NAME_SCHEMA);
}

export function decodePhone(raw: unknown): ContactPhone | null {
  return decodeEntry(raw, PHONE_SCHEMA);
}

function decodeEmail(raw: unknown): ContactEmail | null {
  return decodeEntry(raw, EMAIL_SCHEMA);
}

function decodeAddress(raw: unknown): ContactAddress | null {
  return decodeEntry(raw, ADDRESS_SCHEMA);
}

function decodeOrganization(raw: unknown): ContactOrganization | null {
  return decodeEntry(raw, ORGANIZATION_SCHEMA);
}

function decodeBiography(raw: unknown): ContactBiography | null {
  return decodeEntry(raw, BIOGRAPHY_SCHEMA);
}

function decodeUrl(raw: unknown): ContactUrl | null {
  return decodeEntry(raw, URL_SCHEMA);
}

function decodeBirthday(raw: unknown): ContactBirthday | null {
  return decodeEntry(raw, BIRTHDAY_SCHEMA);
}

function decodeEvent(raw: unknown): ContactEvent | null {
  return decodeEntry(raw, EVENT_SCHEMA);
}

function decodeRelation(raw: unknown): ContactRelation | null {
  return decodeEntry(raw, RELATION_SCHEMA);
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
