import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ContactRecord } from "../src/google-contacts/domain/rules.ts";
import type { GogStubBehavior } from "./support/google-contacts-stubs.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import {
  planFromContacts,
  runContactsCli,
} from "./support/google-contacts-run.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(60_000);

function nestedGetOutput(
  persons: readonly { readonly resourceName: string }[],
): string {
  return JSON.stringify({
    operation: "get",
    requested: persons.length,
    completed: persons.length,
    batches: [
      {
        batch: 1,
        state: "completed",
        response: {
          responses: persons.map((person) => ({
            httpStatusCode: 200,
            person,
            requestedResourceName: person.resourceName,
          })),
        },
      },
    ],
  });
}

const target = sampleContact("rb", { biographies: [{ value: "Keep me" }] });
const targetWithoutEtag = Object.fromEntries(
  Object.entries(target).filter(([key]) => key !== "etag"),
);

type ShapeRow = {
  readonly name: string;
  readonly lane: "note-append" | "contact-delete";
  readonly stubContacts: readonly ContactRecord[];
  readonly behavior: GogStubBehavior;
  readonly expectedCause: string;
  readonly expectWrites: boolean;
};

const deleteNotApplied = { mutateOnDelete: false } as const;

const ROWS: readonly ShapeRow[] = [
  {
    name: "real gog v0.48.1 nested shape lets an unchanged contact pass the revision check and confirms the update",
    lane: "note-append",
    stubContacts: [target],
    behavior: {},
    expectedCause: "SUCCESS_COMPLETED",
    expectWrites: true,
  },
  {
    name: "a genuine etag mismatch in the nested shape is still refused before any write",
    lane: "note-append",
    stubContacts: [{ ...target, etag: "etag-rb-v2" }],
    behavior: {},
    expectedCause: "DOMAIN_CONTACTS_REVISION_DRIFT",
    expectWrites: false,
  },
  {
    name: "a per-person NOT_FOUND at exit 1 before the transaction is refused as drift",
    lane: "note-append",
    stubContacts: [],
    behavior: {},
    expectedCause: "DOMAIN_CONTACTS_REVISION_DRIFT",
    expectWrites: false,
  },
  {
    name: "an unrecognised object at exit 0 before the transaction is refused with zero writes",
    lane: "note-append",
    stubContacts: [target],
    behavior: { batchGetStdoutByCall: { "1": '{"unexpected":true}' } },
    expectedCause: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
    expectWrites: false,
  },
  {
    name: "the flat responses shape no gog release emits is unrecognised on read-back",
    lane: "note-append",
    stubContacts: [target],
    behavior: {
      batchGetStdoutByCall: {
        "2": JSON.stringify({ responses: [{ person: target }] }),
      },
    },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "empty stdout at exit 0 on read-back is unconfirmed",
    lane: "note-append",
    stubContacts: [target],
    behavior: { batchGetStdoutByCall: { "2": "" } },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "malformed JSON on read-back is unconfirmed",
    lane: "note-append",
    stubContacts: [target],
    behavior: { batchGetStdoutByCall: { "2": "{not json" } },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "an error object at exit 0 on read-back is unconfirmed",
    lane: "note-append",
    stubContacts: [target],
    behavior: {
      batchGetStdoutByCall: { "2": '{"error":"Invalid read-back schema"}' },
    },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "a nested person missing its etag on read-back is unconfirmed",
    lane: "note-append",
    stubContacts: [target],
    behavior: {
      batchGetStdoutByCall: {
        "2": nestedGetOutput([
          { ...targetWithoutEtag, resourceName: target.resourceName },
        ]),
      },
    },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "exit 5 with no stdout on read-back is not read as confirmed absence",
    lane: "note-append",
    stubContacts: [target],
    behavior: { batchGetExitByCall: { "2": 5 } },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "a delete confirmed by a per-person NOT_FOUND at exit 1 settles completed",
    lane: "contact-delete",
    stubContacts: [target],
    behavior: {},
    expectedCause: "SUCCESS_COMPLETED",
    expectWrites: true,
  },
  {
    name: "a delete that never happened is not confirmed by an unrecognised object at exit 0",
    lane: "contact-delete",
    stubContacts: [target],
    behavior: {
      ...deleteNotApplied,
      batchGetStdoutByCall: { "3": '{"unexpected":true}' },
    },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "a delete that never happened is not confirmed by an error object at exit 0",
    lane: "contact-delete",
    stubContacts: [target],
    behavior: {
      ...deleteNotApplied,
      batchGetStdoutByCall: { "3": '{"error":"Invalid read-back schema"}' },
    },
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
  {
    name: "a delete that never happened and still reads back present is unconfirmed",
    lane: "contact-delete",
    stubContacts: [target],
    behavior: deleteNotApplied,
    expectedCause: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
    expectWrites: true,
  },
];

const EXPECTED_ROW_COUNT = 14;

function proposalFor(lane: ShapeRow["lane"]): unknown {
  return lane === "note-append"
    ? {
        kind: "note-append",
        target: "people/rb",
        confidence: "high",
        noteLine: "Appended by shape table",
      }
    : {
        kind: "contact-delete",
        target: "people/rb",
        humanConfirmed: true,
        reason: "Shape table delete",
      };
}

test("the read-back shape table settles every gog batch get shape to its required outcome", async () => {
  expect(ROWS.length).toBe(EXPECTED_ROW_COUNT);
  const root = testFolder("gc-readback-shapes-");
  try {
    const settled: string[] = [];
    for (const [index, row] of ROWS.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { recursive: true });
      const planned = await planFromContacts({
        dir,
        contacts: [target],
        lane: row.lane,
        proposals: [proposalFor(row.lane)],
      });
      expect(planned.run.causeCode).toBe("SUCCESS_UNCHANGED");
      const gog = createGogStub(dir, {
        account: "owner@example.com",
        contacts: row.stubContacts,
        behavior: row.behavior,
      });
      const applied = await runContactsCli(
        {
          env: { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") },
          gogBin: gog.binPath,
        },
        ["apply", "--plan", planned.planFile, "--seal", planned.seal],
      );
      const wrote = gog
        .readLog()
        .some(
          (entry) =>
            entry.args.includes("update") || entry.args.includes("delete"),
        );
      settled.push(`${row.name}: ${applied.causeCode} writes=${String(wrote)}`);
    }
    expect(settled).toEqual(
      ROWS.map(
        (row) =>
          `${row.name}: ${row.expectedCause} writes=${String(row.expectWrites)}`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
