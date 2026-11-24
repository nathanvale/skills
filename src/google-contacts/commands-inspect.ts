import { command, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import { runContactsAudit } from "./anchors/rules.ts";
import {
  ACCOUNT_OPTION,
  CLIENT_OPTION,
  CONTACT_OPTION,
  DEFAULT_RETRY_DELAY_MS,
  googleContactsCauses,
  noEffects,
  noInput,
  OPTIONAL_ACCOUNT_OPTION,
  retryStationWords,
  SCHEMA_INVALID_INPUT,
  SNAPSHOT_OPTION,
  stationWords,
  SUCCESS_UNCHANGED,
  TRANSIENT_NOT_STARTED,
} from "./causes.ts";
import { decodeSnapshotDoc } from "./decoders/rules.ts";
import type { ContactSnapshotDoc } from "./domain/rules.ts";
import { resolveExecutablePath } from "./gog.ts";
import type { GogRuntimeConfig, PathBoundary } from "./gog.ts";
import {
  batchGetContacts,
  listAllContacts,
  probeGogReadiness,
} from "./gog-ops.ts";
import { probeImsgReadiness } from "./imsg.ts";
import type { ImsgRuntimeConfig } from "./imsg.ts";
import { readJsonFile } from "./inputs.ts";
import { inspectLedgerReadOnly } from "./ledger.ts";
import type { LedgerResolution } from "./ledger.ts";
import { resolveCountryCode } from "./phone/rules.ts";
import { WEB_RESEARCH_OFF } from "./web-firewall/rules.ts";

export type InspectCommandsDeps = {
  readonly getBoundary: () => PathBoundary;
  readonly ledgerResolution: LedgerResolution;
  readonly state: ReturnType<typeof stateAddon>;
  readonly gogConfig: GogRuntimeConfig;
  readonly imsgConfig: ImsgRuntimeConfig;
  readonly nowIso: () => string;
};

export function createDoctorCommand(deps: InspectCommandsDeps) {
  return command({
    identity: "google-contacts.doctor",
    route: ["doctor"],
    summary:
      "Check gog version, schema, Contacts write auth, optional imsg readiness, and Contact ledger health.",
    input: {
      ...noInput,
      options: [OPTIONAL_ACCOUNT_OPTION, CLIENT_OPTION],
    },
    capabilities: { programs: true },
    stations: [
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.doctor",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "Readiness diagnostics completed without side effects.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "google-contacts.doctor:diagnostics",
      }),
    ],
    run: async (input, context) => {
      const boundary = deps.getBoundary();
      const gogProbe = await probeGogReadiness({
        programs: context.programs,
        boundary,
        config: deps.gogConfig,
        account: input["--account"],
        client: input["--client"],
        aborted: () => context.signal.aborted,
      });
      const imsgProbe = await probeImsgReadiness(
        context.programs,
        boundary,
        deps.imsgConfig,
      );
      const ledger = inspectLedgerReadOnly(deps.ledgerResolution, deps.state);
      const ready =
        gogProbe.versionOk &&
        gogProbe.schemaOk &&
        gogProbe.authOk &&
        ledger.ready;
      return context.result(
        {
          commandIdentity: "google-contacts.doctor",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: ready
            ? "Google Contacts CLI is ready."
            : "Google Contacts CLI is not ready; inspect doctor fields.",
          data: {
            ready,
            gog: {
              executable: gogProbe.executable,
              version: gogProbe.version,
              versionOk: gogProbe.versionOk,
              detail: gogProbe.detail,
            },
            schema: { ok: gogProbe.schemaOk },
            accounts: gogProbe.accounts,
            imsg: imsgProbe.readiness,
            ledger,
            webLane: {
              mode: "host-harness",
              status: "skipped",
              detail: WEB_RESEARCH_OFF,
            },
          },
          effects: noEffects,
        },
      );
    },
  });
}

export function createSnapshotCommand(deps: InspectCommandsDeps) {
  return command({
    identity: "google-contacts.snapshot",
    route: ["snapshot"],
    summary:
      "Capture a read-only Contact snapshot for one Account via gog without writing to disk.",
    input: {
      ...noInput,
      options: [ACCOUNT_OPTION, CLIENT_OPTION, CONTACT_OPTION],
    },
    capabilities: { programs: true },
    stations: [
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.snapshot",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "Contact snapshot captured from Google Contacts.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "google-contacts.snapshot:captured",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.snapshot",
        causeCode: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
        trigger:
          "gog is missing, unauthenticated, lacks permission, or truncated output.",
        guidance: {
          next: {
            kind: "command",
            command: "google-contacts.doctor",
            args: [],
          },
        },
        repairAction:
          "Run doctor to inspect gog installation, OAuth token status, and Contacts scopes.",
        independentObservable: "google-contacts.snapshot:gog-unavailable",
      }),
      station(googleContactsCauses, {
        ...retryStationWords,
        commandIdentity: "google-contacts.snapshot",
        causeCode: TRANSIENT_NOT_STARTED,
        trigger:
          "gog encountered rate limiting or a transient network timeout.",
        guidance: { next: { kind: "retry" } },
        repairAction: "Wait briefly and retry snapshot.",
        independentObservable: "google-contacts.snapshot:transient",
      }),
    ],
    run: async (input, context) => {
      const boundary = deps.getBoundary();
      const resolved = resolveExecutablePath(
        deps.gogConfig.gogBinOverride ??
          deps.gogConfig.env.GOOGLE_CONTACTS_GOG_BIN,
        deps.gogConfig.env.PATH,
        "gog",
        boundary,
      );
      if (!resolved.ok) {
        return context.result(
          {
            commandIdentity: "google-contacts.snapshot",
            causeCode: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
          },
          { message: resolved.reason, data: null, effects: noEffects },
        );
      }
      const account = input["--account"].trim().toLowerCase();
      const targets = input["--contact"] ?? [];
      if (targets.length > 0) {
        const res = await batchGetContacts({
          programs: context.programs,
          executable: resolved.path,
          account,
          client: input["--client"],
          resourceNames: targets,
          config: deps.gogConfig,
          aborted: () => context.signal.aborted,
        });
        if (res.kind === "transient" || res.kind === "unconfirmed") {
          return context.result(
            {
              commandIdentity: "google-contacts.snapshot",
              causeCode: TRANSIENT_NOT_STARTED,
            },
            {
              message: res.detail,
              data: null,
              effects: noEffects,
              retryDelayMilliseconds: DEFAULT_RETRY_DELAY_MS,
            },
          );
        }
        if (res.kind === "unavailable") {
          return context.result(
            {
              commandIdentity: "google-contacts.snapshot",
              causeCode: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
            },
            { message: res.detail, data: null, effects: noEffects },
          );
        }
        const doc: ContactSnapshotDoc = {
          schemaVersion: "contacts-snapshot/1",
          account,
          capturedAt: deps.nowIso(),
          contacts: [...res.found.values()],
          missingContacts: res.missing,
        };
        return context.result(
          {
            commandIdentity: "google-contacts.snapshot",
            causeCode: SUCCESS_UNCHANGED,
          },
          {
            message: `Captured ${String(doc.contacts.length)} contact(s) (${String(doc.missingContacts.length)} missing).`,
            data: doc,
            effects: noEffects,
          },
        );
      }
      const listed = await listAllContacts({
        programs: context.programs,
        executable: resolved.path,
        account,
        client: input["--client"],
        config: deps.gogConfig,
        aborted: () => context.signal.aborted,
      });
      if (listed.kind === "transient") {
        return context.result(
          {
            commandIdentity: "google-contacts.snapshot",
            causeCode: TRANSIENT_NOT_STARTED,
          },
          {
            message: listed.detail,
            data: null,
            effects: noEffects,
            retryDelayMilliseconds: DEFAULT_RETRY_DELAY_MS,
          },
        );
      }
      if (listed.kind === "unavailable") {
        return context.result(
          {
            commandIdentity: "google-contacts.snapshot",
            causeCode: "DOMAIN_CONTACTS_GOG_UNAVAILABLE",
          },
          { message: listed.detail, data: null, effects: noEffects },
        );
      }
      const doc: ContactSnapshotDoc = {
        schemaVersion: "contacts-snapshot/1",
        account,
        capturedAt: deps.nowIso(),
        contacts: listed.contacts,
        missingContacts: listed.missing,
      };
      return context.result(
        {
          commandIdentity: "google-contacts.snapshot",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Captured ${String(doc.contacts.length)} contact(s) for ${account}.`,
          data: doc,
          effects: noEffects,
        },
      );
    },
  });
}

export function createAuditCommand() {
  return command({
    identity: "google-contacts.audit",
    route: ["audit"],
    summary:
      "Classify phone, duplicate, sparse, and stale Audit findings offline from a Contact snapshot.",
    input: {
      ...noInput,
      options: [
        SNAPSHOT_OPTION,
        {
          name: "--default-region",
          aliases: [],
          summary:
            "ISO-3166 default region for phone normalization (default AU).",
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
        {
          name: "--lane",
          aliases: [],
          summary: "Optional finding lane or kind filter.",
          required: false,
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
              "phone-ambiguous",
              "phone-duplicate",
              "duplicate-candidate",
              "sparse-contact",
              "stale-contact",
            ],
            pattern: null,
          },
        },
      ],
    },
    capabilities: {},
    stations: [
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.audit",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "Offline audit completed on the Contact snapshot.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "google-contacts.audit:completed",
      }),
      station(googleContactsCauses, {
        ...stationWords,
        commandIdentity: "google-contacts.audit",
        causeCode: SCHEMA_INVALID_INPUT,
        trigger:
          "The --snapshot file is unreadable, malformed JSON, invalid contacts-snapshot/1, or --default-region is unsupported.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Supply a valid contacts-snapshot/1 file (or snapshot --json envelope) and supported ISO-3166 region code.",
          },
        },
        repairAction:
          "Regenerate the snapshot file with snapshot --json and pass a supported ISO-3166 region.",
        independentObservable: "google-contacts.audit:invalid-snapshot",
      }),
    ],
    run: (input, context) => {
      const region = resolveCountryCode(input["--default-region"] ?? "AU");
      if (region === null) {
        return context.result(
          {
            commandIdentity: "google-contacts.audit",
            causeCode: SCHEMA_INVALID_INPUT,
          },
          {
            message: `Unsupported --default-region: ${input["--default-region"] ?? ""}.`,
            data: null,
            effects: noEffects,
          },
        );
      }
      const loaded = readJsonFile(input["--snapshot"]);
      if (!loaded.ok) {
        return context.result(
          {
            commandIdentity: "google-contacts.audit",
            causeCode: SCHEMA_INVALID_INPUT,
          },
          { message: loaded.reason, data: null, effects: noEffects },
        );
      }
      const snapshot = decodeSnapshotDoc(loaded.value);
      if (snapshot === null) {
        return context.result(
          {
            commandIdentity: "google-contacts.audit",
            causeCode: SCHEMA_INVALID_INPUT,
          },
          {
            message:
              "File does not contain a valid contacts-snapshot/1 payload.",
            data: null,
            effects: noEffects,
          },
        );
      }
      const auditDoc = runContactsAudit(
        snapshot,
        region,
        input["--lane"] ?? null,
      );
      return context.result(
        {
          commandIdentity: "google-contacts.audit",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Found ${String(auditDoc.findings.length)} audit finding(s) across ${String(auditDoc.contactCount)} contact(s).`,
          data: auditDoc,
          effects: noEffects,
        },
      );
    },
  });
}
