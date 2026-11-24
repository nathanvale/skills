import { changing, station } from "agent-cli-kernel";
import { classifyReadBack, executeUpdatesAndDeletes } from "./apply-exec.ts";
import type { ExecutionTracker } from "./apply-exec.ts";
import { runApplyPreflight } from "./apply-preflight.ts";
import type { ApplyCommandDeps } from "./apply-preflight.ts";
import {
  CLIENT_OPTION,
  DEFAULT_RETRY_DELAY_MS,
  googleContactsCauses,
  noEffects,
  noInput,
  retryStationWords,
  SCHEMA_INVALID_INPUT,
  stationWords,
  SUCCESS_COMPLETED,
  TRANSIENT_NOT_STARTED,
} from "./causes.ts";
import { batchGetContacts } from "./gog-ops.ts";
import { contactScopeKey } from "./ledger.ts";

export function createApplyCommand(deps: ApplyCommandDeps) {
  return changing({
    identity: "google-contacts.apply",
    route: ["apply"],
    summary:
      "Validate a sealed Mutation plan, check live Contact revisions, and apply mutations with narrow Contact ledger scopes.",
    input: {
      ...noInput,
      options: [
        {
          name: "--plan",
          aliases: [],
          summary:
            "Path to a contacts-plan/1 JSON file or plan --json envelope.",
          required: true,
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
          name: "--seal",
          aliases: [],
          summary: "Expected canonical SHA-256 Plan seal (sha256:<64 hex>).",
          required: true,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 71,
            maxLength: 71,
            choices: null,
            pattern: "^sha256:[0-9a-f]{64}$",
          },
        },
        CLIENT_OPTION,
      ],
    },
    capabilities: { programs: true },
    effectClass: "external",
    effects: ["contacts.mutate"],
    ifNoResult: deps.state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_CONTACTS_APPLY_HELD",
    unresolvedCaseCause: "DOMAIN_CONTACTS_APPLY_UNRESOLVED",
    stations: [
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: SUCCESS_COMPLETED,
        trigger:
          "All planned mutations executed and confirmed on live read-back.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "google-contacts.apply:completed",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: SCHEMA_INVALID_INPUT,
        trigger:
          "The --plan file is unreadable, malformed JSON, or invalid contacts-plan/1.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Supply a valid contacts-plan/1 file or plan --json envelope.",
          },
        },
        repairAction:
          "Re-run plan --json and pass the resulting file to apply.",
        independentObservable: "google-contacts.apply:invalid-plan-file",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_PLAN_INVALID",
        trigger:
          "The plan violates domain, allowlist, privacy, sub-batch, or cap invariants.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix the violating proposal or evidence item and compile a fresh Mutation plan.",
          },
        },
        repairAction:
          "Recompile the plan cleanly with plan before calling apply.",
        independentObservable: "google-contacts.apply:plan-invariant-failed",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_SEAL_MISMATCH",
        trigger:
          "The --seal digest does not match the canonical SHA-256 Plan seal of --plan.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Review the plan file again and pass its exact seal string to --seal.",
          },
        },
        repairAction: "Pass the exact Plan seal emitted by plan for this file.",
        independentObservable: "google-contacts.apply:seal-mismatch",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
        trigger:
          "gog is missing, below 0.48.1, unauthenticated, or lacks Contacts write scope.",
        guidance: {
          next: {
            kind: "command",
            command: "google-contacts.doctor",
            args: [],
          },
        },
        repairAction:
          "Run doctor to verify gog version and Contacts write authentication.",
        independentObservable: "google-contacts.apply:gog-unavailable",
      }),
      station(googleContactsCauses, {
        ...retryStationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: TRANSIENT_NOT_STARTED,
        trigger:
          "Pre-transaction gog check hit rate limiting or a transient timeout.",
        guidance: { next: { kind: "retry" } },
        repairAction: "Wait briefly and retry apply; no Contact was modified.",
        independentObservable: "google-contacts.apply:transient-preflight",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_REVISION_DRIFT",
        trigger:
          "A target Contact revision changed or disappeared in Google Contacts since snapshot.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Take a fresh snapshot, re-run plan, review the new diffs, and apply with the new seal.",
          },
        },
        repairAction:
          "Capture a fresh Contact snapshot and recompile the Mutation plan.",
        independentObservable: "google-contacts.apply:revision-drift",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_APPLY_HELD",
        trigger:
          "Another live apply run holds a coordination lock on an overlapping Contact.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "An overlapping Contact mutation is currently running.",
            inspect: [
              { kind: "command", command: "google-contacts.pending", args: [] },
            ],
          },
        },
        repairAction:
          "Wait for the active apply process to finish or inspect pending before retrying.",
        independentObservable: "google-contacts.apply:held-lock",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_APPLY_UNRESOLVED",
        trigger:
          "An earlier Unfinished mutation blocks at least one target Contact.",
        guidance: {
          handoff: {
            owner: "human",
            reason:
              "An earlier mutation on an overlapping Contact did not confirm completion.",
            inspect: [
              { kind: "command", command: "google-contacts.pending", args: [] },
            ],
          },
        },
        repairAction:
          "Run pending to inspect affected Contacts and revisions. Never delete Contact ledger files; blocked Contacts remain guarded until a qualified close exists.",
        independentObservable: "google-contacts.apply:unresolved-case",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_APPLY_UNAVAILABLE",
        trigger:
          "Contact ledger path is invalid/unwritable or the transaction closed unchanged before starting.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The Contact ledger could not open a transaction.",
            inspect: [
              { kind: "command", command: "google-contacts.doctor", args: [] },
            ],
          },
        },
        repairAction:
          "Run doctor to check GOOGLE_CONTACTS_LEDGER_DIR and Contact ledger permissions.",
        independentObservable: "google-contacts.apply:ledger-unavailable",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_APPLY_REJECTED",
        trigger:
          "A mutation sub-batch returned a clean failure or pre-delete drift abort, and live read-back confirmed all targets cleanly.",
        guidance: {
          handoff: {
            owner: "human",
            reason:
              "Mutation stopped cleanly on rejection; live read-back confirmed landed, untouched, and externally drifted Contacts with zero unfinished locks.",
            inspect: [
              { kind: "command", command: "google-contacts.doctor", args: [] },
            ],
          },
        },
        repairAction:
          "Take a fresh snapshot to review any partial landed sub-batches and recompile remaining changes.",
        independentObservable: "google-contacts.apply:clean-rejection",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.apply",
        causeCode: "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
        trigger:
          "Execution timed out, lost confirmation, or live read-back failed or truncated, leaving narrow per-contact Unfinished mutations.",
        guidance: {
          handoff: {
            owner: "human",
            reason:
              "The Contact mutation outcome could not be confirmed on live read-back.",
            inspect: [
              { kind: "command", command: "google-contacts.pending", args: [] },
            ],
          },
        },
        repairAction:
          "Run pending to see the operation id, affected Contacts, and revisions, then verify those Contacts in Google Contacts. Never delete Contact ledger files; blocked Contacts stay guarded until a qualified close exists.",
        independentObservable: "google-contacts.apply:unconfirmed",
      }),
    ],
    run: async (input, context) => {
      const preflight = await runApplyPreflight({
        planPath: input["--plan"],
        seal: input["--seal"],
        client: input["--client"],
        programs: context.programs,
        aborted: () => context.signal.aborted,
        deps,
      });
      if (!preflight.ok) {
        const fail = preflight.failure;
        if (fail.cause === TRANSIENT_NOT_STARTED) {
          return context.result(
            {
              commandIdentity: "google-contacts.apply",
              causeCode: TRANSIENT_NOT_STARTED,
            },
            {
              message: fail.message,
              data: null,
              effects: noEffects,
              retryDelayMilliseconds: DEFAULT_RETRY_DELAY_MS,
            },
          );
        }
        return context.result(
          { commandIdentity: "google-contacts.apply", causeCode: fail.cause },
          { message: fail.message, data: null, effects: noEffects },
        );
      }
      const { plan, executable } = preflight;
      const revisions: Record<string, string> = {};
      const resources = plan.targets.map((target) => {
        const key = contactScopeKey(plan.account, target.resourceName);
        revisions[key] = target.expectedRevision;
        return { resource: "contact", key };
      });
      const tracker: ExecutionTracker = {
        sentUpdates: new Set<string>(),
        sentDeletes: new Set<string>(),
        cleanFailureDetail: null,
        hardUnconfirmedReason: null,
        finalDisposition: "unconfirmed",
        summaryLine: "Contact mutation outcome was not confirmed.",
      };
      const outcome = await deps.state.transaction(
        context.state,
        {
          command: "google-contacts.apply",
          scope: { resources },
          revisions,
          facts: {
            planSeal: plan.seal,
            lane: plan.lane,
            account: plan.account,
          },
        },
        async (transaction) => {
          await transaction.record(
            "contacts.mutate",
            async (recorded) => {
              await executeUpdatesAndDeletes({
                plan,
                client: input["--client"],
                executable,
                programs: context.programs,
                recorded,
                config: deps.gogConfig,
                aborted: () => context.signal.aborted,
                tracker,
              });
            },
            async () => {
              if (
                context.signal.aborted ||
                tracker.hardUnconfirmedReason !== null
              ) {
                tracker.finalDisposition = "unconfirmed";
                if (tracker.hardUnconfirmedReason !== null) {
                  tracker.summaryLine = tracker.hardUnconfirmedReason;
                }
                return false;
              }
              const post = await batchGetContacts({
                programs: context.programs,
                executable,
                account: plan.account,
                client: input["--client"],
                resourceNames: plan.targets.map((t) => t.resourceName),
                config: deps.gogConfig,
                aborted: () => context.signal.aborted,
              });
              if (post.kind !== "ok") {
                tracker.finalDisposition = "unconfirmed";
                tracker.summaryLine = `Post-mutation read-back failed: ${post.detail}`;
                return false;
              }
              return classifyReadBack(plan, post.found, tracker);
            },
          );
        },
      );
      if (outcome.kind === "held-lock") {
        return context.result(
          {
            commandIdentity: "google-contacts.apply",
            causeCode: "DOMAIN_CONTACTS_APPLY_HELD",
          },
          {
            message: `Another apply operation (${outcome.operationId}) holds a lock on an overlapping Contact.`,
            data: null,
            effects: noEffects,
          },
        );
      }
      if (outcome.kind === "unresolved-case") {
        return context.result(
          {
            commandIdentity: "google-contacts.apply",
            causeCode: "DOMAIN_CONTACTS_APPLY_UNRESOLVED",
          },
          {
            message: `Unfinished mutation (${outcome.operationId}) blocks an overlapping Contact.`,
            data: null,
            effects: noEffects,
          },
        );
      }
      if (
        outcome.kind !== "ran" ||
        outcome.proof.transactionState === "unchanged"
      ) {
        return context.result(
          {
            commandIdentity: "google-contacts.apply",
            causeCode: "DOMAIN_CONTACTS_APPLY_UNAVAILABLE",
          },
          {
            message: "Contact ledger could not start the transaction.",
            data: null,
            effects: noEffects,
          },
        );
      }
      if (
        outcome.proof.transactionState === "completed" &&
        tracker.finalDisposition === "succeeded"
      ) {
        return context.result(
          {
            commandIdentity: "google-contacts.apply",
            causeCode: SUCCESS_COMPLETED,
          },
          {
            message: tracker.summaryLine,
            data: {
              operationId: outcome.operationId,
              account: plan.account,
              lane: plan.lane,
              seal: plan.seal,
              targetCount: plan.targetCount,
              updatedContacts: [...tracker.sentUpdates],
              deletedContacts: [...tracker.sentDeletes],
            },
            transaction: outcome.proof,
          },
        );
      }
      const isRejected =
        outcome.proof.transactionState === "completed" &&
        tracker.finalDisposition === "rejected";
      return context.result(
        {
          commandIdentity: "google-contacts.apply",
          causeCode: isRejected
            ? "DOMAIN_CONTACTS_APPLY_REJECTED"
            : "DOMAIN_CONTACTS_APPLY_UNCONFIRMED",
        },
        {
          message: tracker.summaryLine,
          data: null,
          transaction: outcome.proof,
        },
      );
    },
  });
}
