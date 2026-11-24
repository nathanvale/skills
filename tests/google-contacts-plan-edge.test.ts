import { expect, setDefaultTimeout, test } from "bun:test";
import { decodeContactRecord } from "../src/google-contacts/decoders/rules.ts";
import { computeDuplicateMerge } from "../src/google-contacts/merge/rules.ts";
import { compileMutationPlan } from "../src/google-contacts/plan/rules.ts";
import { MAX_STDIN_PAYLOAD_BYTES } from "../src/google-contacts/plan-subbatch/rules.ts";
import {
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";

setDefaultTimeout(30_000);

test("lossless merge rejects all non-allowlisted duplicate fields and conflicting names, fills empty survivor name", () => {
  const survivor = sampleContact("surv", {
    names: [{ givenName: "Sam", familyName: "Taylor" }],
    phoneNumbers: [{ value: "+61491570301", type: "mobile" }],
    emailAddresses: [{ value: "sam@acme.example.com", type: "work" }],
  });
  const unmergeableCases: readonly Readonly<Record<string, unknown>>[] = [
    { photos: [{ url: "https://example.org/p.jpg", default: false }] },
    {
      memberships: [
        { contactGroupMembership: { contactGroupId: "vip-custom-group" } },
      ],
    },
    { userDefined: [{ key: "tier", value: "gold" }] },
    { externalIds: [{ value: "ext-1" }] },
    { imClients: [{ username: "sam-im" }] },
    { sipAddresses: [{ value: "sip:sam@example.org" }] },
    { miscKeywords: [{ value: "vip" }] },
    { clientData: [{ key: "k", value: "v" }] },
    { calendarUrls: [{ url: "https://cal.example.org/sam" }] },
    { interests: [{ value: "sailing" }] },
    { locations: [{ value: "Sydney" }] },
    { occupations: [{ value: "Architect" }] },
    { skills: [{ value: "TypeScript" }] },
    { customExtensionField: [{ value: "unknown-field" }] },
  ];
  for (const extra of unmergeableCases) {
    const dup = decodeContactRecord({
      resourceName: "people/dup-bad",
      etag: "etag-dup-bad",
      phoneNumbers: [{ value: "+61491570301" }],
      emailAddresses: [{ value: "sam@acme.example.com" }],
      ...extra,
    });
    expect(dup).not.toBeNull();
    if (dup !== null) {
      expect(dup.nonAllowlistedFields.length).toBeGreaterThan(0);
      const res = computeDuplicateMerge({
        survivor,
        duplicates: [dup],
        allContacts: [survivor, dup],
        defaultRegion: "AU",
        humanConfirmed: true,
        reason: "Explicit",
      });
      expect(res.ok).toBe(false);
    }
  }

  const allowedExtras = decodeContactRecord({
    resourceName: "people/dup-ok",
    etag: "etag-dup-ok",
    names: [{ givenName: "Sam", middleName: "Ray", familyName: "Taylor" }],
    phoneNumbers: [{ value: "+61491570301" }],
    emailAddresses: [{ value: "sam@acme.example.com" }],
    photos: [{ url: "https://example.org/default.png", default: true }],
    memberships: [{ contactGroupMembership: { contactGroupId: "myContacts" } }],
    userDefined: [
      { key: "dir", value: "x", metadata: { source: { type: "PROFILE" } } },
    ],
    events: [{ type: "anniversary", date: { year: 2020, month: 5, day: 1 } }],
    relations: [{ person: "Pat", type: "partner" }],
  });
  expect(allowedExtras?.nonAllowlistedFields).toEqual([]);

  const namelessSurvivor = sampleContact("surv-empty-name", {
    names: [],
    phoneNumbers: [{ value: "+61491570301", type: "mobile" }],
    emailAddresses: [{ value: "sam@acme.example.com", type: "work" }],
  });
  if (allowedExtras !== null) {
    const filled = computeDuplicateMerge({
      survivor: namelessSurvivor,
      duplicates: [allowedExtras],
      allContacts: [namelessSurvivor, allowedExtras],
      defaultRegion: "AU",
      humanConfirmed: false,
      reason: null,
    });
    expect(filled.ok).toBe(true);
    if (filled.ok) {
      expect(filled.survivorFields.names?.[0]?.givenName).toBe("Sam");
      expect(filled.survivorFields.events?.length).toBe(1);
      expect(filled.survivorFields.relations?.length).toBe(1);
    }
  }

  const conflictDup = sampleContact("dup-conflict", {
    names: [{ givenName: "Samuel", familyName: "Taylor" }],
    phoneNumbers: [{ value: "+61491570301", type: "mobile" }],
    emailAddresses: [{ value: "sam@acme.example.com", type: "work" }],
  });
  expect(
    computeDuplicateMerge({
      survivor,
      duplicates: [conflictDup],
      allContacts: [survivor, conflictDup],
      defaultRegion: "AU",
      humanConfirmed: true,
      reason: "Confirmed",
    }).ok,
  ).toBe(false);

  expect(
    computeDuplicateMerge({
      survivor,
      duplicates: [survivor],
      allContacts: [survivor],
      defaultRegion: "AU",
      humanConfirmed: true,
      reason: "Self",
    }).ok,
  ).toBe(false);

  const oneAnchorDup = sampleContact("dup-one", {
    names: [{ givenName: "Sam", familyName: "Taylor" }],
    phoneNumbers: [{ value: "+61491570399", type: "mobile" }],
    emailAddresses: [{ value: "sam@acme.example.com", type: "work" }],
  });
  expect(
    computeDuplicateMerge({
      survivor,
      duplicates: [oneAnchorDup],
      allContacts: [survivor, oneAnchorDup],
      defaultRegion: "AU",
      humanConfirmed: false,
      reason: null,
    }).ok,
  ).toBe(false);
  expect(
    computeDuplicateMerge({
      survivor,
      duplicates: [oneAnchorDup],
      allContacts: [survivor, oneAnchorDup],
      defaultRegion: "AU",
      humanConfirmed: true,
      reason: "   ",
    }).ok,
  ).toBe(false);
  expect(
    computeDuplicateMerge({
      survivor,
      duplicates: [oneAnchorDup],
      allContacts: [survivor, oneAnchorDup],
      defaultRegion: "AU",
      humanConfirmed: true,
      reason: "Verified same person",
    }).ok,
  ).toBe(true);
});

test("plan enforces exact FieldMaskSubBatch partitioning, <900KB chunking, maxContacts, and never splits a MergeCluster", () => {
  const c1 = sampleContact("c1", { organizations: [], urls: [] });
  const c2 = sampleContact("c2", { organizations: [], urls: [] });
  const snap = sampleSnapshot([c1, c2]);
  const hetero = compileMutationPlan({
    snapshot: snap,
    lane: "metadata-enrich",
    accountOverride: null,
    audit: null,
    proposals: {
      schemaVersion: "contacts-proposals/1",
      account: snap.account,
      proposals: [
        {
          kind: "metadata-enrich",
          target: "people/c1",
          confidence: "high",
          organizations: [{ name: "Northwind", title: "Lead" }],
        },
        {
          kind: "metadata-enrich",
          target: "people/c2",
          confidence: "high",
          urls: [{ value: "https://northwind.example.org" }],
        },
      ],
    },
    evidenceItems: [],
    contactFilter: [],
    minConfidence: "high",
    maxContacts: 50,
    defaultRegion: "AU",
  });
  expect(hetero.ok).toBe(true);
  if (hetero.ok) {
    expect(hetero.plan.updateSubBatches.length).toBe(2);
    expect(hetero.plan.updateSubBatches.map((b) => b.fieldMask)).toEqual([
      ["organizations"],
      ["urls"],
    ]);
  }

  const bigBio = "A".repeat(480_000);
  const b1 = sampleContact("b1", { biographies: [{ value: bigBio }] });
  const b2 = sampleContact("b2", { biographies: [{ value: bigBio }] });
  const chunked = compileMutationPlan({
    snapshot: sampleSnapshot([b1, b2]),
    lane: "note-append",
    accountOverride: null,
    audit: null,
    proposals: {
      schemaVersion: "contacts-proposals/1",
      account: "owner@example.com",
      proposals: [
        {
          kind: "note-append",
          target: "people/b1",
          confidence: "high",
          noteLine: "Extra 1",
        },
        {
          kind: "note-append",
          target: "people/b2",
          confidence: "high",
          noteLine: "Extra 2",
        },
      ],
    },
    evidenceItems: [],
    contactFilter: [],
    minConfidence: "high",
    maxContacts: 50,
    defaultRegion: "AU",
  });
  expect(chunked.ok).toBe(true);
  if (chunked.ok) {
    expect(chunked.plan.updateSubBatches.length).toBe(2);
    for (const batch of chunked.plan.updateSubBatches) {
      expect(batch.payloadBytes).toBeLessThan(MAX_STDIN_PAYLOAD_BYTES);
    }
  }

  const s1 = sampleContact("s1", {
    phoneNumbers: [{ value: "+61491570501", type: "mobile" }],
    emailAddresses: [{ value: "s1@acme.example.com", type: "work" }],
  });
  const d1 = sampleContact("d1", {
    names: s1.names,
    phoneNumbers: s1.phoneNumbers,
    emailAddresses: s1.emailAddresses,
  });
  const s2 = sampleContact("s2", {
    phoneNumbers: [{ value: "+61491570502", type: "mobile" }],
    emailAddresses: [{ value: "s2@acme.example.com", type: "work" }],
  });
  const d2 = sampleContact("d2", {
    names: s2.names,
    phoneNumbers: s2.phoneNumbers,
    emailAddresses: s2.emailAddresses,
  });
  const capped = compileMutationPlan({
    snapshot: sampleSnapshot([s1, d1, s2, d2]),
    lane: "duplicate-merge",
    accountOverride: null,
    audit: null,
    proposals: {
      schemaVersion: "contacts-proposals/1",
      account: "owner@example.com",
      proposals: [
        {
          kind: "duplicate-merge",
          target: "people/s1",
          duplicates: ["people/d1"],
        },
        {
          kind: "duplicate-merge",
          target: "people/s2",
          duplicates: ["people/d2"],
        },
      ],
    },
    evidenceItems: [],
    contactFilter: [],
    minConfidence: "high",
    maxContacts: 3,
    defaultRegion: "AU",
  });
  expect(capped.ok).toBe(true);
  if (capped.ok) {
    expect(capped.plan.targetCount).toBe(2);
    expect(capped.plan.mergeClusters.length).toBe(1);
    expect(capped.plan.skipped).toEqual([
      { resourceName: "people/s2", reason: "max-contacts-cap" },
    ]);
  }
});
