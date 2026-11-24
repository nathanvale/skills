import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContactRecord,
  EvidenceItem,
} from "../src/google-contacts/domain/rules.ts";
import { computePlanSeal } from "../src/google-contacts/plan-types/rules.ts";
import { isPlanDoc } from "./support/google-contacts-forged.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";
import { runContactsCli } from "./support/google-contacts-run.ts";
import {
  createGogStub,
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(120_000);

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
const honorific = sampleContact("jordan", {
  names: [
    {
      displayName: "Dr Jordan Sample",
      givenName: "Jordan",
      familyName: "Sample",
    },
  ],
  phoneNumbers: [{ value: "+61491570503", type: "mobile" }],
  emailAddresses: [{ value: "jordan@sample.example.org", type: "work" }],
  organizations: [{ name: "Sample Holdings", domain: "sample.example.org" }],
});
const freeFormOnly = sampleContact("casey", {
  names: [{ unstructuredName: "Casey   Example" }],
  phoneNumbers: [{ value: "+61491570504", type: "mobile" }],
  emailAddresses: [],
  organizations: [],
});
const organisationNamed = sampleContact("fabrikam", {
  names: [{ displayName: "Fabrikam Studio" }],
  phoneNumbers: [{ value: "+61491570505", type: "mobile" }],
  emailAddresses: [],
  organizations: [{ name: "Fabrikam Studio" }],
});
const CONTACTS: readonly ContactRecord[] = [
  eligible,
  eligibleByName,
  honorific,
  freeFormOnly,
  organisationNamed,
];

type AnchorRow = {
  readonly query: string;
  readonly target: string;
  readonly expected: "refused" | "accepted";
};

const ROWS: readonly AnchorRow[] = [
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
  {
    query: "Jordan Sample biography",
    target: "people/jordan",
    expected: "refused",
  },
  {
    query: '"Dr Jordan Sample" "Sample Holdings"',
    target: "people/jordan",
    expected: "accepted",
  },
  {
    query: "Casey Example biography",
    target: "people/casey",
    expected: "refused",
  },
  {
    query: "Alex  Example biography",
    target: "people/alex",
    expected: "refused",
  },
  {
    query: "Riley\tSample biography",
    target: "people/riley",
    expected: "refused",
  },
  {
    query: "Alex Example example.completely biography",
    target: "people/alex",
    expected: "refused",
  },
  {
    query: '"Fabrikam Studio" "Fabrikam Studio"',
    target: "people/fabrikam",
    expected: "accepted",
  },
];

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

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

async function planWithItem(dir: string, item: EvidenceItem) {
  const snapFile = writeJson(join(dir, "snap.json"), sampleSnapshot(CONTACTS));
  const propFile = writeJson(join(dir, "props.json"), {
    schemaVersion: "contacts-proposals/1",
    account: "owner@example.com",
    proposals: [
      {
        kind: "note-append",
        target: item.contactResourceName,
        noteLine: "Seen on the web",
        evidenceIds: [item.id],
      },
    ],
  });
  const evidenceFile = writeJson(join(dir, "evidence.json"), {
    schemaVersion: "contacts-evidence/1",
    account: "owner@example.com",
    lanesRequested: ["web-queue"],
    lanesStatus: {
      gmail: { status: "skipped", detail: "Not requested." },
      imsg: { status: "skipped", detail: "Not requested." },
      webQueue: { status: "ready", detail: "Host web search." },
    },
    items: [item],
    webResearchQueue: [],
  });
  return runContactsCli({ env: {} }, [
    "plan",
    "--snapshot",
    snapFile,
    "--lane",
    "note-append",
    "--proposals",
    propFile,
    "--evidence",
    evidenceFile,
    "--min-confidence",
    "low",
  ]);
}

test("plan and apply refuse a web query naming any personal-name variant of a Contact without its organization or domain anchor", async () => {
  expect(ROWS.length).toBe(14);
  const root = testFolder("gc-web-anchor-");
  try {
    const honestDir = join(root, "honest");
    mkdirSync(honestDir, { recursive: true });
    const honest = await planWithItem(
      honestDir,
      webItem('"Alex Example" "Example Corporation"', "people/alex"),
    );
    if (!isPlanDoc(honest.data)) throw new Error(honest.message);
    const { seal: honestSeal, ...body } = honest.data;
    expect(honestSeal.startsWith("sha256:")).toBe(true);
    const observed: string[] = [];
    for (const [index, row] of ROWS.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { recursive: true });
      const item = webItem(row.query, row.target);
      const planned = await planWithItem(dir, item);
      const forged = { ...body, evidenceSummary: [item] };
      const seal = computePlanSeal(forged).value;
      const forgedFile = writeJson(join(dir, "forged.json"), {
        ...forged,
        seal,
      });
      const gog = createGogStub(dir, {
        account: "owner@example.com",
        contacts: CONTACTS,
      });
      const applied = await runContactsCli(
        {
          env: { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") },
          gogBin: gog.binPath,
        },
        ["apply", "--plan", forgedFile, "--seal", seal],
      );
      observed.push(
        `${JSON.stringify(row.query)}: plan ${planned.causeCode}, apply ${applied.causeCode}`,
      );
    }
    expect(observed).toEqual(
      ROWS.map((row) =>
        row.expected === "accepted"
          ? `${JSON.stringify(row.query)}: plan SUCCESS_UNCHANGED, apply SUCCESS_COMPLETED`
          : `${JSON.stringify(row.query)}: plan DOMAIN_CONTACTS_PLAN_INVALID, apply DOMAIN_CONTACTS_PLAN_INVALID`,
      ),
    );
  } finally {
    removeOwnedFolder(root);
  }
});
