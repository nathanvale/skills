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

const domainDataRefusalRow = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
  carriesData: true,
} as const;

const handoffRefusalRow = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;

export const cvTailorCauses = {
  ...commonCauses,
  DOMAIN_CV_TAILOR_PREREQUISITE_MISSING: domainDataRefusalRow,
  DOMAIN_CV_TAILOR_SETTINGS_INVALID: domainRefusalRow,
  DOMAIN_CV_TAILOR_SETTINGS_MISSING: domainRefusalRow,
  DOMAIN_CV_TAILOR_STATE_UNAVAILABLE: handoffRefusalRow,
  DOMAIN_CV_TAILOR_FILE_UNREADABLE: domainRefusalRow,
  DOMAIN_CV_TAILOR_QUERY_INVALID: domainRefusalRow,
  DOMAIN_CV_TAILOR_SOURCE_INVALID: domainRefusalRow,
  DOMAIN_CV_TAILOR_TEMPLATE_INVALID: domainRefusalRow,
  DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE: domainRefusalRow,
  DOMAIN_CV_TAILOR_CHECK_FAILED: domainDataRefusalRow,
  DOMAIN_CV_TAILOR_PROGRAM_FAILED: domainRefusalRow,
  DOMAIN_CV_TAILOR_BUILD_HELD: handoffRefusalRow,
  DOMAIN_CV_TAILOR_BUILD_UNRESOLVED: handoffRefusalRow,
  DOMAIN_CV_TAILOR_BUILD_UNAVAILABLE: handoffRefusalRow,
  DOMAIN_CV_TAILOR_BUILD_FAILED: {
    outcome: "failed",
    transactionState: "completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_CV_TAILOR_BUILD_PARTIAL: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_CV_TAILOR_BUILD_UNCONFIRMED: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_CV_TAILOR_PILE_INPUT_INVALID: domainRefusalRow,
  DOMAIN_CV_TAILOR_PILES_EXIST: domainRefusalRow,
  DOMAIN_CV_TAILOR_PILE_HELD: handoffRefusalRow,
  DOMAIN_CV_TAILOR_PILE_UNRESOLVED: handoffRefusalRow,
  DOMAIN_CV_TAILOR_PILE_UNAVAILABLE: handoffRefusalRow,
  DOMAIN_CV_TAILOR_PILE_PARTIAL: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_CV_TAILOR_PILE_UNCONFIRMED: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;

export const SUCCESS_UNCHANGED =
  "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;
export const SUCCESS_COMPLETED =
  "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses;

export const FILE_PATH_VALUE = {
  kind: "string",
  minLength: 1,
  maxLength: 4096,
  choices: null,
  pattern: null,
} as const;

export const NON_EMPTY_TEXT_VALUE = {
  kind: "string",
  minLength: 1,
  maxLength: 2048,
  choices: null,
  pattern: null,
} as const;

export const noEffects = {
  inventoryComplete: true,
  completed: [],
  remaining: [],
  uncertain: [],
} as const;

export const stationWords = {
  reachability: "required",
  unreachableRationale: null,
  retryDelayPolicy: { kind: "none" },
} as const;

export const noInput = {
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
  arguments: [],
  options: [],
  constraints: [],
} as const;
