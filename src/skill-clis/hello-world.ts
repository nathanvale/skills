import type { CauseTable } from "agent-cli-kernel";
import { command, commonCauses, contractFor, station } from "agent-cli-kernel";

export const helloWorldCauses = {
  ...commonCauses,
  DOMAIN_HELLO_BLANK_NAME: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
} as const satisfies CauseTable;

const causes = helloWorldCauses;

const noEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

const succeeded = "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;

export const helloWorldCommand = command({
  identity: "hello-world.greet",
  route: ["greet"],
  summary: "Print a structured greeting from a portable kernel CLI.",
  input: {
    arguments: [
      {
        name: "name",
        summary: "Who to greet.",
        required: false,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 64,
          choices: null,
          pattern: null,
        },
      },
    ],
    options: [
      {
        name: "--loud",
        aliases: [],
        summary: "Uppercase the greeting.",
        required: false,
        repeatable: false,
        value: null,
      },
    ],
    constraints: [],
    deadlineSupported: false,
    additionalArguments: false,
    additionalOptions: false,
  },
  capabilities: {},
  stations: [
    station(causes, {
      ...stationWords,
      commandIdentity: "hello-world.greet",
      causeCode: succeeded,
      trigger: "A valid name was formatted into a greeting.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      independentObservable: "Structured greeting payload returned.",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: "hello-world.greet",
      causeCode: "DOMAIN_HELLO_BLANK_NAME",
      trigger: "The name argument contains only whitespace.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Pass a non-blank name argument and run greet again.",
        },
      },
      repairAction: "Pass a non-blank name argument.",
      independentObservable: "Trimmed name argument is empty.",
    }),
  ],
  run: (input, context) => {
    const rawName = input.name ?? "World";
    const trimmed = rawName.trim();
    if (trimmed.length === 0) {
      return context.result(
        {
          commandIdentity: "hello-world.greet",
          causeCode: "DOMAIN_HELLO_BLANK_NAME",
        },
        {
          message: "Name cannot be blank.",
          data: null,
          effects: noEffects,
        },
      );
    }
    const base = `Hello, ${trimmed}!`;
    const greeting = input["--loud"] === true ? base.toUpperCase() : base;
    return context.result(
      {
        commandIdentity: "hello-world.greet",
        causeCode: succeeded,
      },
      {
        message: greeting,
        data: { greeting, name: trimmed, loud: input["--loud"] === true },
        effects: noEffects,
      },
    );
  },
});

export const helloWorldContract = contractFor({
  cli: "hello-world",
  causes,
  commands: [helloWorldCommand],
  installedAddons: [],
});
