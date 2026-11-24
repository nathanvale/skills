import { command, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import {
  CONTACT_OPTION,
  googleContactsCauses,
  noEffects,
  noInput,
  OPTIONAL_ACCOUNT_OPTION,
  SCHEMA_INVALID_INPUT,
  SNAPSHOT_OPTION,
  stationWords,
  SUCCESS_UNCHANGED,
} from "./causes.ts";
import { decodeSnapshotDoc } from "./decoders/rules.ts";
import { parseChangeLane, parseConfidenceTier } from "./domain/rules.ts";
import type { AuditDoc, EvidenceItem } from "./domain/rules.ts";
import {
  decodeAuditDoc,
  decodeEvidenceDoc,
} from "./evidence-decoders/rules.ts";
import { readJsonFile } from "./inputs.ts";
import { readPendingMutations } from "./ledger.ts";
import type { LedgerResolution } from "./ledger.ts";
import { resolveCountryCode } from "./phone/rules.ts";
import { compileMutationPlan } from "./plan/rules.ts";
import { decodeProposalsDoc } from "./plan-decoders/rules.ts";
import {
  DEFAULT_MAX_CONTACTS,
  HARD_MAX_CONTACTS,
} from "./plan-subbatch/rules.ts";
import type { ProposalsDoc } from "./plan-types/rules.ts";
import { validateMutationPlan } from "./plan-validate/rules.ts";

function decodeFileWith<T>(
  path: string | undefined,
  decoder: (raw: unknown) => T | null,
  schemaName: string,
):
  | { readonly ok: true; readonly value: T | null }
  | { readonly ok: false; readonly reason: string } {
  if (path === undefined) return { ok: true, value: null };
  const raw = readJsonFile(path);
  if (!raw.ok) return raw;
  const decoded = decoder(raw.value);
  return decoded === null
    ? {
        ok: false,
        reason: `File ${path} does not contain a valid ${schemaName} payload.`,
      }
    : { ok: true, value: decoded };
}

function loadOptionalInputs(input: {
  readonly "--audit"?: string | undefined;
  readonly "--proposals"?: string | undefined;
  readonly "--evidence"?: readonly string[] | undefined;
}):
  | {
      readonly ok: true;
      readonly audit: AuditDoc | null;
      readonly proposals: ProposalsDoc | null;
      readonly evidenceItems: readonly EvidenceItem[];
    }
  | { readonly ok: false; readonly reason: string } {
  const auditRes = decodeFileWith(
    input["--audit"],
    decodeAuditDoc,
    "contacts-audit/1",
  );
  if (!auditRes.ok) return auditRes;
  const propRes = decodeFileWith(
    input["--proposals"],
    decodeProposalsDoc,
    "contacts-proposals/1",
  );
  if (!propRes.ok) return propRes;
  const evidenceItems: EvidenceItem[] = [];
  for (const path of input["--evidence"] ?? []) {
    const evRes = decodeFileWith(
      path,
      decodeEvidenceDoc,
      "contacts-evidence/1",
    );
    if (!evRes.ok) return evRes;
    for (const item of evRes.value?.items ?? []) evidenceItems.push(item);
  }
  return {
    ok: true,
    audit: auditRes.value,
    proposals: propRes.value,
    evidenceItems,
  };
}

type PlanCliInput = {
  readonly "--snapshot": string;
  readonly "--lane": string;
  readonly "--audit"?: string | undefined;
  readonly "--proposals"?: string | undefined;
  readonly "--account"?: string | undefined;
  readonly "--evidence"?: readonly string[] | undefined;
  readonly "--contact"?: readonly string[] | undefined;
  readonly "--min-confidence"?: string | undefined;
  readonly "--max-contacts"?: number | undefined;
  readonly "--default-region"?: string | undefined;
};

function loadPlanInputs(input: PlanCliInput) {
  if (input["--audit"] === undefined && input["--proposals"] === undefined) {
    return {
      ok: false as const,
      message: "Pass either --audit or --proposals to compile a plan.",
    };
  }
  const snapRes = decodeFileWith(
    input["--snapshot"],
    decodeSnapshotDoc,
    "contacts-snapshot/1",
  );
  if (!snapRes.ok || snapRes.value === null) {
    return {
      ok: false as const,
      message: snapRes.ok ? "Missing snapshot." : snapRes.reason,
    };
  }
  const loaded = loadOptionalInputs(input);
  if (!loaded.ok) return { ok: false as const, message: loaded.reason };
  return { ok: true as const, snapshot: snapRes.value, loaded };
}

function compilePlanFromCliInput(input: PlanCliInput):
  | {
      readonly kind: "ok";
      readonly plan: import("./plan-types/rules.ts").MutationPlanDoc;
    }
  | { readonly kind: "schema"; readonly message: string }
  | { readonly kind: "domain"; readonly message: string } {
  const files = loadPlanInputs(input);
  if (!files.ok) return { kind: "schema", message: files.message };
  const region = resolveCountryCode(
    input["--default-region"] ?? files.loaded.audit?.defaultRegion ?? "AU",
  );
  const lane = parseChangeLane(input["--lane"]);
  const minConfidence = parseConfidenceTier(
    input["--min-confidence"] ?? "high",
  );
  if (region === null || lane === null || minConfidence === null) {
    return {
      kind: "schema",
      message: "Unsupported region, lane, or confidence tier.",
    };
  }
  const compiled = compileMutationPlan({
    snapshot: files.snapshot,
    lane,
    accountOverride: input["--account"] ?? null,
    audit: files.loaded.audit,
    proposals: files.loaded.proposals,
    evidenceItems: files.loaded.evidenceItems,
    contactFilter: input["--contact"] ?? [],
    minConfidence,
    maxContacts: input["--max-contacts"] ?? DEFAULT_MAX_CONTACTS,
    defaultRegion: region,
  });
  if (!compiled.ok) return { kind: "domain", message: compiled.reason };
  const invariantError = validateMutationPlan(compiled.plan);
  return invariantError !== null
    ? { kind: "domain", message: invariantError }
    : { kind: "ok", plan: compiled.plan };
}

export function createPlanCommand() {
  return command({
    identity: "google-contacts.plan",
    route: ["plan"],
    summary:
      "Compile a pure offline single-lane Mutation plan and canonical SHA-256 Plan seal with zero writes.",
    input: {
      ...noInput,
      options: [
        SNAPSHOT_OPTION,
        {
          name: "--lane",
          aliases: [],
          summary: "Disjoint Change lane for this Mutation plan.",
          required: true,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 32,
            choices: [
              "phone-normalize",
              "metadata-enrich",
              "note-append",
              "duplicate-merge",
              "contact-delete",
            ],
            pattern: null,
          },
        },
        {
          name: "--audit",
          aliases: [],
          summary:
            "Path to contacts-audit/1 JSON (mutually exclusive with --proposals).",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 4096,
            choices: null,
            pattern: null,
          },
        },
        {
          name: "--proposals",
          aliases: [],
          summary:
            "Path to contacts-proposals/1 JSON (mutually exclusive with --audit).",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 4096,
            choices: null,
            pattern: null,
          },
        },
        OPTIONAL_ACCOUNT_OPTION,
        {
          name: "--evidence",
          aliases: [],
          summary: "Path to contacts-evidence/1 JSON (repeatable).",
          required: false,
          repeatable: true,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 4096,
            choices: null,
            pattern: null,
          },
        },
        CONTACT_OPTION,
        {
          name: "--min-confidence",
          aliases: [],
          summary: "Minimum Confidence tier to include (default high).",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 3,
            maxLength: 8,
            choices: ["high", "medium", "low"],
            pattern: null,
          },
        },
        {
          name: "--max-contacts",
          aliases: [],
          summary:
            "Maximum Contacts in one Mutation plan (default 50, max 100).",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: HARD_MAX_CONTACTS },
        },
        {
          name: "--default-region",
          aliases: [],
          summary: "ISO-3166 default region for phone checks (default AU).",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 2,
            maxLength: 2,
            choices: null,
            pattern: "^[A-Za-z]{2}$",
          },
        },
      ],
      constraints: [{ kind: "exclusive", members: ["--audit", "--proposals"] }],
    },
    capabilities: {},
    stations: [
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.plan",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "Pure offline Mutation plan compiled and sealed.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "google-contacts.plan:compiled",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.plan",
        causeCode: SCHEMA_INVALID_INPUT,
        trigger:
          "Input JSON file is unreadable, malformed, wrong schema, or neither --audit nor --proposals was supplied.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Supply valid contacts-snapshot/1 JSON and either --audit or --proposals with matching schema versions.",
          },
        },
        repairAction:
          "Fix the input JSON schema or pass one of --audit or --proposals.",
        independentObservable: "google-contacts.plan:invalid-input",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.plan",
        causeCode: "DOMAIN_CONTACTS_PLAN_INVALID",
        trigger:
          "A proposal or web evidence item violates safety, merge allowlist, privacy leak, corroboration, or size invariants.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix the offending proposal, merge allowlist violation, confirmation marker, or leaked web query and re-run plan.",
          },
        },
        repairAction:
          "Remove unmergeable fields, leaked web queries, or unconfirmed deletions and re-run plan.",
        independentObservable: "google-contacts.plan:domain-invalid",
      }),
    ],
    run: (input, context) => {
      const outcome = compilePlanFromCliInput(input);
      if (outcome.kind === "schema") {
        return context.result(
          {
            commandIdentity: "google-contacts.plan",
            causeCode: SCHEMA_INVALID_INPUT,
          },
          { message: outcome.message, data: null, effects: noEffects },
        );
      }
      if (outcome.kind === "domain") {
        return context.result(
          {
            commandIdentity: "google-contacts.plan",
            causeCode: "DOMAIN_CONTACTS_PLAN_INVALID",
          },
          { message: outcome.message, data: null, effects: noEffects },
        );
      }
      return context.result(
        {
          commandIdentity: "google-contacts.plan",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Compiled ${outcome.plan.lane} plan for ${String(outcome.plan.targetCount)} contact(s) (${outcome.plan.seal}).`,
          data: outcome.plan,
          effects: noEffects,
        },
      );
    },
  });
}

export function createPendingCommand(deps: {
  readonly ledgerResolution: LedgerResolution;
  readonly state: ReturnType<typeof stateAddon>;
}) {
  return command({
    identity: "google-contacts.pending",
    route: ["pending"],
    summary:
      "List Unfinished mutations and their affected Contacts and expected Contact revisions from the Contact ledger.",
    input: noInput,
    capabilities: {},
    stations: [
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.pending",
        causeCode: SUCCESS_UNCHANGED,
        trigger:
          "Contact ledger read cleanly (empty or listing unfinished mutations).",
        guidance: {
          next: {
            kind: "instruction",
            text: "Inspect each unfinished mutation target and revision in Google Contacts. Never delete Contact ledger files; affected Contacts stay blocked until a qualified close exists.",
          },
        },
        repairAction: null,
        independentObservable: "google-contacts.pending:listed",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.pending",
        causeCode: "DOMAIN_CONTACTS_LEDGER_UNREADABLE",
        trigger:
          "Contact ledger path is relative/invalid or its journal files are unreadable or corrupt.",
        guidance: {
          handoff: {
            owner: "operator",
            reason:
              "The Contact ledger could not be read safely without risking lost mutation history.",
            inspect: [
              {
                kind: "command",
                command: "google-contacts.doctor",
                args: [],
              },
            ],
          },
        },
        repairAction:
          "Run doctor to inspect GOOGLE_CONTACTS_LEDGER_DIR and Contact ledger permissions without deleting ledger files.",
        independentObservable: "google-contacts.pending:ledger-unreadable",
      }),
    ],
    run: async (_input, context) => {
      const pending = await readPendingMutations(
        deps.ledgerResolution,
        deps.state,
      );
      if (!pending.ok) {
        return context.result(
          {
            commandIdentity: "google-contacts.pending",
            causeCode: "DOMAIN_CONTACTS_LEDGER_UNREADABLE",
          },
          { message: pending.detail, data: null, effects: noEffects },
        );
      }
      return context.result(
        {
          commandIdentity: "google-contacts.pending",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message:
            pending.items.length === 0
              ? "No unfinished mutations."
              : `${String(pending.items.length)} unfinished mutation(s) recorded.`,
          data: {
            ledgerRoot: deps.ledgerResolution.ok
              ? deps.ledgerResolution.root
              : "",
            unfinished: pending.items,
          },
          effects: noEffects,
        },
      );
    },
  });
}
