import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ContactName } from "../src/google-contacts/domain/rules.ts";
import type { MutationPlanDoc } from "../src/google-contacts/plan-types/rules.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";
import { planFromContacts } from "./support/google-contacts-run.ts";
import { sampleContact } from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(60_000);

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
  {
    name: "a structured name against a conflicting free-form name",
    survivor: { givenName: "Alex", familyName: "Example" },
    duplicate: { unstructuredName: "Completely Different Person" },
    expected: { outcome: "refused" },
  },
  {
    name: "a free-form name against a conflicting structured name",
    survivor: { unstructuredName: "Completely Different Person" },
    duplicate: { givenName: "Alex", familyName: "Example" },
    expected: { outcome: "refused" },
  },
  {
    name: "a structured name whose words sit inside the duplicate's free-form name",
    survivor: { givenName: "Alex", familyName: "Example" },
    duplicate: { unstructuredName: "Alex J. Example" },
    expected: {
      outcome: "merged",
      names: [
        {
          givenName: "Alex",
          familyName: "Example",
          unstructuredName: "Alex J. Example",
        },
      ],
    },
  },
];

function isPlanDoc(value: unknown): value is MutationPlanDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "schemaVersion") === "contacts-plan/1"
  );
}

async function mergeOutcome(
  dir: string,
  row: NameRow,
): Promise<NameRow["expected"]> {
  const survivor = sampleContact("s", { names: [row.survivor], ...ANCHORS });
  const duplicate = sampleContact("d", { names: [row.duplicate], ...ANCHORS });
  const planned = await planFromContacts({
    dir,
    contacts: [survivor, duplicate],
    lane: "duplicate-merge",
    proposals: [
      { kind: "duplicate-merge", target: "people/s", duplicates: ["people/d"] },
    ],
  });
  if (planned.run.causeCode === "DOMAIN_CONTACTS_PLAN_INVALID") {
    return { outcome: "refused" };
  }
  if (!isPlanDoc(planned.run.data)) throw new Error(planned.run.message);
  const names = planned.run.data.updateSubBatches
    .flatMap((batch) => batch.updates)
    .find((update) => update.resourceName === "people/s")?.fields.names;
  return names === undefined
    ? { outcome: "unchanged" }
    : { outcome: "merged", names };
}

test("merges ignore read-only display names and formatting, keep the fuller free-form name, and refuse real conflicts in writable parts, through plan", async () => {
  expect(ROWS.length).toBe(11);
  const root = testFolder("gc-merge-names-");
  try {
    const observed: unknown[] = [];
    for (const [index, row] of ROWS.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { recursive: true });
      observed.push({ row: row.name, ...(await mergeOutcome(dir, row)) });
    }
    expect(observed).toEqual(
      ROWS.map((row) => ({ row: row.name, ...row.expected })),
    );
  } finally {
    removeOwnedFolder(root);
  }
});
