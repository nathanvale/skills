import type { CountryCode } from "libphonenumber-js/min";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { ContactPhone, E164Phone } from "../domain/rules.ts";
import { parseE164Phone } from "../domain/rules.ts";

const SUPPORTED_REGIONS: ReadonlyMap<string, CountryCode> = new Map([
  ["AU", "AU"],
  ["US", "US"],
  ["GB", "GB"],
  ["NZ", "NZ"],
  ["CA", "CA"],
  ["DE", "DE"],
  ["FR", "FR"],
  ["JP", "JP"],
  ["SG", "SG"],
  ["IN", "IN"],
  ["IE", "IE"],
  ["NL", "NL"],
  ["SE", "SE"],
  ["CH", "CH"],
]);

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
