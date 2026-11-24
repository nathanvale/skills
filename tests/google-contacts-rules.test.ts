import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  extractIdentityAnchors,
  findSwitchboardPhones,
  runContactsAudit,
  sharedIndependentAnchors,
} from "../src/google-contacts/anchors/rules.ts";
import { decodeContactRecord } from "../src/google-contacts/decoders/rules.ts";
import {
  parseContactRevision,
  parseE164Phone,
  parseEmailAddress,
  parseOrganizationDomain,
  parsePlanSeal,
  parseResourceName,
} from "../src/google-contacts/domain/rules.ts";
import type {
  E164Phone,
  ResourceName,
} from "../src/google-contacts/domain/rules.ts";
import {
  contactScopeKey,
  resolveLedgerRoot,
} from "../src/google-contacts/ledger.ts";
import {
  buildAppendedBiography,
  computeDuplicateMerge,
} from "../src/google-contacts/merge/rules.ts";
import {
  normalizeContactPhones,
  normalizePhoneValue,
} from "../src/google-contacts/phone/rules.ts";
import { compileMutationPlan } from "../src/google-contacts/plan/rules.ts";
import { computePlanSeal } from "../src/google-contacts/plan-types/rules.ts";
import {
  validateMutationPlan,
  verifyPlanSealMatch,
} from "../src/google-contacts/plan-validate/rules.ts";
import {
  buildLeakGuard,
  buildWebResearchQueue,
  containsUntrustedSentinel,
  detectWebQueryLeak,
} from "../src/google-contacts/web-firewall/rules.ts";
import {
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";

type IsAssignable<From, To> = [From] extends [To] ? true : false;
const resourceIsNotPhone: IsAssignable<ResourceName, E164Phone> = false;
const phoneIsNotResource: IsAssignable<E164Phone, ResourceName> = false;

test("branded value parsers validate domain formats and keep distinct brands", () => {
  expect(resourceIsNotPhone).toBe(false);
  expect(phoneIsNotResource).toBe(false);
  expect(parseResourceName("people/c100")?.value).toBe("people/c100");
  expect(parseResourceName("contacts/c100")).toBeNull();
  expect(parseE164Phone("+61491570101")?.value).toBe("+61491570101");
  expect(parseE164Phone("0491570101")).toBeNull();
  expect(parseEmailAddress("Alice@Example.COM")?.value).toBe(
    "alice@example.com",
  );
  expect(
    parseOrganizationDomain("https://www.acme.example.org/team")?.value,
  ).toBe("acme.example.org");
  expect(parseContactRevision("etag-1")?.value).toBe("etag-1");
  expect(parseContactRevision("   ")).toBeNull();
  expect(parsePlanSeal(`sha256:${"a".repeat(64)}`)?.value).toBe(
    `sha256:${"a".repeat(64)}`,
  );
  expect(parsePlanSeal("sha256:short")).toBeNull();
});

test("phone normalization uses libphonenumber-js/min, flags AU short codes, and dedupes by specificity", () => {
  const local = normalizePhoneValue("0491 570 101", "AU");
  expect(local.kind).toBe("normalized");
  if (local.kind === "normalized") {
    expect(local.e164.value).toBe("+61491570101");
  }
  const shortCode = normalizePhoneValue("1300 555 010", "AU");
  expect(shortCode).toEqual({
    kind: "ambiguous",
    reason: "non-geographic-short-code",
  });
  const deduped = normalizeContactPhones(
    [
      { value: "0491 570 101", type: "other" },
      { value: "+61 491 570 101", type: "mobile" },
      { value: "0491570101", type: "work" },
    ],
    "AU",
  );
  expect(deduped.changed).toBe(true);
  expect(deduped.hadDuplicates).toBe(true);
  expect(deduped.normalized).toEqual([
    { value: "+61491570101", type: "mobile" },
  ]);
});

test("identity anchors exclude free-mail domains, switchboards, and email-domain double counting", () => {
  const freeMailProvider = "gmail.com";
  const c1 = sampleContact("c1", {
    phoneNumbers: [
      { value: "+61491570900", type: "work" },
      { value: "+61491570101", type: "mobile" },
    ],
    emailAddresses: [{ value: `pat@${freeMailProvider}`, type: "home" }],
    organizations: [],
  });
  const c2 = sampleContact("c2", {
    phoneNumbers: [{ value: "+61491570900", type: "work" }],
    emailAddresses: [{ value: "alex@acme.example.com", type: "work" }],
    organizations: [{ name: "Acme", domain: "acme.example.com" }],
  });
  const c3 = sampleContact("c3", {
    phoneNumbers: [{ value: "+61491570900", type: "work" }],
    emailAddresses: [{ value: "alex@acme.example.com", type: "work" }],
    organizations: [{ name: "Acme", domain: "acme.example.com" }],
  });
  const switchboards = findSwitchboardPhones([c1, c2, c3], "AU");
  expect(switchboards.has("+61491570900")).toBe(true);

  const a1 = extractIdentityAnchors(c1, "AU", switchboards);
  expect(a1.some((item) => item.kind === "org-domain")).toBe(false);
  expect(
    a1.some(
      (item) =>
        item.kind === "e164-phone" && item.phone.value === "+61491570900",
    ),
  ).toBe(false);

  const a2 = extractIdentityAnchors(c2, "AU", switchboards);
  const a3 = extractIdentityAnchors(c3, "AU", switchboards);
  const shared = sharedIndependentAnchors(a2, a3);
  expect(shared.length).toBe(1);
  expect(shared[0]?.kind).toBe("email");
});

test("web eligibility firewall redacts bare names and detects leaked queries and untrusted sentinels", () => {
  const freeMailEmail = ["morgan", "gmail.com"].join("@");
  const bareOnly = sampleContact("bare", {
    names: [{ displayName: "Morgan Bare" }],
    phoneNumbers: [{ value: "+61491570222", type: "mobile" }],
    emailAddresses: [{ value: freeMailEmail, type: "home" }],
    addresses: [{ streetAddress: "42 Private Lane" }],
    organizations: [],
  });
  const orgContact = sampleContact("org", {
    names: [{ displayName: "Taylor Org" }],
    emailAddresses: [{ value: "taylor@northwind.example.org", type: "work" }],
    organizations: [{ name: "Northwind", domain: "northwind.example.org" }],
  });
  const queue = buildWebResearchQueue([bareOnly, orgContact]);
  expect(queue.length).toBe(1);
  expect(queue[0]?.contactResourceName).toBe("people/org");

  const guard = buildLeakGuard([bareOnly, orgContact]);
  expect(detectWebQueryLeak("call +61491570222", guard)).not.toBeNull();
  expect(detectWebQueryLeak(`${freeMailEmail} profile`, guard)).not.toBeNull();
  expect(detectWebQueryLeak("Morgan Bare bio", guard)).not.toBeNull();
  expect(detectWebQueryLeak("42 Private Lane Sydney", guard)).not.toBeNull();
  expect(
    detectWebQueryLeak("site:northwind.example.org Taylor Org", guard),
  ).toBeNull();
  expect(containsUntrustedSentinel("<<<EXTERNAL_UNTRUSTED_CONTENT>>>")).toBe(
    true,
  );
});

test("duplicate merge enforces lossless allowlist, non-allowlisted refusal, and 2-anchor corroboration", () => {
  const survivor = sampleContact("surv", {
    names: [{ givenName: "Sam", familyName: "Taylor" }],
    phoneNumbers: [{ value: "+61491570301", type: "mobile" }],
    emailAddresses: [{ value: "sam@acme.example.com", type: "work" }],
    biographies: [{ value: "Existing note" }],
  });
  const validDup = sampleContact("dup1", {
    names: [{ givenName: "Sam", middleName: "Lee", familyName: "Taylor" }],
    phoneNumbers: [
      { value: "+61491570301", type: "mobile" },
      { value: "+61491570302", type: "work" },
    ],
    emailAddresses: [{ value: "sam@acme.example.com", type: "work" }],
    biographies: [{ value: "Dup note" }],
  });
  const ok = computeDuplicateMerge({
    survivor,
    duplicates: [validDup],
    allContacts: [survivor, validDup],
    defaultRegion: "AU",
    humanConfirmed: false,
    reason: null,
  });
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.cluster.provenanceLine).toBe("[merged-from] people/dup1");
    expect(ok.survivorFields.names?.[0]?.middleName).toBe("Lee");
    expect(ok.survivorFields.biographies?.[0]?.value).toContain(
      "Existing note",
    );
    expect(ok.survivorFields.biographies?.[0]?.value).toContain(
      "[merged-from] people/dup1",
    );
  }

  const decodedUnmergeable = decodeContactRecord({
    resourceName: "people/dup2",
    etag: "etag-dup2",
    phoneNumbers: [{ value: "+61491570301" }],
    emailAddresses: [{ value: "sam@acme.example.com" }],
    userDefined: [{ key: "badge", value: "99" }],
  });
  expect(decodedUnmergeable?.nonAllowlistedFields).toEqual(["userDefined"]);
  if (decodedUnmergeable !== null) {
    const refused = computeDuplicateMerge({
      survivor,
      duplicates: [decodedUnmergeable],
      allContacts: [survivor, decodedUnmergeable],
      defaultRegion: "AU",
      humanConfirmed: true,
      reason: "Confirmed",
    });
    expect(refused.ok).toBe(false);
  }
});

test("plan compilation enforces sub-batching, append-only notes, delete confirmation, and canonical seal", () => {
  const c1 = sampleContact("c1", {
    phoneNumbers: [{ value: "0491 570 101", type: "mobile" }],
    biographies: [{ value: "Line 1" }],
  });
  const snap = sampleSnapshot([c1]);
  const audit = runContactsAudit(snap, "AU", null);
  const compiled = compileMutationPlan({
    snapshot: snap,
    lane: "phone-normalize",
    accountOverride: null,
    audit,
    proposals: null,
    evidenceItems: [],
    contactFilter: [],
    minConfidence: "high",
    maxContacts: 50,
    defaultRegion: "AU",
  });
  expect(compiled.ok).toBe(true);
  if (compiled.ok) {
    expect(validateMutationPlan(compiled.plan)).toBeNull();
    expect(verifyPlanSealMatch(compiled.plan, compiled.plan.seal)).toBe(true);
    const { seal: sealValue, ...body } = compiled.plan;
    expect(computePlanSeal(body).value).toBe(sealValue);
  }

  const bioSame = buildAppendedBiography("Line 1\nLine 2", "Line 2");
  expect(bioSame.changed).toBe(false);

  const badDel = compileMutationPlan({
    snapshot: snap,
    lane: "contact-delete",
    accountOverride: null,
    audit: null,
    proposals: {
      schemaVersion: "contacts-proposals/1",
      account: snap.account,
      proposals: [
        { kind: "contact-delete", target: "people/c1", reason: "Old" },
      ],
    },
    evidenceItems: [],
    contactFilter: [],
    minConfidence: "high",
    maxContacts: 50,
    defaultRegion: "AU",
  });
  expect(badDel.ok).toBe(false);
});

test("ledger resolution enforces Option 1 priority: explicit -> absolute XDG_STATE_HOME -> HOME", () => {
  const absRoot = join(process.cwd(), "ledger-explicit");
  const absXdg = join(process.cwd(), "xdg-state");
  const absHome = join(process.cwd(), "home-root");

  expect(
    resolveLedgerRoot({
      GOOGLE_CONTACTS_LEDGER_DIR: absRoot,
      XDG_STATE_HOME: absXdg,
      HOME: absHome,
    }),
  ).toEqual({
    ok: true,
    root: absRoot,
    source: "GOOGLE_CONTACTS_LEDGER_DIR",
  });

  const relExplicit = resolveLedgerRoot({
    GOOGLE_CONTACTS_LEDGER_DIR: "relative/ledger",
    XDG_STATE_HOME: absXdg,
    HOME: absHome,
  });
  expect(relExplicit.ok).toBe(false);

  expect(
    resolveLedgerRoot({
      GOOGLE_CONTACTS_LEDGER_DIR: "",
      XDG_STATE_HOME: absXdg,
      HOME: absHome,
    }),
  ).toEqual({
    ok: true,
    root: join(absXdg, "nathanvale-skills", "google-contacts", "ledger"),
    source: "XDG_STATE_HOME",
  });

  expect(
    resolveLedgerRoot({
      XDG_STATE_HOME: "relative/xdg",
      HOME: absHome,
    }),
  ).toEqual({
    ok: true,
    root: join(
      absHome,
      ".local",
      "state",
      "nathanvale-skills",
      "google-contacts",
      "ledger",
    ),
    source: "HOME",
  });

  const missingHome = resolveLedgerRoot({ XDG_STATE_HOME: "rel" });
  expect(missingHome.ok).toBe(false);

  const key = contactScopeKey("Owner@Example.COM", "people/c1");
  expect(key).toBe("owner@example.com:people/c1");
  const longKey = contactScopeKey(
    `${"a".repeat(250)}@example.com`,
    "people/c1",
  );
  expect(longKey.startsWith("acct-")).toBe(true);
  expect(longKey.length).toBeLessThanOrEqual(256);
});
