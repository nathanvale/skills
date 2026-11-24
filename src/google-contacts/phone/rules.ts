import type { CountryCode } from "libphonenumber-js/min";
import {
  getCountries,
  parsePhoneNumberFromString,
} from "libphonenumber-js/min";
import type { ContactPhone, E164Phone } from "../domain/rules.ts";
import { parseE164Phone } from "../domain/rules.ts";

const SUPPORTED_REGIONS: ReadonlyMap<string, CountryCode> = new Map(
  getCountries().map((code) => [code, code]),
);

const AU_SHORT_OR_NON_GEO = /^(?:13\d{4}|1300\d{6}|1800\d{6}|190\d{7})$/;

export type PhoneNormalizationResult =
  | { readonly kind: "unchanged"; readonly e164: E164Phone }
  | { readonly kind: "normalized"; readonly e164: E164Phone }
  | {
      readonly kind: "ambiguous";
      readonly reason: "non-geographic-short-code" | "invalid-or-ambiguous";
    };

export function resolveCountryCode(raw: string): CountryCode | null {
  return SUPPORTED_REGIONS.get(raw.trim().toUpperCase()) ?? null;
}

export function normalizePhoneValue(
  rawValue: string,
  defaultRegion: CountryCode,
): PhoneNormalizationResult {
  const trimmed = rawValue.trim();
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (
    defaultRegion === "AU" &&
    !trimmed.startsWith("+") &&
    AU_SHORT_OR_NON_GEO.test(digitsOnly)
  ) {
    return { kind: "ambiguous", reason: "non-geographic-short-code" };
  }
  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);
  if (parsed === undefined || !parsed.isValid()) {
    return { kind: "ambiguous", reason: "invalid-or-ambiguous" };
  }
  const e164 = parseE164Phone(parsed.number);
  if (e164 === null) {
    return { kind: "ambiguous", reason: "invalid-or-ambiguous" };
  }
  if (trimmed === e164.value) {
    return { kind: "unchanged", e164 };
  }
  return { kind: "normalized", e164 };
}

function phoneTypeSpecificity(phoneType: string | undefined): number {
  const lowered = (phoneType ?? "other").trim().toLowerCase();
  if (lowered === "mobile") return 4;
  if (lowered === "work") return 3;
  if (lowered === "home") return 2;
  return 1;
}

export function deduplicatePhoneList(
  phones: readonly ContactPhone[],
): readonly ContactPhone[] {
  const bestByValue = new Map<string, ContactPhone>();
  const order: string[] = [];
  for (const phone of phones) {
    const key = phone.value.trim();
    const existing = bestByValue.get(key);
    if (existing === undefined) {
      bestByValue.set(key, phone);
      order.push(key);
      continue;
    }
    if (
      phoneTypeSpecificity(phone.type) > phoneTypeSpecificity(existing.type)
    ) {
      bestByValue.set(key, phone);
    }
  }
  const result: ContactPhone[] = [];
  for (const key of order) {
    const item = bestByValue.get(key);
    if (item !== undefined) result.push(item);
  }
  return result;
}

export function normalizeContactPhones(
  phones: readonly ContactPhone[],
  defaultRegion: CountryCode,
): {
  readonly normalized: readonly ContactPhone[];
  readonly changed: boolean;
  readonly hadDuplicates: boolean;
  readonly ambiguousValues: readonly string[];
} {
  const rewritten: ContactPhone[] = [];
  const ambiguousValues: string[] = [];
  let changed = false;
  for (const phone of phones) {
    const res = normalizePhoneValue(phone.value, defaultRegion);
    if (res.kind === "ambiguous") {
      ambiguousValues.push(phone.value);
      rewritten.push(phone);
      continue;
    }
    if (res.kind === "normalized") {
      changed = true;
    }
    rewritten.push({
      ...phone,
      value: res.e164.value,
    });
  }
  const deduped = deduplicatePhoneList(rewritten);
  const hadDuplicates = deduped.length < rewritten.length;
  return {
    normalized: deduped,
    changed: changed || hadDuplicates,
    hadDuplicates,
    ambiguousValues,
  };
}

export function planPhoneNormalization(
  existing: readonly ContactPhone[],
  named: readonly ContactPhone[] | null,
  defaultRegion: CountryCode,
): {
  readonly phones: readonly ContactPhone[];
  readonly ambiguousValues: readonly string[];
} {
  const targets = new Set<string>();
  const ambiguousValues: string[] = [];
  const requested: ContactPhone[] = [];
  for (const phone of named ?? existing) {
    const res = normalizePhoneValue(phone.value, defaultRegion);
    if (res.kind === "ambiguous") {
      ambiguousValues.push(phone.value);
      continue;
    }
    targets.add(res.e164.value);
    requested.push({ ...phone, value: res.e164.value });
  }
  const matched = new Set<string>();
  const rewritten = existing.map((phone) => {
    const res = normalizePhoneValue(phone.value, defaultRegion);
    if (res.kind === "ambiguous" || !targets.has(res.e164.value)) return phone;
    matched.add(res.e164.value);
    return { ...phone, value: res.e164.value };
  });
  const added = requested.filter((phone) => !matched.has(phone.value));
  return {
    phones: deduplicatePhoneList([...rewritten, ...added]),
    ambiguousValues,
  };
}

export function phoneMatchesE164(rawValue: string, e164Value: string): boolean {
  if (rawValue.trim() === e164Value) return true;
  const region = parsePhoneNumberFromString(e164Value)?.country;
  if (region === undefined) return false;
  const res = normalizePhoneValue(rawValue, region);
  return res.kind !== "ambiguous" && res.e164.value === e164Value;
}
