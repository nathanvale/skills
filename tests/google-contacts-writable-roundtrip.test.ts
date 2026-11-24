import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContactRecord } from "../src/google-contacts/domain/rules.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import {
  planFromSnapshotFile,
  runContactsCli,
} from "./support/google-contacts-run.ts";
import { testFolder } from "./support/test-folder.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";

setDefaultTimeout(60_000);

const WRITABLE_SUBFIELDS_INDEPENDENT_ORACLE = {
  names: {
    unstructuredName: "Dr Alex Q Example Jr",
    givenName: "Alex",
    middleName: "Q",
    familyName: "Example",
    honorificPrefix: "Dr",
    honorificSuffix: "Jr",
    phoneticFullName: "a-lex kyoo ex-am-pel",
    phoneticGivenName: "a-lex",
    phoneticMiddleName: "kyoo",
    phoneticFamilyName: "ex-am-pel",
    phoneticHonorificPrefix: "doc-tor",
    phoneticHonorificSuffix: "jun-yor",
  },
  phoneNumbers: { value: "+61491570111", type: "mobile" },
  emailAddresses: {
    value: "alex@example.com",
    type: "work",
    displayName: "Alex at Example",
  },
  addresses: {
    formattedValue: "Level 3, 1 Example St, Melbourne VIC 3000",
    poBox: "PO Box 123",
    streetAddress: "1 Example St",
    extendedAddress: "Level 3",
    city: "Melbourne",
    region: "VIC",
    postalCode: "3000",
    country: "Australia",
    countryCode: "AU",
    type: "work",
  },
  organizations: {
    name: "Example Corporation",
    phoneticName: "ex-am-pel",
    title: "Engineer",
    jobDescription: "Builds examples",
    department: "Research",
    symbol: "EXMP",
    domain: "example.com",
    location: "Building 7",
    costCenter: "CC-42",
    fullTimeEquivalentMillipercent: 80_000,
    current: true,
    startDate: { year: 2020, month: 1, day: 2 },
    endDate: { year: 2030, month: 3, day: 4 },
    type: "work",
  },
  biographies: { value: "Original note", contentType: "TEXT_HTML" },
  urls: { value: "https://example.com/alex", type: "profile" },
  birthdays: { date: { year: 1990, month: 5, day: 6 }, text: "6 May 1990" },
  events: { date: { year: 2015, month: 7, day: 8 }, type: "anniversary" },
  relations: { person: "Sam Example", type: "spouse" },
} as const;

const UNMODELLED_SUBFIELD = { "x-unmodelled-subfield": "kept verbatim" };
const CONTACT_METADATA = {
  sourcePrimary: true,
  source: { type: "CONTACT", id: "full" },
};

type Field = keyof typeof WRITABLE_SUBFIELDS_INDEPENDENT_ORACLE;
const FIELDS: readonly Field[] = [
  "names",
  "phoneNumbers",
  "emailAddresses",
  "addresses",
  "organizations",
  "biographies",
  "urls",
  "birthdays",
  "events",
  "relations",
];

const NAMED_LOCAL_PHONE = { value: "0491 570 112", type: "work" };
const UNTOUCHED_AMBIGUOUS_PHONE = { value: "ext 42", type: "other" };

function fullEntry(field: Field): Record<string, unknown> {
  return {
    ...WRITABLE_SUBFIELDS_INDEPENDENT_ORACLE[field],
    ...(field === "organizations" ? UNMODELLED_SUBFIELD : {}),
    metadata: CONTACT_METADATA,
  };
}

function fullContact(id: string): ContactRecord {
  const base = sampleContact(id);
  const entries = Object.fromEntries(
    FIELDS.map((field) => [field, [fullEntry(field)]]),
  );
  return {
    ...base,
    ...entries,
    phoneNumbers: [
      fullEntry("phoneNumbers"),
      NAMED_LOCAL_PHONE,
      UNTOUCHED_AMBIGUOUS_PHONE,
    ].map((entry) => ({ ...entry, value: String(entry.value) })),
  };
}

function minimalAnchoredContact(id: string): ContactRecord {
  return sampleContact(id, {
    names: [{ givenName: "Alex" }],
    phoneNumbers: [{ value: "+61491570111", type: "mobile" }],
    emailAddresses: [{ value: "alex@example.com", type: "work" }],
    organizations: [],
    addresses: [],
  });
}

function subfieldRows(): readonly { field: Field; key: string }[] {
  return FIELDS.flatMap((field) =>
    Object.keys(fullEntry(field)).map((key) => ({ field, key })),
  );
}

const EXPECTED_SUBFIELD_ROWS = 62;

const NOT_APPLICABLE: Readonly<Record<string, string>> = {
  "merge-into-minimal metadata":
    "The Survivor keeps its own per-entry field metadata; a Duplicate's CONTACT source metadata does not transfer.",
};

function holdsValue(
  live: Record<string, unknown>,
  field: Field,
  key: string,
  expected: unknown,
  lane: string,
): boolean {
  const list: unknown = live[field];
  if (!Array.isArray(list)) return false;
  return list.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const actual: unknown = Reflect.get(entry, key);
    if (
      field === "biographies" &&
      key === "value" &&
      typeof actual === "string"
    ) {
      return lane === "merge-into-minimal"
        ? actual.includes(String(expected))
        : actual.startsWith(String(expected));
    }
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

type LaneCase = {
  readonly lane: string;
  readonly planLane: string;
  readonly contacts: readonly ContactRecord[];
  readonly checked: string;
  readonly proposal: unknown;
};

const LANE_CASES: readonly LaneCase[] = [
  {
    lane: "metadata-enrich",
    planLane: "metadata-enrich",
    contacts: [fullContact("full")],
    checked: "people/full",
    proposal: {
      kind: "metadata-enrich",
      target: "people/full",
      confidence: "high",
      organizations: [{ name: "Second Org", title: "Advisor" }],
      addresses: [{ streetAddress: "2 Sample Rd", type: "home" }],
      urls: [{ value: "https://example.org/second" }],
      emailAddresses: [{ value: "second@example.org", type: "other" }],
      events: [{ type: "graduation", date: { year: 2010, month: 12 } }],
      relations: [{ person: "Jo Example", type: "friend" }],
    },
  },
  {
    lane: "phone-normalize",
    planLane: "phone-normalize",
    contacts: [fullContact("full")],
    checked: "people/full",
    proposal: {
      kind: "phone-normalize",
      target: "people/full",
      confidence: "high",
      phoneNumbers: [NAMED_LOCAL_PHONE],
    },
  },
  {
    lane: "note-append",
    planLane: "note-append",
    contacts: [fullContact("full")],
    checked: "people/full",
    proposal: {
      kind: "note-append",
      target: "people/full",
      confidence: "high",
      noteLine: "Appended line",
    },
  },
  {
    lane: "merge-into-full",
    planLane: "duplicate-merge",
    contacts: [fullContact("full"), minimalAnchoredContact("dup")],
    checked: "people/full",
    proposal: {
      kind: "duplicate-merge",
      target: "people/full",
      duplicates: ["people/dup"],
    },
  },
  {
    lane: "merge-into-minimal",
    planLane: "duplicate-merge",
    contacts: [minimalAnchoredContact("min"), fullContact("full")],
    checked: "people/min",
    proposal: {
      kind: "duplicate-merge",
      target: "people/min",
      duplicates: ["people/full"],
    },
  },
];

async function roundTrip(root: string, laneCase: LaneCase) {
  const dir = join(root, laneCase.lane);
  mkdirSync(dir, { recursive: true });
  const ledgerEnv = { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") };
  const gog = createGogStub(dir, {
    account: "owner@example.com",
    contacts: laneCase.contacts,
  });
  const snap = await runContactsCli({ env: ledgerEnv, gogBin: gog.binPath }, [
    "snapshot",
    "--account",
    "owner@example.com",
  ]);
  const snapFile = join(dir, "snap.json");
  writeFileSync(snapFile, JSON.stringify({ result: snap }), "utf8");
  const planned = await planFromSnapshotFile({
    dir,
    snapFile,
    lane: laneCase.planLane,
    proposals: [laneCase.proposal],
  });
  const applied = await runContactsCli(
    { env: ledgerEnv, gogBin: gog.binPath },
    ["apply", "--plan", planned.planFile, "--seal", planned.seal],
  );
  const live = gog
    .readState()
    .contacts.find((contact) => contact.resourceName === laneCase.checked);
  return {
    outcome: `${snap.causeCode}/${planned.run.causeCode}/${applied.causeCode}`,
    live: live === undefined ? {} : { ...live },
  };
}

function phoneListHolds(
  live: Record<string, unknown>,
  matches: (entry: object) => boolean,
): boolean {
  const phones: unknown = live.phoneNumbers;
  return (
    Array.isArray(phones) &&
    phones.some(
      (entry: unknown) =>
        typeof entry === "object" && entry !== null && matches(entry),
    )
  );
}

function phoneRows(live: Record<string, unknown>): readonly {
  readonly expected: string;
  readonly observed: string;
}[] {
  const normalized = phoneListHolds(
    live,
    (entry) =>
      Reflect.get(entry, "value") === "+61491570112" &&
      Reflect.get(entry, "type") === "work",
  );
  const untouchedKept = phoneListHolds(
    live,
    (entry) =>
      JSON.stringify(entry) === JSON.stringify(UNTOUCHED_AMBIGUOUS_PHONE),
  );
  return [
    {
      expected: "phone-normalize named number: +61491570112",
      observed: `phone-normalize named number: ${normalized ? "+61491570112" : "missing"}`,
    },
    {
      expected: "phone-normalize untouched ext 42: kept",
      observed: `phone-normalize untouched ext 42: ${untouchedKept ? "kept" : "erased"}`,
    },
  ];
}

function subfieldOutcomes(
  lane: string,
  live: Record<string, unknown>,
): readonly { readonly expected: string; readonly observed: string }[] {
  const out: { readonly expected: string; readonly observed: string }[] = [];
  for (const { field, key } of subfieldRows()) {
    const rationale = NOT_APPLICABLE[`${lane} ${key}`];
    if (rationale !== undefined) {
      expect(rationale.length).toBeGreaterThan(0);
      continue;
    }
    const kept = holdsValue(live, field, key, fullEntry(field)[key], lane);
    out.push({
      expected: `${lane} ${field}.${key}: kept`,
      observed: `${lane} ${field}.${key}: ${kept ? "kept" : "erased"}`,
    });
  }
  return lane === "phone-normalize" ? [...out, ...phoneRows(live)] : out;
}

test("every writable field and subfield survives snapshot, plan and apply on every lane that writes the Contact", async () => {
  expect(subfieldRows().length).toBe(EXPECTED_SUBFIELD_ROWS);
  const root = testFolder("gc-writable-roundtrip-");
  try {
    const observed: string[] = [];
    const expected: string[] = [];
    for (const laneCase of LANE_CASES) {
      const result = await roundTrip(root, laneCase);
      expected.push(
        `${laneCase.lane}: SUCCESS_UNCHANGED/SUCCESS_UNCHANGED/SUCCESS_COMPLETED`,
      );
      observed.push(`${laneCase.lane}: ${result.outcome}`);
      for (const row of subfieldOutcomes(laneCase.lane, result.live)) {
        expected.push(row.expected);
        observed.push(row.observed);
      }
    }
    expect(observed).toEqual(expected);
  } finally {
    removeOwnedFolder(root);
  }
});
