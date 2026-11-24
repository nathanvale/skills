import type { CountryCode } from "libphonenumber-js/min";
import {
  compareCodeUnit,
  parseEmailAddress,
  parseOrganizationDomain,
  stripNonContactSource,
} from "../domain/rules.ts";
import type {
  AuditDoc,
  AuditFinding,
  ContactRecord,
  ContactSnapshotDoc,
  IdentityAnchor,
  SerializedIdentityAnchor,
} from "../domain/rules.ts";
import { normalizeContactPhones, normalizePhoneValue } from "../phone/rules.ts";

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "yahoo.com.au",
  "ymail.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "fastmail.fm",
  "aol.com",
  "hey.com",
  "gmx.com",
  "bigpond.com",
  "optusnet.com.au",
]);

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase());
}

export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

export function serializeAnchor(
  anchor: IdentityAnchor,
): SerializedIdentityAnchor {
  if (anchor.kind === "e164-phone") {
    return { kind: "e164-phone", value: anchor.phone.value };
  }
  if (anchor.kind === "email") {
    return { kind: "email", value: anchor.email.value };
  }
  return { kind: "org-domain", value: anchor.domain.value };
}

export function findSwitchboardPhones(
  contacts: readonly ContactRecord[],
  defaultRegion: CountryCode,
): ReadonlySet<string> {
  const counts = new Map<string, Set<string>>();
  for (const contact of contacts) {
    for (const phone of contact.phoneNumbers) {
      const norm = normalizePhoneValue(phone.value, defaultRegion);
      if (norm.kind === "ambiguous") continue;
      const set = counts.get(norm.e164.value) ?? new Set<string>();
      set.add(contact.resourceName);
      counts.set(norm.e164.value, set);
    }
  }
  const switchboards = new Set<string>();
  for (const [number, owners] of counts) {
    if (owners.size >= 3) switchboards.add(number);
  }
  return switchboards;
}

function addAnchorIfNew(
  seen: Set<string>,
  anchors: IdentityAnchor[],
  key: string,
  anchor: IdentityAnchor,
): void {
  if (seen.has(key)) return;
  seen.add(key);
  anchors.push(anchor);
}

function addOrgDomainAnchor(
  raw: string | undefined,
  seen: Set<string>,
  anchors: IdentityAnchor[],
): void {
  if (raw === undefined) return;
  const orgDomain = parseOrganizationDomain(raw);
  if (orgDomain === null || isFreeMailDomain(orgDomain.value)) return;
  addAnchorIfNew(seen, anchors, `domain:${orgDomain.value}`, {
    kind: "org-domain",
    domain: orgDomain,
  });
}

function collectPhoneAnchors(
  contact: ContactRecord,
  defaultRegion: CountryCode,
  switchboards: ReadonlySet<string>,
  seen: Set<string>,
  anchors: IdentityAnchor[],
): void {
  for (const phone of contact.phoneNumbers) {
    const norm = normalizePhoneValue(phone.value, defaultRegion);
    if (norm.kind === "ambiguous" || switchboards.has(norm.e164.value)) {
      continue;
    }
    addAnchorIfNew(seen, anchors, `phone:${norm.e164.value}`, {
      kind: "e164-phone",
      phone: norm.e164,
    });
  }
}

function collectEmailAnchors(
  contact: ContactRecord,
  seen: Set<string>,
  anchors: IdentityAnchor[],
): void {
  for (const emailEntry of contact.emailAddresses) {
    const parsed = parseEmailAddress(emailEntry.value);
    if (parsed === null) continue;
    addAnchorIfNew(seen, anchors, `email:${parsed.value}`, {
      kind: "email",
      email: parsed,
    });
    const domain = emailDomainOf(parsed.value);
    addOrgDomainAnchor(domain ?? undefined, seen, anchors);
  }
}

export function extractIdentityAnchors(
  contact: ContactRecord,
  defaultRegion: CountryCode,
  switchboards: ReadonlySet<string>,
): readonly IdentityAnchor[] {
  const anchors: IdentityAnchor[] = [];
  const seen = new Set<string>();
  collectPhoneAnchors(contact, defaultRegion, switchboards, seen, anchors);
  collectEmailAnchors(contact, seen, anchors);
  for (const org of contact.organizations) {
    addOrgDomainAnchor(org.domain, seen, anchors);
  }
  for (const url of contact.urls) {
    addOrgDomainAnchor(url.value, seen, anchors);
  }
  return anchors;
}

function anchorKey(anchor: IdentityAnchor): string {
  const serialized = serializeAnchor(anchor);
  return `${serialized.kind}:${serialized.value}`;
}

export function sharedIndependentAnchors(
  leftAnchors: readonly IdentityAnchor[],
  rightAnchors: readonly IdentityAnchor[],
): readonly IdentityAnchor[] {
  const rightKeys = new Set(rightAnchors.map(anchorKey));
  const common = leftAnchors.filter((item) => rightKeys.has(anchorKey(item)));
  const matched: IdentityAnchor[] = [];
  const matchedEmailDomains = new Set<string>();
  for (const item of common) {
    if (item.kind === "email") {
      const dom = emailDomainOf(item.email.value);
      if (dom !== null) matchedEmailDomains.add(dom);
      matched.push(item);
    } else if (item.kind === "e164-phone") {
      matched.push(item);
    }
  }
  for (const item of common) {
    if (
      item.kind === "org-domain" &&
      !matchedEmailDomains.has(item.domain.value)
    ) {
      matched.push(item);
    }
  }
  return matched;
}

export function countIndependentSerializedAnchors(
  anchors: readonly SerializedIdentityAnchor[],
): number {
  const seen = new Set<string>();
  const emailDomains = new Set<string>();
  let count = 0;
  for (const anchor of anchors) {
    const key = `${anchor.kind}:${anchor.value.toLowerCase()}`;
    if (seen.has(key) || anchor.kind === "org-domain") continue;
    seen.add(key);
    if (anchor.kind === "email") {
      const dom = emailDomainOf(anchor.value);
      if (dom !== null) emailDomains.add(dom);
    }
    count += 1;
  }
  for (const anchor of anchors) {
    if (anchor.kind !== "org-domain") continue;
    const lowered = anchor.value.toLowerCase();
    const key = `org-domain:${lowered}`;
    if (
      seen.has(key) ||
      isFreeMailDomain(lowered) ||
      emailDomains.has(lowered)
    ) {
      continue;
    }
    seen.add(key);
    count += 1;
  }
  return count;
}

function auditContactPhones(
  contact: ContactRecord,
  defaultRegion: CountryCode,
  findings: AuditFinding[],
): void {
  const ownedPhones = stripNonContactSource(contact.phoneNumbers);
  if (ownedPhones.length === 0) return;
  const res = normalizeContactPhones(ownedPhones, defaultRegion);
  if (res.ambiguousValues.length > 0) {
    findings.push({
      id: `phone-ambiguous:${contact.resourceName}`,
      kind: "phone-ambiguous",
      lane: null,
      confidence: "low",
      resourceNames: [contact.resourceName],
      summary: `Ambiguous or non-geographic phone number(s): ${res.ambiguousValues.join(", ")}`,
    });
  }
  if (res.changed) {
    findings.push({
      id: `phone-normalize:${contact.resourceName}`,
      kind: res.hadDuplicates ? "phone-duplicate" : "phone-normalize",
      lane: "phone-normalize",
      confidence: res.ambiguousValues.length === 0 ? "high" : "low",
      resourceNames: [contact.resourceName],
      summary: `Normalize phone numbers for ${contact.resourceName} under ${defaultRegion}.`,
      normalizedPhones: res.normalized,
    });
  }
}

function auditSparseAndStale(
  contact: ContactRecord,
  staleBeforeIso: string,
  findings: AuditFinding[],
): void {
  const missingFields: string[] = [];
  const hasName = contact.names.some(
    (name) =>
      (name.displayName ?? "").trim().length > 0 ||
      (name.givenName ?? "").trim().length > 0,
  );
  if (!hasName) missingFields.push("names");
  const hasOrg = contact.organizations.some(
    (org) => (org.name ?? "").trim().length > 0,
  );
  if (!hasOrg) missingFields.push("organizations.name");
  const hasTitle = contact.organizations.some(
    (org) => (org.title ?? "").trim().length > 0,
  );
  if (!hasTitle) missingFields.push("organizations.title");
  if (missingFields.length > 0) {
    findings.push({
      id: `sparse:${contact.resourceName}`,
      kind: "sparse-contact",
      lane: "metadata-enrich",
      confidence: "medium",
      resourceNames: [contact.resourceName],
      summary: `Sparse contact missing: ${missingFields.join(", ")}.`,
      missingFields,
    });
  }
  if (
    contact.updatedAt !== null &&
    compareCodeUnit(contact.updatedAt, staleBeforeIso) < 0
  ) {
    findings.push({
      id: `stale:${contact.resourceName}`,
      kind: "stale-contact",
      lane: "metadata-enrich",
      confidence: "low",
      resourceNames: [contact.resourceName],
      summary: `Contact last updated at ${contact.updatedAt} (older than threshold).`,
    });
  }
}

function checkDuplicatePair(
  left: ContactRecord,
  right: ContactRecord,
  anchorMap: ReadonlyMap<string, readonly IdentityAnchor[]>,
  findings: AuditFinding[],
): void {
  const shared = sharedIndependentAnchors(
    anchorMap.get(left.resourceName) ?? [],
    anchorMap.get(right.resourceName) ?? [],
  );
  if (shared.length === 0) return;
  const pair = [left.resourceName, right.resourceName].sort(compareCodeUnit);
  findings.push({
    id: `duplicate:${pair[0] ?? ""}:${pair[1] ?? ""}`,
    kind: "duplicate-candidate",
    lane: "duplicate-merge",
    confidence: shared.length >= 2 ? "high" : "medium",
    resourceNames: pair,
    summary: `Candidate duplicate pair sharing ${String(shared.length)} independent anchor(s).`,
    anchors: shared.map(serializeAnchor),
  });
}

function auditDuplicatePairs(
  contacts: readonly ContactRecord[],
  defaultRegion: CountryCode,
  switchboards: ReadonlySet<string>,
  findings: AuditFinding[],
): void {
  const anchorMap = new Map<string, readonly IdentityAnchor[]>();
  for (const contact of contacts) {
    anchorMap.set(
      contact.resourceName,
      extractIdentityAnchors(contact, defaultRegion, switchboards),
    );
  }
  for (let i = 0; i < contacts.length; i += 1) {
    const left = contacts[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < contacts.length; j += 1) {
      const right = contacts[j];
      if (right !== undefined)
        checkDuplicatePair(left, right, anchorMap, findings);
    }
  }
}

export function runContactsAudit(
  snapshot: ContactSnapshotDoc,
  defaultRegion: CountryCode,
  laneFilter: string | null,
): AuditDoc {
  const findings: AuditFinding[] = [];
  const switchboards = findSwitchboardPhones(snapshot.contacts, defaultRegion);
  const capturedDate = new Date(snapshot.capturedAt);
  const staleCutoffMs = Number.isNaN(capturedDate.getTime())
    ? 0
    : capturedDate.getTime() - 365 * 24 * 60 * 60 * 1000;
  const staleBeforeIso = new Date(staleCutoffMs).toISOString();
  for (const contact of snapshot.contacts) {
    auditContactPhones(contact, defaultRegion, findings);
    auditSparseAndStale(contact, staleBeforeIso, findings);
  }
  auditDuplicatePairs(snapshot.contacts, defaultRegion, switchboards, findings);
  const filtered =
    laneFilter === null
      ? findings
      : findings.filter(
          (item) => item.lane === laneFilter || item.kind === laneFilter,
        );
  return {
    schemaVersion: "contacts-audit/1",
    account: snapshot.account,
    defaultRegion,
    contactCount: snapshot.contacts.length,
    findings: filtered,
  };
}
