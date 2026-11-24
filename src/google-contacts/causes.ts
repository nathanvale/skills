import type { CauseTable } from "agent-cli-kernel";
import { commonCauses } from "agent-cli-kernel";

const domainRefusalRow = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
} as const;

const handoffRefusalRow = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;

export const googleContactsCauses = {
  ...commonCauses,
  DOMAIN_CONTACTS_GOG_UNAVAILABLE: domainRefusalRow,
  DOMAIN_CONTACTS_LANE_UNAVAILABLE: domainRefusalRow,
  DOMAIN_CONTACTS_PLAN_INVALID: domainRefusalRow,
  DOMAIN_CONTACTS_SEAL_MISMATCH: domainRefusalRow,
  DOMAIN_CONTACTS_REVISION_DRIFT: domainRefusalRow,
  DOMAIN_CONTACTS_APPLY_HELD: handoffRefusalRow,
  DOMAIN_CONTACTS_APPLY_UNRESOLVED: handoffRefusalRow,
  DOMAIN_CONTACTS_APPLY_UNAVAILABLE: handoffRefusalRow,
  DOMAIN_CONTACTS_APPLY_REJECTED: {
    outcome: "failed",
    transactionState: "completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_CONTACTS_APPLY_UNCONFIRMED: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_CONTACTS_LEDGER_UNREADABLE: handoffRefusalRow,
} as const satisfies CauseTable;

export const noEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

export const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

export const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

export const retryStationWords = {
  retryDelayPolicy: {
    kind: "bounded",
    minimumMilliseconds: 1_000,
    maximumMilliseconds: 30_000,
  },
  reachability: "required",
  unreachableRationale: null,
} as const;

export const SUCCESS_UNCHANGED =
  "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;
export const SUCCESS_COMPLETED =
  "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses;
export const SCHEMA_INVALID_INPUT =
  "SCHEMA_INVALID_INPUT" satisfies keyof typeof commonCauses;
export const TRANSIENT_NOT_STARTED =
  "TRANSIENT_NOT_STARTED" satisfies keyof typeof commonCauses;

export const DEFAULT_RETRY_DELAY_MS = 2_000;

export const ACCOUNT_OPTION = {
  name: "--account",
  aliases: [],
  summary: "Authenticated Google account email address.",
  required: true,
  repeatable: false,
  value: {
    kind: "string",
    minLength: 3,
    maxLength: 254,
    choices: null,
    pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
  },
} as const;

export const OPTIONAL_ACCOUNT_OPTION = {
  ...ACCOUNT_OPTION,
  required: false,
} as const;

export const CLIENT_OPTION = {
  name: "--client",
  aliases: [],
  summary: "Optional gog OAuth client name.",
  required: false,
  repeatable: false,
  value: {
    kind: "string",
    minLength: 1,
    maxLength: 128,
    choices: null,
    pattern: null,
  },
} as const;

export const CONTACT_OPTION = {
  name: "--contact",
  aliases: [],
  summary: "Target Contact resourceName (repeatable).",
  required: false,
  repeatable: true,
  value: {
    kind: "string",
    minLength: 8,
    maxLength: 128,
    choices: null,
    pattern: "^people/[A-Za-z0-9._-]+$",
  },
} as const;

export const SNAPSHOT_OPTION = {
  name: "--snapshot",
  aliases: [],
  summary: "Path to a contacts-snapshot/1 JSON file or CLI --json envelope.",
  required: true,
  repeatable: false,
  value: {
    kind: "string",
    minLength: 1,
    maxLength: 4096,
    choices: null,
    pattern: null,
  },
} as const;
