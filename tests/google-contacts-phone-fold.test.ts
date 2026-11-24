import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContactPhone,
  ContactRecord,
} from "../src/google-contacts/domain/rules.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";
import { runContactsCli } from "./support/google-contacts-run.ts";
import type { CliRun } from "./support/google-contacts-run.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(120_000);

type FoldRow = {
  readonly name: string;
  readonly phones: readonly ContactPhone[];
  readonly expected: readonly ContactPhone[];
};

const ROWS: readonly FoldRow[] = [
  {
    name: "local home before E.164 mobile",
    phones: [
      { value: "0491 570 404", type: "home" },
      { value: "+61491570404", type: "mobile" },
    ],
    expected: [{ value: "+61491570404", type: "mobile" }],
  },
  {
    name: "E.164 mobile before local home",
    phones: [
      { value: "+61491570404", type: "mobile" },
      { value: "0491 570 404", type: "home" },
    ],
    expected: [{ value: "+61491570404", type: "mobile" }],
  },
  {
    name: "local mobile before E.164 mobile",
    phones: [
      { value: "0491 570 404", type: "mobile" },
      { value: "+61491570404", type: "mobile" },
    ],
    expected: [{ value: "+61491570404", type: "mobile" }],
  },
  {
    name: "E.164 mobile before local other",
    phones: [
      { value: "+61491570404", type: "mobile" },
      { value: "0491 570 404", type: "other" },
    ],
    expected: [{ value: "+61491570404", type: "mobile" }],
  },
];

function writeEnvelope(path: string, run: CliRun): string {
  writeFileSync(path, JSON.stringify({ result: run }), "utf8");
  return path;
}

function sealOf(run: CliRun): string {
  return typeof run.data === "object" && run.data !== null
    ? String(Reflect.get(run.data, "seal"))
    : "";
}

async function foldThroughCli(dir: string, row: FoldRow): Promise<string> {
  const contact: ContactRecord = sampleContact("f1", {
    phoneNumbers: row.phones,
  });
  const gog = createGogStub(dir, {
    account: "owner@example.com",
    contacts: [contact],
  });
  const options = {
    env: { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") },
    gogBin: gog.binPath,
    platform: "linux",
  } as const;
  const snap = await runContactsCli(options, [
    "snapshot",
    "--account",
    "owner@example.com",
  ]);
  const snapFile = writeEnvelope(join(dir, "snap.json"), snap);
  const audit = await runContactsCli(options, [
    "audit",
    "--snapshot",
    snapFile,
    "--default-region",
    "AU",
  ]);
  const auditFile = writeEnvelope(join(dir, "audit.json"), audit);
  const plan = await runContactsCli(options, [
    "plan",
    "--snapshot",
    snapFile,
    "--lane",
    "phone-normalize",
    "--audit",
    auditFile,
  ]);
  const planFile = writeEnvelope(join(dir, "plan.json"), plan);
  const applied = await runContactsCli(options, [
    "apply",
    "--plan",
    planFile,
    "--seal",
    sealOf(plan),
  ]);
  const stored = gog
    .readState()
    .contacts.find((item) => item.resourceName === "people/f1");
  return `${row.name}: ${snap.causeCode} ${audit.causeCode} ${plan.causeCode} ${applied.causeCode} ${JSON.stringify(stored?.phoneNumbers ?? null)}`;
}

test("an honest phone-normalize plan folds a local number into its live E.164 twin through snapshot, audit, plan and apply", async () => {
  expect(ROWS.length).toBe(4);
  const root = testFolder("gc-phone-fold-");
  try {
    const observed: string[] = [];
    for (const [index, row] of ROWS.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { recursive: true });
      observed.push(await foldThroughCli(dir, row));
    }
    expect(observed).toEqual(
      ROWS.map(
        (row) =>
          `${row.name}: SUCCESS_UNCHANGED SUCCESS_UNCHANGED SUCCESS_UNCHANGED SUCCESS_COMPLETED ${JSON.stringify(row.expected)}`,
      ),
    );
  } finally {
    removeOwnedFolder(root);
  }
});
