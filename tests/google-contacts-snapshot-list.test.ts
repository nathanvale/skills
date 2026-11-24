import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ContactRecord } from "../src/google-contacts/domain/rules.ts";
import type { GogStubBehavior } from "./support/google-contacts-stubs.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import { runContactsCli } from "./support/google-contacts-run.ts";
import { testFolder } from "./support/test-folder.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";

setDefaultTimeout(60_000);

const GOG_BATCH_READ_LIMIT_INDEPENDENT_ORACLE = 200;

const c1 = sampleContact("c1");
const c2 = sampleContact("c2");
const c3 = sampleContact("c3");
const many: readonly ContactRecord[] = Array.from(
  { length: GOG_BATCH_READ_LIMIT_INDEPENDENT_ORACLE + 1 },
  (_, index) => sampleContact(`m${String(index)}`),
);

type ListRow = {
  readonly name: string;
  readonly contacts: readonly ContactRecord[];
  readonly behavior: GogStubBehavior;
  readonly expected: string;
};

const ROWS: readonly ListRow[] = [
  {
    name: "one page of real gog list summaries",
    contacts: [c1, c2],
    behavior: {},
    expected:
      "SUCCESS_UNCHANGED contacts=people/c1,people/c2 missing= listCalls=1 getChunks=2",
  },
  {
    name: "several pages followed through nextPageToken",
    contacts: [c1, c2, c3],
    behavior: { listPages: [[c1], [c2], [c3]] },
    expected:
      "SUCCESS_UNCHANGED contacts=people/c1,people/c2,people/c3 missing= listCalls=3 getChunks=3",
  },
  {
    name: "an empty account with an empty nextPageToken",
    contacts: [],
    behavior: {},
    expected: "SUCCESS_UNCHANGED contacts= missing= listCalls=1 getChunks=",
  },
  {
    name: "more contacts than gog's batch read limit split into chunks",
    contacts: many,
    behavior: {
      listPages: [many.slice(0, 100), many.slice(100, 200), many.slice(200)],
    },
    expected: `SUCCESS_UNCHANGED contacts=${String(many.length)} missing= listCalls=3 getChunks=200,1`,
  },
  {
    name: "a contact deleted between list and batch get is reported missing",
    contacts: [c1],
    behavior: { listPages: [[c1, c2]] },
    expected:
      "SUCCESS_UNCHANGED contacts=people/c1 missing=people/c2 listCalls=1 getChunks=2",
  },
  {
    name: "a malformed page item without a resource name",
    contacts: [c1],
    behavior: {
      listStdoutByPage: {
        "0": '{"contacts":[{"name":"Alex"}],"nextPageToken":""}',
      },
    },
    expected:
      "DOMAIN_CONTACTS_GOG_UNAVAILABLE contacts= missing= listCalls=1 getChunks=",
  },
  {
    name: "a page that is not JSON",
    contacts: [c1],
    behavior: { listStdoutByPage: { "0": "{not json" } },
    expected:
      "DOMAIN_CONTACTS_GOG_UNAVAILABLE contacts= missing= listCalls=1 getChunks=",
  },
  {
    name: "a page of full Person objects no gog release emits from list",
    contacts: [c1],
    behavior: {
      listStdoutByPage: {
        "0": JSON.stringify({ contacts: [c1], nextPageToken: "" }),
      },
    },
    expected:
      "DOMAIN_CONTACTS_GOG_UNAVAILABLE contacts= missing= listCalls=1 getChunks=",
  },
  {
    name: "the second batch get chunk fails with an auth exit",
    contacts: many,
    behavior: {
      listPages: [many.slice(0, 100), many.slice(100, 200), many.slice(200)],
      batchGetExitByCall: { "2": 4 },
    },
    expected:
      "DOMAIN_CONTACTS_GOG_UNAVAILABLE contacts= missing= listCalls=3 getChunks=200,1",
  },
  {
    name: "a batch get chunk returns an unrecognised object",
    contacts: [c1, c2],
    behavior: { batchGetStdoutByCall: { "1": '{"unexpected":true}' } },
    expected:
      "DOMAIN_CONTACTS_GOG_UNAVAILABLE contacts= missing= listCalls=1 getChunks=2",
  },
  {
    name: "a batch get chunk hits a rate limit",
    contacts: [c1, c2],
    behavior: { batchGetExit: 7 },
    expected:
      "TRANSIENT_NOT_STARTED contacts= missing= listCalls=1 getChunks=2",
  },
];

const EXPECTED_ROW_COUNT = 11;

function listOf(data: unknown, key: string): readonly unknown[] {
  const value: unknown =
    typeof data === "object" && data !== null ? Reflect.get(data, key) : null;
  return Array.isArray(value) ? value : [];
}

function contactsSummary(data: unknown): string {
  const contacts = listOf(data, "contacts");
  if (contacts.length > 10) return String(contacts.length);
  return contacts
    .map((entry: unknown) =>
      typeof entry === "object" && entry !== null
        ? String(Reflect.get(entry, "resourceName"))
        : "",
    )
    .join(",");
}

test("snapshot without --contact settles every real gog list and batch get shape to its required outcome", async () => {
  expect(ROWS.length).toBe(EXPECTED_ROW_COUNT);
  const root = testFolder("gc-snapshot-list-");
  try {
    const observed: string[] = [];
    for (const [index, row] of ROWS.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { recursive: true });
      const gog = createGogStub(dir, {
        account: "owner@example.com",
        contacts: row.contacts,
        behavior: row.behavior,
      });
      const snap = await runContactsCli(
        {
          env: { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") },
          gogBin: gog.binPath,
        },
        ["snapshot", "--account", "owner@example.com"],
      );
      const log = gog.readLog();
      const listCalls = log.filter((entry) => entry.args[1] === "list").length;
      const getChunks = log
        .filter((entry) => entry.args[2] === "get")
        .map(
          (entry) =>
            entry.args.filter((arg) => arg.startsWith("people/")).length,
        );
      observed.push(
        `${row.name}: ${snap.causeCode} contacts=${contactsSummary(snap.data)} missing=${listOf(snap.data, "missingContacts").join(",")} listCalls=${String(listCalls)} getChunks=${getChunks.join(",")}`,
      );
    }
    expect(observed).toEqual(ROWS.map((row) => `${row.name}: ${row.expected}`));
  } finally {
    removeOwnedFolder(root);
  }
});
