import { command, station } from "agent-cli-kernel";
import {
  CLIENT_OPTION,
  CONTACT_OPTION,
  DEFAULT_RETRY_DELAY_MS,
  googleContactsCauses,
  noEffects,
  noInput,
  retryStationWords,
  SCHEMA_INVALID_INPUT,
  SNAPSHOT_OPTION,
  stationWords,
  SUCCESS_UNCHANGED,
  TRANSIENT_NOT_STARTED,
} from "./causes.ts";
import { decodeSnapshotDoc } from "./decoders/rules.ts";
import {
  executeEvidenceCollection,
  parseRequestedLanes,
} from "./evidence-exec.ts";
import type { EvidenceCommandDeps } from "./evidence-exec.ts";
import { readJsonFile } from "./inputs.ts";

export function createEvidenceCommand(deps: EvidenceCommandDeps) {
  return command({
    identity: "google-contacts.evidence",
    route: ["evidence"],
    summary:
      "Gather read-only private Evidence items (Gmail, optional macOS imsg) and emit a redacted Web research queue.",
    input: {
      ...noInput,
      options: [
        SNAPSHOT_OPTION,
        CLIENT_OPTION,
        CONTACT_OPTION,
        {
          name: "--lane",
          aliases: [],
          summary:
            "Evidence lane to query (repeatable: gmail, imsg, web-queue).",
          required: false,
          repeatable: true,
          value: {
            kind: "string",
            minLength: 4,
            maxLength: 16,
            choices: ["gmail", "imsg", "web-queue"],
            pattern: null,
          },
        },
        {
          name: "--max-contacts",
          aliases: [],
          summary:
            "Maximum number of contacts to inspect (default 20, max 100).",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 100 },
        },
        {
          name: "--max-chats",
          aliases: [],
          summary: "Maximum recent imsg chats to scan (default 500).",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 2000 },
        },
        {
          name: "--max-threads",
          aliases: [],
          summary: "Maximum Gmail threads per contact (default 10).",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 50 },
        },
        {
          name: "--max-messages",
          aliases: [],
          summary: "Maximum imsg messages per matched chat (default 20).",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 200 },
        },
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.evidence",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "Evidence collection and web-queue redaction completed.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "google-contacts.evidence:collected",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.evidence",
        causeCode: SCHEMA_INVALID_INPUT,
        trigger:
          "The --snapshot file is unreadable, malformed JSON, or invalid contacts-snapshot/1.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Supply a valid contacts-snapshot/1 JSON file or snapshot --json envelope.",
          },
        },
        repairAction:
          "Regenerate the snapshot with snapshot --json and pass its path.",
        independentObservable: "google-contacts.evidence:invalid-snapshot",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.evidence",
        causeCode: "DOMAIN_CONTACTS_LANE_UNAVAILABLE",
        trigger:
          "A required evidence lane (Gmail via gog, or exclusive --lane imsg) is unavailable or truncated.",
        guidance: {
          next: {
            kind: "command",
            command: "google-contacts.doctor",
            args: [],
          },
        },
        repairAction:
          "Run doctor to inspect gog auth and optional macOS imsg Full Disk Access status.",
        independentObservable: "google-contacts.evidence:lane-unavailable",
      }),
      station(googleContactsCauses, {
        ...retryStationWords,
        commandIdentity: "google-contacts.evidence",
        causeCode: TRANSIENT_NOT_STARTED,
        trigger:
          "Gmail evidence search encountered rate limiting or a transient timeout.",
        guidance: { next: { kind: "retry" } },
        repairAction: "Wait briefly and retry evidence.",
        independentObservable: "google-contacts.evidence:transient",
      }),
    ],
    run: async (input, context) => {
      const loaded = readJsonFile(input["--snapshot"]);
      const snapshot = loaded.ok ? decodeSnapshotDoc(loaded.value) : null;
      if (!loaded.ok || snapshot === null) {
        return context.result(
          {
            commandIdentity: "google-contacts.evidence",
            causeCode: SCHEMA_INVALID_INPUT,
          },
          {
            message: loaded.ok
              ? "File does not contain a valid contacts-snapshot/1 payload."
              : loaded.reason,
            data: null,
            effects: noEffects,
          },
        );
      }
      const contactFilter = input["--contact"] ?? [];
      const filterSet =
        contactFilter.length > 0 ? new Set(contactFilter) : null;
      const targets = (
        filterSet === null
          ? snapshot.contacts
          : snapshot.contacts.filter((c) => filterSet.has(c.resourceName))
      ).slice(0, input["--max-contacts"] ?? 20);
      const outcome = await executeEvidenceCollection({
        snapshot,
        lanesRequested: parseRequestedLanes(input["--lane"]),
        targets,
        client: input["--client"],
        maxChats: input["--max-chats"] ?? 500,
        maxThreads: input["--max-threads"] ?? 10,
        maxMessages: input["--max-messages"] ?? 20,
        programs: context.programs,
        aborted: () => context.signal.aborted,
        deps,
      });
      if (outcome.kind === "transient") {
        return context.result(
          {
            commandIdentity: "google-contacts.evidence",
            causeCode: TRANSIENT_NOT_STARTED,
          },
          {
            message: outcome.detail,
            data: null,
            effects: noEffects,
            retryDelayMilliseconds: DEFAULT_RETRY_DELAY_MS,
          },
        );
      }
      if (outcome.kind === "unavailable") {
        return context.result(
          {
            commandIdentity: "google-contacts.evidence",
            causeCode: "DOMAIN_CONTACTS_LANE_UNAVAILABLE",
          },
          { message: outcome.detail, data: null, effects: noEffects },
        );
      }
      return context.result(
        {
          commandIdentity: "google-contacts.evidence",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Collected ${String(outcome.doc.items.length)} evidence item(s) and ${String(outcome.doc.webResearchQueue.length)} web queue entry(ies).`,
          data: outcome.doc,
          effects: noEffects,
        },
      );
    },
  });
}
