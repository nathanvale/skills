import { expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { createGoogleContactsCli } from "../src/google-contacts/cli.ts";
import type { EvidenceItem } from "../src/google-contacts/domain/rules.ts";
import { compileMutationPlan } from "../src/google-contacts/plan/rules.ts";
import { computePlanSeal } from "../src/google-contacts/plan-types/rules.ts";
import type {
  MutationPlanBody,
  MutationPlanDoc,
} from "../src/google-contacts/plan-types/rules.ts";
import { validateMutationPlan } from "../src/google-contacts/plan-validate/rules.ts";
import {
  createGogStub,
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";
import { removeOwnedFolder } from "./support/google-contacts-processes.ts";

setDefaultTimeout(30_000);

function reseal(body: MutationPlanBody): MutationPlanDoc {
  return { ...body, seal: computePlanSeal(body).value };
}

test("plan rejects web PII leaks and web-only high confidence; apply rejects forged sealed plans", async () => {
  const dir = testFolder("gc-forged-plan-");
  try {
    const freeMail = ["leaked", "gmail.com"].join("@");
    const bare = sampleContact("bare", {
      names: [{ displayName: "Morgan Bare" }],
      phoneNumbers: [{ value: "+61491570222", type: "mobile" }],
      emailAddresses: [{ value: freeMail, type: "home" }],
      addresses: [{ streetAddress: "42 Private Lane" }],
      organizations: [],
      biographies: [{ value: "Keep prefix" }],
    });
    const snap = sampleSnapshot([bare]);
    const leakyQueries = [
      "+61491570222",
      freeMail,
      "Morgan Bare profile",
      "42 Private Lane Sydney",
      "",
    ];
    for (const query of leakyQueries) {
      const ev: EvidenceItem = {
        id: "web-1",
        lane: "web",
        contactResourceName: "people/bare",
        anchor: null,
        sourceRef: "https://example.org",
        observedAt: null,
        excerpt: "Bio",
        query,
        suggestedFields: {},
      };
      const compiled = compileMutationPlan({
        snapshot: snap,
        lane: "note-append",
        accountOverride: null,
        audit: null,
        proposals: {
          schemaVersion: "contacts-proposals/1",
          account: snap.account,
          proposals: [
            {
              kind: "note-append",
              target: "people/bare",
              noteLine: "Met online",
              evidenceIds: ["web-1"],
            },
          ],
        },
        evidenceItems: [ev],
        contactFilter: [],
        minConfidence: "medium",
        maxContacts: 50,
        defaultRegion: "AU",
      });
      expect(compiled.ok).toBe(false);
    }

    const baseRes = compileMutationPlan({
      snapshot: snap,
      lane: "note-append",
      accountOverride: null,
      audit: null,
      proposals: {
        schemaVersion: "contacts-proposals/1",
        account: snap.account,
        proposals: [
          {
            kind: "note-append",
            target: "people/bare",
            confidence: "high",
            noteLine: "Appended line",
          },
        ],
      },
      evidenceItems: [],
      contactFilter: [],
      minConfidence: "high",
      maxContacts: 50,
      defaultRegion: "AU",
    });
    expect(baseRes.ok).toBe(true);
    if (!baseRes.ok) return;
    const { seal: baseSeal, ...baseBody } = baseRes.plan;
    expect(baseSeal.startsWith("sha256:")).toBe(true);
    const firstBatch = baseBody.updateSubBatches[0];
    const firstUpdate = firstBatch?.updates[0];
    if (firstBatch === undefined || firstUpdate === undefined) return;

    const forgedPlans: readonly MutationPlanDoc[] = [
      reseal({
        ...baseBody,
        updateSubBatches: [
          {
            ...firstBatch,
            updates: [
              {
                ...firstUpdate,
                fields: { biographies: [{ value: "Overwritten completely" }] },
              },
            ],
          },
        ],
      }),
      reseal({
        ...baseBody,
        updateSubBatches: [
          {
            ...firstBatch,
            fieldMask: ["biographies", "phoneNumbers"],
          },
        ],
      }),
      reseal({
        ...baseBody,
        updateSubBatches: [
          {
            ...firstBatch,
            updates: [
              {
                ...firstUpdate,
                fields: {
                  biographies: [
                    { value: `Keep prefix\n${"X".repeat(905_000)}` },
                  ],
                },
              },
            ],
          },
        ],
      }),
      reseal({ ...baseBody, maxContacts: 101 }),
      reseal({
        ...baseBody,
        evidenceSummary: [
          {
            id: "w-leak",
            lane: "web",
            contactResourceName: "people/bare",
            anchor: null,
            sourceRef: "https://example.org",
            observedAt: null,
            excerpt: "Bio",
            query: `lookup ${freeMail}`,
            suggestedFields: {},
          },
        ],
      }),
      reseal({
        ...baseBody,
        targets: [
          {
            resourceName: "people/other",
            expectedRevision: "etag-other",
            role: "update",
          },
        ],
      }),
      reseal({
        ...baseBody,
        lane: "contact-delete",
        updateSubBatches: [],
        deleteBatches: [
          {
            index: 0,
            targets: [
              {
                resourceName: "people/bare",
                expectedRevision: bare.etag,
                reason: "Old",
                confirmedByHuman: false,
                clusterSurvivor: null,
              },
            ],
          },
        ],
      }),
      reseal({
        ...baseBody,
        lane: "duplicate-merge",
        deleteBatches: [
          {
            index: 0,
            targets: [
              {
                resourceName: "people/dup",
                expectedRevision: "etag-dup",
                reason: "Merge",
                confirmedByHuman: true,
                clusterSurvivor: "people/bare",
              },
            ],
          },
        ],
        targets: [
          ...baseBody.targets,
          {
            resourceName: "people/dup",
            expectedRevision: "etag-dup",
            role: "duplicate",
          },
        ],
        targetCount: 2,
        mergeClusters: [
          {
            survivor: "people/bare",
            expectedSurvivorRevision: bare.etag,
            duplicates: [
              {
                resourceName: "people/dup",
                expectedRevision: "etag-dup",
                nonAllowlistedFields: ["userDefined"],
              },
            ],
            corroboration: { kind: "human-confirmed", note: "ok" },
            provenanceLine: "[merged-from] people/dup",
            hasConflictingNames: false,
          },
        ],
      }),
    ];

    const gog = createGogStub(dir, { account: snap.account, contacts: [bare] });
    const cli = createGoogleContactsCli({
      env: { GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger") },
      gogBin: gog.binPath,
    });
    for (let i = 0; i < forgedPlans.length; i += 1) {
      const plan = forgedPlans[i];
      if (plan === undefined) continue;
      expect(validateMutationPlan(plan)).not.toBeNull();
      const planFile = join(dir, `forged-${String(i)}.json`);
      writeFileSync(planFile, JSON.stringify(plan), "utf8");
      const ran = await runInProcess(
        cli.contract,
        cli.setup,
      )(["apply", "--plan", planFile, "--seal", plan.seal]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind === "envelope") {
        expect(ran.envelope.result.causeCode).toBe(
          "DOMAIN_CONTACTS_PLAN_INVALID",
        );
      }
    }
    expect(gog.readLog().length).toBe(0);
  } finally {
    removeOwnedFolder(dir);
  }
});
