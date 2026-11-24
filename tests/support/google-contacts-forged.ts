import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContactRecord } from "../../src/google-contacts/domain/rules.ts";
import { computePlanSeal } from "../../src/google-contacts/plan-types/rules.ts";
import type {
  MutationPlanBody,
  MutationPlanDoc,
  PlannedContactUpdate,
  UpdateSubBatch,
} from "../../src/google-contacts/plan-types/rules.ts";
import { planFromContacts, runContactsCli } from "./google-contacts-run.ts";
import { createGogStub } from "./google-contacts-stubs.ts";

export type ForgedRow = {
  readonly name: string;
  readonly lane: string;
  readonly planned: readonly ContactRecord[];
  readonly live: readonly ContactRecord[];
  readonly proposal: unknown;
  readonly forge: (body: MutationPlanBody) => MutationPlanBody;
};

export function isPlanDoc(value: unknown): value is MutationPlanDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "schemaVersion") === "contacts-plan/1"
  );
}

function bodyOf(plan: MutationPlanDoc): MutationPlanBody {
  const { seal, ...body } = plan;
  expect(seal.startsWith("sha256:")).toBe(true);
  return body;
}

export function withFirstUpdate(
  body: MutationPlanBody,
  change: (update: PlannedContactUpdate) => PlannedContactUpdate,
): MutationPlanBody {
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

export async function applyForgedRow(
  dir: string,
  row: ForgedRow,
): Promise<string> {
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
      (entry) => entry.args.includes("update") || entry.args.includes("delete"),
    ).length;
  const unchanged =
    JSON.stringify(gog.readState().contacts) === JSON.stringify(row.live);
  return `${row.name}: ${applied.causeCode} writes=${String(writes)} addressBookUnchanged=${String(unchanged)}`;
}
