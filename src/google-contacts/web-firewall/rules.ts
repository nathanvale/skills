import { emailDomainOf, isFreeMailDomain } from "../anchors/rules.ts";
import {
  compareCodeUnit,
  parseEmailAddress,
  parseOrganizationDomain,
} from "../domain/rules.ts";
import type {
  ContactRecord,
  OrganizationDomain,
  WebResearchQueueEntry,
} from "../domain/rules.ts";
import type { PlanLeakGuard } from "../plan-types/rules.ts";

type WebQueryAnchor =
  | { readonly kind: "org-domain"; readonly domain: OrganizationDomain }
  | {
      readonly kind: "name-plus-organization";
      readonly displayName: string;
      readonly organization: string;
    };

export type WebEligibility =
  | {
      readonly eligible: true;
      readonly anchor: WebQueryAnchor;
      readonly safeQueryTerms: readonly [string, ...string[]];
    }
  | {
      readonly eligible: false;
      readonly reason:
        | "bare-name-only"
        | "private-anchor-only"
        | "sensitive-field-excluded";
    };

const UNTRUSTED_SENTINELS = [
  "<<<EXTERNAL_UNTRUSTED_CONTENT",
  "<<<END_EXTERNAL_UNTRUSTED_CONTENT",
  "EXTERNAL_UNTRUSTED_CONTENT",
  "IGNORE PREVIOUS INSTRUCTIONS",
];

const PHONE_LIKE_IN_QUERY = /\+?\d[\d\s().-]{6,}\d/;
const EMAIL_IN_QUERY = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

function extractOrgDomainFromContact(
  contact: ContactRecord,
): OrganizationDomain | null {
  for (const org of contact.organizations) {
    if (org.domain !== undefined) {
      const parsed = parseOrganizationDomain(org.domain);
      if (parsed !== null && !isFreeMailDomain(parsed.value)) return parsed;
    }
  }
  for (const emailEntry of contact.emailAddresses) {
    const parsed = parseEmailAddress(emailEntry.value);
    if (parsed === null) continue;
    const dom = emailDomainOf(parsed.value);
    if (dom === null || isFreeMailDomain(dom)) continue;
    const orgDom = parseOrganizationDomain(dom);
    if (orgDom !== null) return orgDom;
  }
  return null;
}

function primaryDisplayName(contact: ContactRecord): string | null {
  for (const name of contact.names) {
    const direct = (name.displayName ?? "").trim();
    if (direct.length > 0) return direct;
    const combined = [name.givenName ?? "", name.familyName ?? ""]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    if (combined.length > 0) return combined;
  }
  return null;
}

function primaryOrgName(contact: ContactRecord): string | null {
  for (const org of contact.organizations) {
    const name = (org.name ?? "").trim();
    if (name.length > 0) return name;
  }
  return null;
}

function containsSensitivePublicTerm(
  value: string | null,
  contact: ContactRecord,
): boolean {
  if (value === null) return false;
  if (PHONE_LIKE_IN_QUERY.test(value)) return true;
  if (value.match(EMAIL_IN_QUERY) !== null) return true;
  const lowered = value.toLowerCase();
  return contact.addresses.some((addr) => {
    const street = (addr.streetAddress ?? addr.formattedValue ?? "")
      .trim()
      .toLowerCase();
    return street.length >= 6 && lowered.includes(street);
  });
}

export function evaluateWebEligibility(contact: ContactRecord): WebEligibility {
  const orgDomain = extractOrgDomainFromContact(contact);
  const displayName = primaryDisplayName(contact);
  const orgName = primaryOrgName(contact);
  if (
    containsSensitivePublicTerm(displayName, contact) ||
    containsSensitivePublicTerm(orgName, contact)
  ) {
    return { eligible: false, reason: "sensitive-field-excluded" };
  }
  if (orgDomain !== null) {
    const terms: [string, ...string[]] =
      displayName !== null && orgName !== null
        ? [displayName, orgName, orgDomain.value]
        : [orgDomain.value];
    return {
      eligible: true,
      anchor: { kind: "org-domain", domain: orgDomain },
      safeQueryTerms: terms,
    };
  }
  if (displayName !== null && orgName !== null) {
    return {
      eligible: true,
      anchor: {
        kind: "name-plus-organization",
        displayName,
        organization: orgName,
      },
      safeQueryTerms: [displayName, orgName],
    };
  }
  if (displayName !== null) {
    return { eligible: false, reason: "bare-name-only" };
  }
  return { eligible: false, reason: "private-anchor-only" };
}

export function buildWebResearchQueue(
  contacts: readonly ContactRecord[],
): readonly WebResearchQueueEntry[] {
  const entries: WebResearchQueueEntry[] = [];
  for (const contact of contacts) {
    const eligibility = evaluateWebEligibility(contact);
    if (!eligibility.eligible) continue;
    const anchor = eligibility.anchor;
    const suggestedQuery =
      anchor.kind === "org-domain"
        ? `site:${anchor.domain.value} ${eligibility.safeQueryTerms.filter((term) => term !== anchor.domain.value).join(" ")}`.trim()
        : `"${anchor.displayName}" "${anchor.organization}"`;
    entries.push({
      contactResourceName: contact.resourceName,
      anchorKind: anchor.kind,
      safeQueryTerms: eligibility.safeQueryTerms,
      suggestedQuery,
    });
  }
  return entries;
}

type LeakTermSets = {
  readonly phones: Set<string>;
  readonly emails: Set<string>;
  readonly bareNames: Set<string>;
  readonly anchoredNames: Map<string, Set<string>>;
  readonly streets: Set<string>;
};

function eligibleAnchorTerms(eligibility: WebEligibility): readonly string[] {
  if (!eligibility.eligible) return [];
  const anchor = eligibility.anchor;
  return anchor.kind === "org-domain"
    ? eligibility.safeQueryTerms.slice(1).concat(anchor.domain.value)
    : [anchor.organization];
}

function recordNameLeakTerms(contact: ContactRecord, sets: LeakTermSets): void {
  const name = primaryDisplayName(contact)?.toLowerCase() ?? null;
  if (name === null || name.length < 3) return;
  const eligibility = evaluateWebEligibility(contact);
  if (!eligibility.eligible) {
    sets.bareNames.add(name);
    return;
  }
  const anchors = sets.anchoredNames.get(name) ?? new Set<string>();
  for (const term of eligibleAnchorTerms(eligibility)) {
    const lowered = term.trim().toLowerCase();
    if (lowered.length > 0 && lowered !== name) anchors.add(lowered);
  }
  sets.anchoredNames.set(name, anchors);
}

function recordContactLeakTerms(
  contact: ContactRecord,
  sets: LeakTermSets,
): void {
  for (const phone of contact.phoneNumbers) {
    const digits = phone.value.replace(/\D/g, "");
    if (digits.length >= 7) sets.phones.add(digits);
  }
  for (const emailEntry of contact.emailAddresses) {
    const parsed = parseEmailAddress(emailEntry.value);
    if (parsed !== null) sets.emails.add(parsed.value);
  }
  recordNameLeakTerms(contact, sets);
  for (const addr of contact.addresses) {
    const street = (addr.streetAddress ?? addr.formattedValue ?? "").trim();
    if (street.length >= 6) sets.streets.add(street.toLowerCase());
  }
}

export function buildLeakGuard(
  contacts: readonly ContactRecord[],
): PlanLeakGuard {
  const sets: LeakTermSets = {
    phones: new Set<string>(),
    emails: new Set<string>(),
    bareNames: new Set<string>(),
    anchoredNames: new Map<string, Set<string>>(),
    streets: new Set<string>(),
  };
  for (const contact of contacts) recordContactLeakTerms(contact, sets);
  return {
    privatePhones: [...sets.phones].sort(compareCodeUnit),
    personalEmails: [...sets.emails].sort(compareCodeUnit),
    bareNames: [...sets.bareNames].sort(compareCodeUnit),
    anchoredNames: [...sets.anchoredNames.keys()]
      .sort(compareCodeUnit)
      .map((name) => ({
        name,
        anchors: [...(sets.anchoredNames.get(name) ?? [])].sort(
          compareCodeUnit,
        ),
      })),
    streetAddresses: [...sets.streets].sort(compareCodeUnit),
  };
}

function checkEmailLeaks(lowered: string, guard: PlanLeakGuard): string | null {
  const emailMatches = lowered.match(EMAIL_IN_QUERY) ?? [];
  for (const email of emailMatches) {
    const dom = emailDomainOf(email);
    if (
      guard.personalEmails.includes(email) ||
      (dom !== null && isFreeMailDomain(dom))
    ) {
      return "Web query leaks a personal or free-mail email address.";
    }
  }
  return null;
}

export function detectWebQueryLeak(
  query: string,
  guard: PlanLeakGuard,
): string | null {
  const lowered = query.toLowerCase();
  const digits = query.replace(/\D/g, "");
  if (PHONE_LIKE_IN_QUERY.test(query)) {
    return "Web query contains a phone number pattern.";
  }
  if (guard.privatePhones.some((num) => digits.includes(num))) {
    return "Web query leaks a private phone number from the snapshot.";
  }
  const emailLeak = checkEmailLeaks(lowered, guard);
  if (emailLeak !== null) return emailLeak;
  if (guard.bareNames.some((name) => lowered.includes(name))) {
    return "Web query leaks an ineligible bare personal name.";
  }
  const unanchored = guard.anchoredNames.find((entry) => {
    if (!lowered.includes(entry.name)) return false;
    const rest = lowered.split(entry.name).join(" ");
    return !entry.anchors.some((anchor) => rest.includes(anchor));
  });
  if (unanchored !== undefined) {
    return "Web query names a Contact's personal name without its organization or domain anchor.";
  }
  if (guard.streetAddresses.some((street) => lowered.includes(street))) {
    return "Web query leaks a residential street address.";
  }
  return null;
}

export function containsUntrustedSentinel(text: string): boolean {
  const upper = text.toUpperCase();
  return UNTRUSTED_SENTINELS.some((marker) => upper.includes(marker));
}
