import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContactRecord } from "../src/google-contacts/domain/rules.ts";
import { computePlanSeal } from "../src/google-contacts/plan-types/rules.ts";
import type {
  MutationPlanBody,
  MutationPlanDoc,
  PlannedContactUpdate,
  UpdateSubBatch,
} from "../src/google-contacts/plan-types/rules.ts";
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

const survivor = sampleContact("s", {
  names: [{ givenName: "Alex", familyName: "Example" }],
  phoneNumbers: [{ value: "+61491570401", type: "mobile" }],
  emailAddresses: [{ value: "alex@example.com", type: "work" }],
  biographies: [{ value: "Survivor original note" }],
});
const duplicate = sampleContact("d", {
  names: [{ givenName: "Alex" }],
  phoneNumbers: [{ value: "+61491570401", type: "mobile" }],
  emailAddresses: [
    { value: "alex@example.com", type: "work" },
    { value: "d.unique@example.com", type: "home" },
  ],
  organizations: [],
});
const unrelated = sampleContact("u", {
  names: [{ givenName: "Robin", familyName: "Sample" }],
  phoneNumbers: [{ value: "+61491570402", type: "mobile" }],
  emailAddresses: [{ value: "robin@example.org", type: "work" }],
});
const noted = sampleContact("n", {
  biographies: [{ value: "Preserve this original note" }],
});
const notedHtml = sampleContact("h", {
  biographies: [{ value: "<b>Original</b>", contentType: "TEXT_HTML" }],
});
const phoned = sampleContact("p", {
  phoneNumbers: [
    { value: "0491 570 403", type: "mobile" },
    { value: "+12025550101", type: "work" },
  ],
});
const enriched = sampleContact("e");
const nicknameField = { nicknames: [{ value: "Sky" }] };
const duplicateWithNickname: ContactRecord = { ...duplicate, ...nicknameField };
const duplicateWithConflictingName: ContactRecord = {
  ...duplicate,
  names: [{ givenName: "Alex", familyName: "Different" }],
};

const MERGE_PROPOSAL = {
  kind: "duplicate-merge",
  target: "people/s",
  duplicates: ["people/d"],
};

type Body = MutationPlanBody;

function bodyOf(plan: MutationPlanDoc): Body {
  const { seal, ...body } = plan;
  expect(seal.startsWith("sha256:")).toBe(true);
  return body;
}

function withFirstUpdate(
  body: Body,
  change: (update: PlannedContactUpdate) => PlannedContactUpdate,
): Body {
  const [batch, ...rest] = body.updateSubBatches;
  if (batch === undefined) throw new Error("Plan has no sub-batch.");
  const [update, ...others] = batch.updates;
  if (update === undefined) throw new Error("Plan has no update.");
  const changed: UpdateSubBatch = {
    ...batch,
    updates: [change(update), ...others],
  };
  return { ...body, updateSubBatches: [changed, ...rest] };
}

function addUnrelatedDelete(body: Body, clusterSurvivor: string | null): Body {
  const [batch] = body.deleteBatches;
  if (batch === undefined) throw new Error("Plan has no delete batch.");
  return {
    ...body,
    targetCount: body.targetCount + 1,
    targets: [
      ...body.targets,
      {
        resourceName: "people/u",
        expectedRevision: unrelated.etag,
        role: clusterSurvivor === null ? "delete" : "duplicate",
      },
    ],
    deleteBatches: [
      {
        ...batch,
        targets: [
          ...batch.targets,
          {
            resourceName: "people/u",
            expectedRevision: unrelated.etag,
            reason: "",
            confirmedByHuman: false,
            clusterSurvivor,
          },
        ],
      },
    ],
  };
}

type ForgedRow = {
  readonly name: string;
  readonly lane: string;
  readonly planned: readonly ContactRecord[];
  readonly live: readonly ContactRecord[];
  readonly proposal: unknown;
  readonly forge: (body: Body) => Body;
};

const MERGE_SET = [survivor, duplicate, unrelated];

const ROWS: readonly ForgedRow[] = [
  {
    name: "deleteBatches and targets gain an unrelated contact outside any Merge cluster",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: MERGE_SET,
    proposal: MERGE_PROPOSAL,
    forge: (body) => addUnrelatedDelete(body, null),
  },
  {
    name: "deleteBatches and targets gain an unrelated contact claiming the cluster's Survivor",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: MERGE_SET,
    proposal: MERGE_PROPOSAL,
    forge: (body) => addUnrelatedDelete(body, "people/s"),
  },
  {
    name: "a delete target's clusterSurvivor names a contact that is not its Survivor",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: MERGE_SET,
    proposal: MERGE_PROPOSAL,
    forge: (body) => ({
      ...body,
      deleteBatches: body.deleteBatches.map((batch) => ({
        ...batch,
        targets: batch.targets.map((del) => ({
          ...del,
          clusterSurvivor: "people/u",
        })),
      })),
    }),
  },
  {
    name: "updateSubBatches gain an overwrite of an unrelated contact in a merge plan",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: MERGE_SET,
    proposal: MERGE_PROPOSAL,
    forge: (body) => ({
      ...body,
      targetCount: body.targetCount + 1,
      targets: [
        ...body.targets,
        {
          resourceName: "people/u",
          expectedRevision: unrelated.etag,
          role: "survivor",
        },
      ],
      updateSubBatches: [
        ...body.updateSubBatches,
        {
          index: body.updateSubBatches.length,
          fieldMask: ["emailAddresses"],
          payloadBytes: 0,
          updates: [
            {
              resourceName: "people/u",
              expectedRevision: unrelated.etag,
              contactSource: {
                type: "CONTACT",
                id: "u",
                etag: unrelated.etag,
              },
              fields: { emailAddresses: [] },
              existingBiography: null,
              appendedLine: null,
              confidence: "high",
            },
          ],
        },
      ],
    }),
  },
  {
    name: "note-append existingBiography claims an empty note and the biography replaces the live one",
    lane: "note-append",
    planned: [noted],
    live: [noted],
    proposal: {
      kind: "note-append",
      target: "people/n",
      confidence: "high",
      noteLine: "Appended line",
    },
    forge: (body) =>
      withFirstUpdate(body, (update) => ({
        ...update,
        existingBiography: "",
        fields: {
          biographies: [{ value: "Replacement destroys original note" }],
        },
      })),
  },
  {
    name: "note-append keeps the live text but rewrites the live note's content type",
    lane: "note-append",
    planned: [notedHtml],
    live: [notedHtml],
    proposal: {
      kind: "note-append",
      target: "people/h",
      confidence: "high",
      noteLine: "Appended line",
    },
    forge: (body) =>
      withFirstUpdate(body, (update) => ({
        ...update,
        fields: {
          biographies: (update.fields.biographies ?? []).map((bio) => ({
            ...bio,
            contentType: "TEXT_PLAIN",
          })),
        },
      })),
  },
  {
    name: "duplicate-merge Survivor existingBiography claims an empty note and drops the live one",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: MERGE_SET,
    proposal: MERGE_PROPOSAL,
    forge: (body) =>
      withFirstUpdate(body, (update) => ({
        ...update,
        existingBiography: "",
        fields: {
          ...update.fields,
          biographies: [{ value: update.appendedLine ?? "" }],
        },
      })),
  },
  {
    name: "duplicate-merge Survivor fields omit a value only the Duplicate holds",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: MERGE_SET,
    proposal: MERGE_PROPOSAL,
    forge: (body) =>
      withFirstUpdate(body, (update) => ({
        ...update,
        fields: {
          ...update.fields,
          emailAddresses: (update.fields.emailAddresses ?? []).filter(
            (email) => email.value !== "d.unique@example.com",
          ),
        },
      })),
  },
  {
    name: "Merge cluster claims no non-allowlisted fields while the live Duplicate carries nicknames",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: [survivor, duplicateWithNickname, unrelated],
    proposal: MERGE_PROPOSAL,
    forge: (body) => body,
  },
  {
    name: "Merge cluster claims no conflicting names while the live Duplicate's family name conflicts",
    lane: "duplicate-merge",
    planned: MERGE_SET,
    live: [survivor, duplicateWithConflictingName, unrelated],
    proposal: MERGE_PROPOSAL,
    forge: (body) => body,
  },
  {
    name: "metadata-enrich organizations drop the live organization",
    lane: "metadata-enrich",
    planned: [enriched],
    live: [enriched],
    proposal: {
      kind: "metadata-enrich",
      target: "people/e",
      confidence: "high",
      organizations: [{ name: "Second Org" }],
    },
    forge: (body) =>
      withFirstUpdate(body, (update) => ({
        ...update,
        fields: { organizations: [{ name: "Second Org" }] },
      })),
  },
  {
    name: "phone-normalize phoneNumbers keep only the named number and drop the other live number",
    lane: "phone-normalize",
    planned: [phoned],
    live: [phoned],
    proposal: {
      kind: "phone-normalize",
      target: "people/p",
      confidence: "high",
      phoneNumbers: [{ value: "0491 570 403", type: "mobile" }],
    },
    forge: (body) =>
      withFirstUpdate(body, (update) => ({
        ...update,
        fields: { phoneNumbers: [{ value: "+61491570403", type: "mobile" }] },
      })),
  },
  {
    name: "phone-normalize writes a non-E.164 number that is not on the live Contact",
    lane: "phone-normalize",
    planned: [phoned],
    live: [phoned],
    proposal: {
      kind: "phone-normalize",
      target: "people/p",
      confidence: "high",
      phoneNumbers: [{ value: "0491 570 403", type: "mobile" }],
    },
    forge: (body) =>
      withFirstUpdate(body, (update) => ({
        ...update,
        fields: {
          phoneNumbers: [
            ...(update.fields.phoneNumbers ?? []),
            { value: "ext 99", type: "other" },
          ],
        },
      })),
  },
  {
    name: "a contact-delete target names a Merge cluster Survivor outside duplicate-merge",
    lane: "contact-delete",
    planned: [unrelated],
    live: [unrelated],
    proposal: {
      kind: "contact-delete",
      target: "people/u",
      humanConfirmed: true,
      reason: "Confirmed stale",
    },
    forge: (body) => ({
      ...body,
      deleteBatches: body.deleteBatches.map((batch) => ({
        ...batch,
        targets: batch.targets.map((del) => ({
          ...del,
          clusterSurvivor: "people/s",
        })),
      })),
    }),
  },
];

const EXPECTED_ROW_COUNT = 14;

function isPlanDoc(value: unknown): value is MutationPlanDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "schemaVersion") === "contacts-plan/1"
  );
}

test("apply refuses every forged plan field that gates a delete or an overwrite, with zero writes", async () => {
  expect(ROWS.length).toBe(EXPECTED_ROW_COUNT);
  const root = testFolder("gc-forged-gates-");
  try {
    const observed: string[] = [];
    for (const [index, row] of ROWS.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { recursive: true });
      const honest = await planFromContacts({
        dir,
        contacts: row.planned,
        lane: row.lane,
        proposals: [row.proposal],
      });
      expect(`${row.name}: ${honest.run.causeCode}`).toBe(
        `${row.name}: SUCCESS_UNCHANGED`,
      );
      if (!isPlanDoc(honest.run.data)) throw new Error("No plan document.");
      const forged = row.forge(bodyOf(honest.run.data));
      const seal = computePlanSeal(forged).value;
      const forgedFile = join(dir, "forged.json");
      writeFileSync(forgedFile, JSON.stringify({ ...forged, seal }), "utf8");
      const gog = createGogStub(dir, {
        account: "owner@example.com",
        contacts: row.live,
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
          (entry) =>
            entry.args.includes("update") || entry.args.includes("delete"),
        ).length;
      const unchanged =
        JSON.stringify(gog.readState().contacts) === JSON.stringify(row.live);
      observed.push(
        `${row.name}: ${applied.causeCode} writes=${String(writes)} addressBookUnchanged=${String(unchanged)}`,
      );
    }
    expect(observed).toEqual(
      ROWS.map(
        (row) =>
          `${row.name}: DOMAIN_CONTACTS_PLAN_INVALID writes=0 addressBookUnchanged=true`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
