import {
  asObject,
  compareCodeUnit,
  ownArray,
  ownBoolean,
  ownString,
  ownValue,
  parseContactRevision,
  parseEmailAddress,
  parseResourceName,
} from "../domain/rules.ts";
import type {
  ContactRecord,
  ContactSnapshotDoc,
  FieldMetadataSource,
} from "../domain/rules.ts";
import { decodeRecordLists } from "../person-fields/rules.ts";

const STANDARD_CONTACT_KEYS = new Set([
  "resourceName",
  "etag",
  "metadata",
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
  "nonAllowlistedFields",
  "updatedAt",
]);

export function unwrapEnvelopePayload(raw: unknown): unknown {
  const obj = asObject(raw);
  if (obj === null) return raw;
  const result = asObject(ownValue(obj, "result"));
  if (result === null) return raw;
  const data = ownValue(result, "data");
  return data !== undefined ? data : raw;
}

export function decodeSource(raw: unknown): FieldMetadataSource | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const type = ownString(obj, "type");
  if (type === null || type.trim().length === 0) return null;
  const id = ownString(obj, "id");
  const etag = ownString(obj, "etag");
  const updateTime = ownString(obj, "updateTime");
  return {
    type,
    ...(id !== null ? { id } : {}),
    ...(etag !== null ? { etag } : {}),
    ...(updateTime !== null ? { updateTime } : {}),
  };
}

export function decodeStringFields(
  obj: object,
  keys: readonly string[],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of keys) {
    const val = ownString(obj, key);
    if (val !== null) fields[key] = val;
  }
  return fields;
}

export function decodeList<T>(
  raw: unknown,
  itemDecoder: (entry: unknown) => T | null,
): readonly T[] {
  if (!Array.isArray(raw)) return [];
  const items: T[] = [];
  for (const entry of raw) {
    const decoded = itemDecoder(entry);
    if (decoded !== null) items.push(decoded);
  }
  return items;
}

export function decodeStringList(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    list.push(item);
  }
  return list;
}

export function decodeStrictList<T>(
  raw: readonly unknown[] | null,
  decoder: (item: unknown) => T | null,
): readonly T[] | null {
  if (raw === null) return null;
  const out: T[] = [];
  for (const item of raw) {
    const decoded = decoder(item);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

function isContactSourceItem(entry: unknown): boolean {
  const obj = asObject(entry);
  if (obj === null) return true;
  const metadata = asObject(ownValue(obj, "metadata"));
  if (metadata === null) return true;
  const source = asObject(ownValue(metadata, "source"));
  if (source === null) return true;
  const type = ownString(source, "type");
  return type === null || type === "CONTACT";
}

function isNonDefaultPhoto(entry: unknown): boolean {
  const obj = asObject(entry);
  return (
    obj !== null &&
    isContactSourceItem(obj) &&
    ownBoolean(obj, "default") !== true
  );
}

function isNonDefaultMembership(entry: unknown): boolean {
  const obj = asObject(entry);
  if (obj === null || !isContactSourceItem(obj)) return false;
  const group = asObject(ownValue(obj, "contactGroupMembership"));
  if (group === null) return true;
  const groupId = ownString(group, "contactGroupId");
  const groupResource = ownString(group, "contactGroupResourceName");
  return (
    groupId !== "myContacts" && groupResource !== "contactGroups/myContacts"
  );
}

function hasNonAllowlistedContent(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    if (key === "photos") return value.some(isNonDefaultPhoto);
    if (key === "memberships") return value.some(isNonDefaultMembership);
    return value.some(isContactSourceItem);
  }
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "object";
}

function collectNonAllowlistedFields(obj: object): readonly string[] {
  const found = new Set<string>();
  const existing = ownArray(obj, "nonAllowlistedFields");
  if (existing !== null) {
    for (const item of existing) {
      if (typeof item === "string" && item.trim().length > 0) {
        found.add(item.trim());
      }
    }
  }
  for (const key of Object.keys(obj)) {
    if (STANDARD_CONTACT_KEYS.has(key)) continue;
    if (hasNonAllowlistedContent(key, ownValue(obj, key))) found.add(key);
  }
  return [...found].sort(compareCodeUnit);
}

export function decodeContactRecord(raw: unknown): ContactRecord | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const resourceRaw = ownString(obj, "resourceName");
  const etagRaw = ownString(obj, "etag");
  if (resourceRaw === null || etagRaw === null) return null;
  const resource = parseResourceName(resourceRaw);
  const revision = parseContactRevision(etagRaw);
  const lists = decodeRecordLists(obj);
  if (resource === null || revision === null || lists === null) return null;
  const metaObj = asObject(ownValue(obj, "metadata"));
  const sources =
    metaObj !== null
      ? decodeList(ownValue(metaObj, "sources"), decodeSource)
      : [];
  const contactSource = sources.find((src) => src.type === "CONTACT");
  const updatedAt =
    ownString(obj, "updatedAt") ?? contactSource?.updateTime ?? null;
  return {
    resourceName: resource.value,
    etag: revision.value,
    metadata: { sources },
    ...lists,
    nonAllowlistedFields: collectNonAllowlistedFields(obj),
    updatedAt,
  };
}

export function decodeSnapshotDoc(raw: unknown): ContactSnapshotDoc | null {
  const obj = asObject(unwrapEnvelopePayload(raw));
  if (obj === null) return null;
  if (ownString(obj, "schemaVersion") !== "contacts-snapshot/1") return null;
  const accountRaw = ownString(obj, "account");
  const capturedAt = ownString(obj, "capturedAt");
  const contacts = decodeStrictList(
    ownArray(obj, "contacts"),
    decodeContactRecord,
  );
  if (accountRaw === null || capturedAt === null || contacts === null) {
    return null;
  }
  const account = parseEmailAddress(accountRaw);
  if (account === null) return null;
  const rawMissing = ownValue(obj, "missingContacts");
  const missingContacts =
    rawMissing === undefined ? [] : decodeStringList(rawMissing);
  if (missingContacts === null) return null;
  return {
    schemaVersion: "contacts-snapshot/1",
    account: account.value,
    capturedAt,
    contacts,
    missingContacts,
  };
}
