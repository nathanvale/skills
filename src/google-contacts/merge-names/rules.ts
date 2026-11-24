import { stripNonContactSource } from "../domain/rules.ts";
import type { ContactName, ContactRecord } from "../domain/rules.ts";
import { entryIdentity, writableSubfieldKeys } from "../person-fields/rules.ts";

function ownedName(contact: ContactRecord): ContactName | undefined {
  return stripNonContactSource(contact.names)[0];
}

function namePart(name: ContactName, key: string): string {
  const value: unknown = Reflect.get(name, key);
  return typeof value === "string" ? value.trim() : "";
}

function nameTokens(value: string): readonly string[] {
  return value
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function tokensWithin(
  inner: readonly string[],
  outer: readonly string[],
): boolean {
  const outerSet = new Set(outer);
  return inner.every((token) => outerSet.has(token));
}

const FREE_FORM_NAME_KEY = "unstructuredName";

function namePartsCompatible(
  key: string,
  left: string,
  right: string,
): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const leftTokens = nameTokens(left);
  const rightTokens = nameTokens(right);
  if (key === FREE_FORM_NAME_KEY) {
    return (
      tokensWithin(leftTokens, rightTokens) ||
      tokensWithin(rightTokens, leftTokens)
    );
  }
  return leftTokens.join(" ") === rightTokens.join(" ");
}

function namesConflict(left: ContactName, right: ContactName): boolean {
  const keys = new Set([
    ...writableSubfieldKeys("names", left),
    ...writableSubfieldKeys("names", right),
  ]);
  for (const key of keys) {
    if (!namePartsCompatible(key, namePart(left, key), namePart(right, key))) {
      return true;
    }
  }
  return false;
}

export function hasConflictingNames(
  survivor: ContactRecord,
  duplicate: ContactRecord,
): boolean {
  const survName = ownedName(survivor);
  const dupName = ownedName(duplicate);
  if (survName === undefined || dupName === undefined) return false;
  return namesConflict(survName, dupName);
}

function fillsNamePart(
  key: string,
  existing: unknown,
  offered: string,
): boolean {
  if (typeof existing !== "string" || existing.trim().length === 0) {
    return existing === undefined || typeof existing === "string";
  }
  return (
    key === FREE_FORM_NAME_KEY &&
    nameTokens(offered).length > nameTokens(existing).length
  );
}

function fillMissingNameParts(
  current: ContactName,
  duplicates: readonly ContactRecord[],
): ContactName {
  const filled: Record<string, unknown> = { ...current };
  for (const dup of duplicates) {
    const dupName = ownedName(dup);
    if (dupName === undefined) continue;
    for (const key of writableSubfieldKeys("names", dupName)) {
      if (fillsNamePart(key, filled[key], namePart(dupName, key))) {
        filled[key] = Reflect.get(dupName, key);
      }
    }
  }
  const written = new Set([
    "metadata",
    ...writableSubfieldKeys("names", current),
  ]);
  for (const key of Object.keys(filled)) {
    if (!written.has(key) && Object.hasOwn(current, key)) delete filled[key];
  }
  const base: ContactName = {};
  return { ...base, ...filled };
}

export function mergeSurvivorNames(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
): readonly ContactName[] | undefined {
  const survivorList = stripNonContactSource(survivor.names);
  const baseList =
    survivorList.length > 0
      ? survivorList
      : (duplicates
          .map((dup) => stripNonContactSource(dup.names))
          .find((list) => list.length > 0) ?? []);
  const current = baseList[0];
  if (current === undefined) return undefined;
  const filled = fillMissingNameParts(current, duplicates);
  const unchanged =
    survivorList.length > 0 &&
    entryIdentity("names", filled) === entryIdentity("names", current);
  return unchanged ? undefined : [filled, ...baseList.slice(1)];
}

export function mergedNameConflicts(
  survivor: ContactRecord,
  duplicates: readonly ContactRecord[],
): string | null {
  const merged =
    mergeSurvivorNames(survivor, duplicates)?.[0] ?? ownedName(survivor);
  if (merged === undefined) return null;
  for (const dup of duplicates) {
    const dupName = ownedName(dup);
    if (dupName !== undefined && namesConflict(merged, dupName)) {
      return `Duplicate contact ${dup.resourceName} carries a name part that conflicts with the merged Survivor name.`;
    }
  }
  return null;
}
