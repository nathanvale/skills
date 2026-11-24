import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContactRecord,
  EvidenceItem,
} from "../src/google-contacts/domain/rules.ts";
import { computePlanSeal } from "../src/google-contacts/plan-types/rules.ts";
import { requirePlanDoc } from "./support/google-contacts-forged.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";
import { runContactsCli } from "./support/google-contacts-run.ts";
import {
  createGogStub,
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(120_000);

const WEB_OFF = "Web research is off in v1";

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
const middleNamed = sampleContact("alexj", {
  names: [
    {
      displayName: "Dr Alex Jordan Example",
      displayNameLastFirst: "Example, Dr Alex Jordan",
      givenName: "Alex",
      middleName: "Jordan",
      familyName: "Example",
    },
  ],
  phoneNumbers: [{ value: "+61491570506", type: "mobile" }],
  emailAddresses: [{ value: "alexj@example.com", type: "work" }],
  organizations: [{ name: "Example Corporation", domain: "example.com" }],
});
const bareMiddleNamed = sampleContact("rileyq", {
  names: [{ givenName: "Riley", middleName: "Quinn", familyName: "Sample" }],
  phoneNumbers: [{ value: "+61491570507", type: "mobile" }],
  emailAddresses: [],
  organizations: [],
});
const CONTACTS: readonly ContactRecord[] = [
  eligible,
  eligibleByName,
  honorific,
  freeFormOnly,
  organisationNamed,
  middleNamed,
  bareMiddleNamed,
];

const QUERIES: readonly (readonly [query: string, target: string])[] = [
  ["Alex Example biography", "people/alex"],
  ['"Alex Example" "Example Corporation"', "people/alex"],
  ["site:example.com Alex Example", "people/alex"],
  ["Example Corporation engineering team", "people/alex"],
  ['"Riley Sample" "Contoso Labs"', "people/riley"],
  ['"Dr Jordan Sample" "Sample Holdings"', "people/jordan"],
  ["Casey Example biography", "people/casey"],
  ['"Fabrikam Studio" "Fabrikam Studio"', "people/fabrikam"],
  ["Fabrikam Studio portfolio", "people/fabrikam"],
  ["Alex Jordan Example biography", "people/alexj"],
  ["Example, Dr Alex Jordan biography", "people/alexj"],
  ["Riley Quinn Sample biography", "people/rileyq"],
];

function webItem(query: string, target: string): EvidenceItem {
  return {
    id: "web-item",
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

async function planNote(
  dir: string,
  target: string,
  item: EvidenceItem | null,
) {
  const snapFile = writeJson(join(dir, "snap.json"), sampleSnapshot(CONTACTS));
  const propFile = writeJson(join(dir, "props.json"), {
    schemaVersion: "contacts-proposals/1",
    account: "owner@example.com",
    proposals: [
      {
        kind: "note-append",
        target,
        confidence: "high",
        noteLine: "Seen on the web",
        ...(item === null ? {} : { evidenceIds: [item.id] }),
      },
    ],
  });
  const evidenceArgs =
    item === null
      ? []
      : [
          "--evidence",
          writeJson(join(dir, "evidence.json"), {
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
          }),
        ];
  return runContactsCli({ env: {} }, [
    "plan",
    "--snapshot",
    snapFile,
    "--lane",
    "note-append",
    "--proposals",
    propFile,
    ...evidenceArgs,
    "--min-confidence",
    "low",
  ]);
}

async function applyWithWebEvidence(
  dir: string,
  item: EvidenceItem,
): Promise<string> {
  const honest = await planNote(dir, item.contactResourceName, null);
  const plan = requirePlanDoc(honest.data, honest.message);
  const { seal: honestSeal, ...body } = plan;
  expect(honestSeal.startsWith("sha256:")).toBe(true);
  const forged = { ...body, evidenceSummary: [item] };
  const seal = computePlanSeal(forged).value;
  const forgedFile = writeJson(join(dir, "forged.json"), { ...forged, seal });
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
  const writes = gog
    .readLog()
    .filter(
      (entry) => entry.args.includes("update") || entry.args.includes("delete"),
    ).length;
  const unchanged =
    JSON.stringify(gog.readState().contacts) === JSON.stringify(CONTACTS);
  return `${applied.causeCode} webOff=${String(applied.message.includes(WEB_OFF))} writes=${String(writes)} addressBookUnchanged=${String(unchanged)}`;
}

test("plan and apply refuse every web evidence item while web research is off in v1, with zero writes", async () => {
  expect(QUERIES.length).toBe(12);
  const root = testFolder("gc-web-off-");
  try {
    const observed: string[] = [];
    for (const [index, [query, target]] of QUERIES.entries()) {
      const item = webItem(query, target);
      const planDir = join(root, `plan-${String(index)}`);
      mkdirSync(planDir, { recursive: true });
      const planned = await planNote(planDir, target, item);
      const applyDir = join(root, `apply-${String(index)}`);
      mkdirSync(applyDir, { recursive: true });
      const applied = await applyWithWebEvidence(applyDir, item);
      observed.push(
        `${JSON.stringify(query)}: plan ${planned.causeCode} webOff=${String(planned.message.includes(WEB_OFF))}; apply ${applied}`,
      );
    }
    expect(observed).toEqual(
      QUERIES.map(
        ([query]) =>
          `${JSON.stringify(query)}: plan DOMAIN_CONTACTS_PLAN_INVALID webOff=true; apply DOMAIN_CONTACTS_PLAN_INVALID webOff=true writes=0 addressBookUnchanged=true`,
      ),
    );
  } finally {
    removeOwnedFolder(root);
  }
});

test("evidence --lane web-queue emits no web research queue and reports the lane off in v1", async () => {
  const dir = testFolder("gc-web-off-queue-");
  try {
    const snapFile = writeJson(
      join(dir, "snap.json"),
      sampleSnapshot(CONTACTS),
    );
    const gog = createGogStub(dir, {
      account: "owner@example.com",
      contacts: CONTACTS,
    });
    const ran = await runContactsCli(
      {
        env: { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") },
        gogBin: gog.binPath,
        platform: "linux",
      },
      ["evidence", "--snapshot", snapFile, "--lane", "web-queue"],
    );
    expect(ran.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(ran.data).toMatchObject({
      lanesRequested: ["web-queue"],
      lanesStatus: { webQueue: { status: "skipped" } },
      webResearchQueue: [],
    });
    expect(JSON.stringify(ran.data)).toContain(WEB_OFF);
  } finally {
    removeOwnedFolder(dir);
  }
});
