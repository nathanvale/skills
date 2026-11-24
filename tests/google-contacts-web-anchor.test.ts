import { expect, test } from "bun:test";
import type { EvidenceItem } from "../src/google-contacts/domain/rules.ts";
import { compileMutationPlan } from "../src/google-contacts/plan/rules.ts";
import { computePlanSeal } from "../src/google-contacts/plan-types/rules.ts";
import { validateMutationPlan } from "../src/google-contacts/plan-validate/rules.ts";
import {
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";

const eligible = sampleContact("alex", {
  names: [{ displayName: "Alex Example" }],
  phoneNumbers: [{ value: "+61491570501", type: "mobile" }],
  emailAddresses: [{ value: "alex@example.com", type: "work" }],
  organizations: [
    { name: "Example Corporation", title: "Engineer", domain: "example.com" },
  ],
});
const eligibleByName = sampleContact("riley", {
  names: [{ displayName: "Riley Sample" }],
  phoneNumbers: [{ value: "+61491570502", type: "mobile" }],
  emailAddresses: [],
  organizations: [{ name: "Contoso Labs" }],
});
const snapshot = sampleSnapshot([eligible, eligibleByName]);

function webItem(query: string, target: string): EvidenceItem {
  return {
    id: "web-anchor",
    lane: "web",
    contactResourceName: target,
    anchor: null,
    sourceRef: "https://example.org/profile",
    observedAt: null,
    excerpt: "Profile",
    query,
    suggestedFields: {},
  };
}

function compile(item: EvidenceItem) {
  return compileMutationPlan({
    snapshot,
    lane: "note-append",
    accountOverride: null,
    audit: null,
    proposals: {
      schemaVersion: "contacts-proposals/1",
      account: snapshot.account,
      proposals: [
        {
          kind: "note-append",
          target: item.contactResourceName,
          noteLine: "Seen on the web",
          evidenceIds: [item.id],
        },
      ],
    },
    evidenceItems: [item],
    contactFilter: [],
    minConfidence: "low",
    maxContacts: 50,
    defaultRegion: "AU",
  });
}

const ROWS: readonly {
  readonly query: string;
  readonly target: string;
  readonly expected: "refused" | "accepted";
}[] = [
  {
    query: "Alex Example biography",
    target: "people/alex",
    expected: "refused",
  },
  { query: "alex example", target: "people/alex", expected: "refused" },
  { query: "Riley Sample career", target: "people/riley", expected: "refused" },
  {
    query: '"Alex Example" "Example Corporation"',
    target: "people/alex",
    expected: "accepted",
  },
  {
    query: "site:example.com Alex Example",
    target: "people/alex",
    expected: "accepted",
  },
  {
    query: '"Riley Sample" "Contoso Labs"',
    target: "people/riley",
    expected: "accepted",
  },
  {
    query: "Example Corporation engineering team",
    target: "people/alex",
    expected: "accepted",
  },
];

test("plan and apply refuse a web query naming a web-eligible Contact's personal name without its organization or domain anchor", () => {
  expect(ROWS.length).toBe(7);
  const anchoredPlan = compile(
    webItem('"Alex Example" "Example Corporation"', "people/alex"),
  );
  if (!anchoredPlan.ok) throw new Error(anchoredPlan.reason);
  const { seal, ...body } = anchoredPlan.plan;
  expect(seal.startsWith("sha256:")).toBe(true);
  const observed = ROWS.map((row) => {
    const item = webItem(row.query, row.target);
    const planned = compile(item);
    const forged = { ...body, evidenceSummary: [item] };
    const applyErr = validateMutationPlan({
      ...forged,
      seal: computePlanSeal(forged).value,
    });
    const planVerdict = planned.ok ? "accepted" : "refused";
    const applyVerdict = applyErr === null ? "accepted" : "refused";
    return `${row.query}: plan ${planVerdict}, apply ${applyVerdict}`;
  });
  expect(observed).toEqual(
    ROWS.map(
      (row) => `${row.query}: plan ${row.expected}, apply ${row.expected}`,
    ),
  );
});
