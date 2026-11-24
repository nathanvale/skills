import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContactRecord } from "../src/google-contacts/domain/rules.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";
import {
  planFromSnapshotFile,
  runContactsCli,
} from "./support/google-contacts-run.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(60_000);

const survivor = sampleContact("ps", {
  names: [{ givenName: "Alex", familyName: "Example" }],
  phoneNumbers: [{ value: "+61491570611", type: "mobile" }],
  emailAddresses: [{ value: "alex.ps@example.com", type: "work" }],
});

function duplicateWith(extra: Readonly<Record<string, unknown>>) {
  const base = sampleContact("pd", {
    names: [{ givenName: "Alex" }],
    phoneNumbers: [{ value: "+61491570611", type: "mobile" }],
    emailAddresses: [{ value: "alex.ps@example.com", type: "work" }],
    organizations: [],
  });
  const duplicate: ContactRecord = { ...base, ...extra };
  return duplicate;
}

const CONTACT_SOURCE = { source: { type: "CONTACT", id: "pd" } };

type ProtectedRow = {
  readonly name: string;
  readonly duplicate: ContactRecord;
  readonly expectedApply: string;
  readonly expectedWrites: boolean;
  readonly duplicateRemains: boolean;
};

const ROWS: readonly ProtectedRow[] = [
  {
    name: "a non-default CONTACT photo on the Duplicate",
    duplicate: duplicateWith({
      photos: [
        {
          url: "https://example.org/photo.jpg",
          default: false,
          metadata: CONTACT_SOURCE,
        },
      ],
    }),
    expectedApply: "DOMAIN_CONTACTS_PLAN_INVALID",
    expectedWrites: false,
    duplicateRemains: true,
  },
  {
    name: "CONTACT skills on the Duplicate",
    duplicate: duplicateWith({
      skills: [{ value: "Bookbinding", metadata: CONTACT_SOURCE }],
    }),
    expectedApply: "DOMAIN_CONTACTS_PLAN_INVALID",
    expectedWrites: false,
    duplicateRemains: true,
  },
  {
    name: "a CONTACT file-as value on the Duplicate",
    duplicate: duplicateWith({
      fileAses: [{ value: "Example, Alex", metadata: CONTACT_SOURCE }],
    }),
    expectedApply: "DOMAIN_CONTACTS_PLAN_INVALID",
    expectedWrites: false,
    duplicateRemains: true,
  },
  {
    name: "only the default placeholder photo on the Duplicate",
    duplicate: duplicateWith({
      photos: [
        {
          url: "https://example.org/default.png",
          default: true,
          metadata: CONTACT_SOURCE,
        },
      ],
    }),
    expectedApply: "SUCCESS_COMPLETED",
    expectedWrites: true,
    duplicateRemains: false,
  },
];

test("a merge is refused at apply when the Duplicate holds a protected field that gog's batch read mask hides from snapshot", async () => {
  expect(ROWS.length).toBe(4);
  const root = testFolder("gc-protected-fields-");
  try {
    const observed: string[] = [];
    for (const [index, row] of ROWS.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { recursive: true });
      const gog = createGogStub(dir, {
        account: "owner@example.com",
        contacts: [survivor, row.duplicate],
      });
      const options = {
        env: { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") },
        gogBin: gog.binPath,
      };
      const snapshot = await runContactsCli(options, [
        "snapshot",
        "--account",
        "owner@example.com",
      ]);
      const snapFile = join(dir, "snapshot.json");
      writeFileSync(snapFile, JSON.stringify({ result: snapshot }), "utf8");
      const planned = await planFromSnapshotFile({
        dir,
        snapFile,
        lane: "duplicate-merge",
        proposals: [
          {
            kind: "duplicate-merge",
            target: "people/ps",
            duplicates: ["people/pd"],
          },
        ],
      });
      const applied = await runContactsCli(options, [
        "apply",
        "--plan",
        planned.planFile,
        "--seal",
        planned.seal,
      ]);
      const writes = gog
        .readLog()
        .some(
          (entry) =>
            entry.args.includes("update") || entry.args.includes("delete"),
        );
      const remains = gog
        .readState()
        .contacts.some((contact) => contact.resourceName === "people/pd");
      observed.push(
        `${row.name}: snapshot ${snapshot.causeCode}, plan ${planned.run.causeCode}, apply ${applied.causeCode}, writes=${String(writes)}, duplicateRemains=${String(remains)}`,
      );
    }
    expect(observed).toEqual(
      ROWS.map(
        (row) =>
          `${row.name}: snapshot SUCCESS_UNCHANGED, plan SUCCESS_UNCHANGED, apply ${row.expectedApply}, writes=${String(row.expectedWrites)}, duplicateRemains=${String(row.duplicateRemains)}`,
      ),
    );
  } finally {
    removeOwnedFolder(root);
  }
});
