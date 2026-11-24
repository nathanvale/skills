import { expect, test } from "bun:test";
import type { ContactName } from "../src/google-contacts/domain/rules.ts";
import { computeDuplicateMerge } from "../src/google-contacts/merge/rules.ts";
import { sampleContact } from "./support/google-contacts-stubs.ts";

const ANCHORS = {
  phoneNumbers: [{ value: "+61491570701", type: "mobile" }],
  emailAddresses: [{ value: "alex@example.com", type: "work" }],
  organizations: [],
};

type NameRow = {
  readonly name: string;
  readonly survivor: ContactName;
  readonly duplicate: ContactName;
  readonly expected:
    | { readonly outcome: "refused" }
    | { readonly outcome: "unchanged" }
    | { readonly outcome: "merged"; readonly names: readonly ContactName[] };
};

const ROWS: readonly NameRow[] = [
  {
    name: "Alex Example into Alex J. Example, where the read-only display names and the free-form name differ",
    survivor: {
      displayName: "Alex Example",
      displayNameLastFirst: "Example, Alex",
      unstructuredName: "Alex Example",
      givenName: "Alex",
      familyName: "Example",
    },
    duplicate: {
      displayName: "Alex J. Example",
      displayNameLastFirst: "Example, Alex J.",
      unstructuredName: "Alex J. Example",
      givenName: "Alex",
      middleName: "J.",
      familyName: "Example",
    },
    expected: {
      outcome: "merged",
      names: [
        {
          unstructuredName: "Alex J. Example",
          givenName: "Alex",
          middleName: "J.",
          familyName: "Example",
        },
      ],
    },
  },
  {
    name: "only the read-only display names differ and the duplicate adds a middle name",
    survivor: {
      displayName: "Alex Example",
      givenName: "Alex",
      familyName: "Example",
    },
    duplicate: {
      displayName: "Alex J. Example",
      givenName: "Alex",
      middleName: "J.",
      familyName: "Example",
    },
    expected: {
      outcome: "merged",
      names: [{ givenName: "Alex", middleName: "J.", familyName: "Example" }],
    },
  },
  {
    name: "an honorific differs only by a full stop",
    survivor: {
      givenName: "Alex",
      familyName: "Example",
      honorificPrefix: "Dr",
    },
    duplicate: {
      givenName: "Alex",
      familyName: "Example",
      honorificPrefix: "Dr.",
    },
    expected: { outcome: "unchanged" },
  },
  {
    name: "parts differ only by case and spacing",
    survivor: { givenName: "Alex", familyName: "Example" },
    duplicate: { givenName: "alex", familyName: " Example " },
    expected: { outcome: "unchanged" },
  },
  {
    name: "a middle initial differs only by a full stop",
    survivor: { givenName: "Alex", middleName: "J", familyName: "Example" },
    duplicate: { givenName: "Alex", middleName: "J.", familyName: "Example" },
    expected: { outcome: "unchanged" },
  },
  {
    name: "a real conflict in the family name",
    survivor: { givenName: "Alex", familyName: "Example" },
    duplicate: { givenName: "Alex", familyName: "Sample" },
    expected: { outcome: "refused" },
  },
  {
    name: "a real conflict in the middle name",
    survivor: { givenName: "Alex", middleName: "J.", familyName: "Example" },
    duplicate: { givenName: "Alex", middleName: "Q.", familyName: "Example" },
    expected: { outcome: "refused" },
  },
  {
    name: "a real conflict in the free-form name alone",
    survivor: { unstructuredName: "Alex Example" },
    duplicate: { unstructuredName: "Sam Example" },
    expected: { outcome: "refused" },
  },
];

function mergeOutcome(row: NameRow): NameRow["expected"] {
  const survivor = sampleContact("s", { names: [row.survivor], ...ANCHORS });
  const duplicate = sampleContact("d", { names: [row.duplicate], ...ANCHORS });
  const merged = computeDuplicateMerge({
    survivor,
    duplicates: [duplicate],
    allContacts: [survivor, duplicate],
    defaultRegion: "AU",
    humanConfirmed: false,
    reason: null,
  });
  if (!merged.ok) return { outcome: "refused" };
  const names = merged.survivorFields.names;
  return names === undefined
    ? { outcome: "unchanged" }
    : { outcome: "merged", names };
}

test("merges ignore read-only display names and formatting, keep the fuller free-form name, and refuse real conflicts in writable parts", () => {
  expect(ROWS.length).toBe(8);
  expect(ROWS.map((row) => ({ row: row.name, ...mergeOutcome(row) }))).toEqual(
    ROWS.map((row) => ({ row: row.name, ...row.expected })),
  );
});
