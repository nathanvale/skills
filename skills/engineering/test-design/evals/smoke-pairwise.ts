import { readFileSync } from "node:fs";
import { join } from "node:path";

export type JsonSchemaProperty =
  | { type: "string"; enum?: readonly string[] }
  | { type: "boolean" }
  | { type: "number" };

export type JsonSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: boolean;
};

type ExpectedResult = Record<string, string | boolean>;

export type SmokeTestDefinition = {
  id: string;
  title: string;
  schema: JsonSchema;
  prompt: string;
  expectations: {
    claude: Record<string, unknown>;
    codex: Record<string, unknown>;
  };
  runtime: Record<string, unknown>;
};

export const testDesignScenarioFactors = {
  artifacts: [
    "test",
    "fixture",
    "mock",
    "snapshot",
    "test-helper",
    "test-harness",
  ],
  handbacks: [
    "tdd",
    "diagnosing-bugs",
    "ci-testbed",
    "cli-design",
    "test-runner",
  ],
  profiles: [
    "process-and-cli",
    "browser-and-ui",
    "state-concurrency-recovery",
    "installation-host-hosted",
    "runtime-ci-platform",
    "runner-execution",
  ],
  operations: ["create", "change", "read", "run"],
  seams: ["existing", "new", "disputed"],
} as const;

export type TestDesignScenario = {
  id: string;
  prompt: string;
  artifact: (typeof testDesignScenarioFactors.artifacts)[number];
  handback: (typeof testDesignScenarioFactors.handbacks)[number];
  profiles: (typeof testDesignScenarioFactors.profiles)[number][];
  operation: (typeof testDesignScenarioFactors.operations)[number];
  seam: (typeof testDesignScenarioFactors.seams)[number];
  expected: {
    invokeTestDesign: boolean;
    briefBeforeEdit: boolean;
    activeWorkflowRemainsDriver: boolean;
    continuation: "return" | "await-seam-approval";
  };
};

export const testDesignV2QualificationCases = [
  {
    id: "persistent-watch",
    prompt:
      "A qualification command enters watch mode and stays alive until the harness kills it.",
    reject: true,
  },
  {
    id: "concurrency-axes",
    prompt:
      "A suite claims concurrency safety from parallel files without exercising concurrent tests inside one file.",
    reject: true,
  },
  {
    id: "runtime-portability",
    prompt:
      "A passing Node run is claimed as Bun portability evidence without naming their file-isolation difference.",
    reject: true,
  },
  {
    id: "timeout-cleanup",
    prompt:
      "A timed-out test is claimed to prove application cleanup because the runner killed its child.",
    reject: true,
  },
  {
    id: "human-reporter",
    prompt:
      "An agent parses a human progress reporter as the only machine contract even though a structured result exists.",
    reject: true,
  },
  {
    id: "compact-output",
    prompt:
      "A compact focused output omits skips and incomplete work, but is retained as the complete qualification receipt.",
    reject: true,
  },
  {
    id: "selector-count",
    prompt:
      "A focused selector exits zero without proving that the intended test count is non-zero and exact.",
    reject: true,
  },
  {
    id: "random-seed",
    prompt:
      "A randomized-order failure is reported without preserving the seed needed for replay.",
    reject: true,
  },
  {
    id: "mock-leakage",
    prompt:
      "A module mock is reset but its cache and global state are not restored before order and isolation change.",
    reject: true,
  },
  {
    id: "execution-versus-typecheck",
    prompt:
      "A transpile-only test run is claimed to prove TypeScript type correctness.",
    reject: true,
  },
  {
    id: "affected-only",
    prompt:
      "An affected-only run is used as the final repository qualification gate.",
    reject: true,
  },
  {
    id: "coverage-meaning",
    prompt:
      "Full line coverage is claimed as proof that the public behaviour is correct.",
    reject: true,
  },
  {
    id: "cli-consumers",
    prompt:
      "One assertion merges a human CLI prose surface and an agent JSON surface into the same consumer contract.",
    reject: true,
  },
  {
    id: "production-workflow",
    prompt:
      "A load-bearing test names an internal method result but omits the production consumer and full public workflow.",
    reject: true,
  },
  {
    id: "slow-suite-optimization",
    prompt:
      "A report recommends parallelism and sharding without slowest-file or execution-stage measurements.",
    reject: true,
  },
  {
    id: "read-only-selection-gate",
    prompt:
      "An architecture scan maps execution cost, proposes candidates, changes no files, and waits for selection.",
    reject: false,
  },
] as const;

export const testDesignV3QualificationCases = [
  {
    id: "vague-focused-command",
    prompt:
      "A brief names only 'focused Chromium test' without an executable command, working directory, selector, or expected count.",
    reject: true,
  },
  {
    id: "zero-test-selection",
    prompt:
      "An exact command exits zero after selecting zero tests and is claimed as regression proof.",
    reject: true,
  },
  {
    id: "observed-regression-red",
    prompt:
      "The exact existing focused regression is already observed failing on the defect, so the brief records that failure as RED evidence.",
    reject: false,
  },
  {
    id: "missing-perturbation-red",
    prompt:
      "No failing regression was observed, and the brief claims sensitivity without naming a disposable perturbation and restored GREEN.",
    reject: true,
  },
  {
    id: "lightweight-changed-oracle",
    prompt:
      "A lightweight brief replaces the oracle contract and fixture while claiming that an unchanged seam makes the route safe.",
    reject: true,
  },
  {
    id: "no-brief-with-test-edit",
    prompt:
      "The active workflow changes a repository-test artifact but skips test-design because the production diff is tiny.",
    reject: true,
  },
] as const;

const { artifacts, handbacks, profiles, operations, seams } =
  testDesignScenarioFactors;

export function schemaProperties(
  fields: readonly string[],
  property: JsonSchemaProperty,
): Record<string, JsonSchemaProperty> {
  return Object.fromEntries(
    fields.map((field): [string, JsonSchemaProperty] => [field, property]),
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\n") === keys.toSorted().join("\n");
}

export function objectSchema(
  properties: Record<string, JsonSchemaProperty>,
): JsonSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function readScenarioManifest(): unknown[] {
  const parsed = JSON.parse(
    readFileSync(join(import.meta.dir, "pairwise-scenarios.json"), "utf8"),
  ) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !exactKeys(parsed as Record<string, unknown>, [
      "schema_version",
      "scenarios",
    ]) ||
    (parsed as { schema_version?: unknown }).schema_version !== 2 ||
    !Array.isArray((parsed as { scenarios?: unknown }).scenarios)
  ) {
    throw new Error("test-design pairwise manifest header is invalid");
  }
  return (parsed as { scenarios: unknown[] }).scenarios;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isExpectedShape(
  expected: Record<string, unknown> | undefined,
): boolean {
  if (typeof expected !== "object" || expected === null) return false;
  if (
    !exactKeys(expected, [
      "invokeTestDesign",
      "briefBeforeEdit",
      "activeWorkflowRemainsDriver",
      "continuation",
    ])
  ) {
    return false;
  }
  if (typeof expected.invokeTestDesign !== "boolean") return false;
  if (typeof expected.briefBeforeEdit !== "boolean") return false;
  if (typeof expected.activeWorkflowRemainsDriver !== "boolean") return false;
  return ["return", "await-seam-approval"].includes(
    String(expected.continuation),
  );
}

function isScenarioShapeValid(scenario: Record<string, unknown>): boolean {
  if (
    !exactKeys(scenario, [
      "id",
      "prompt",
      "artifact",
      "handback",
      "profiles",
      "operation",
      "seam",
      "expected",
    ])
  ) {
    return false;
  }
  if (!hasNonEmptyString(scenario.id)) return false;
  if (!hasNonEmptyString(scenario.prompt)) return false;
  if (!artifacts.includes(scenario.artifact as never)) return false;
  if (!handbacks.includes(scenario.handback as never)) return false;
  if (!Array.isArray(scenario.profiles)) return false;
  if (scenario.profiles.length !== 1) return false;
  if (!profiles.includes(scenario.profiles[0] as never)) return false;
  if (!operations.includes(scenario.operation as never)) return false;
  if (!seams.includes(scenario.seam as never)) return false;
  return isExpectedShape(
    scenario.expected as Record<string, unknown> | undefined,
  );
}

function validateScenario(candidate: unknown): void {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("test-design pairwise scenario must be an object");
  }
  const scenario = candidate as Record<string, unknown>;
  if (!isScenarioShapeValid(scenario)) {
    throw new Error(
      `test-design pairwise scenario is invalid: ${String(scenario.id)}`,
    );
  }
}

function parseScenarios(): TestDesignScenario[] {
  const scenarios = readScenarioManifest();
  for (const candidate of scenarios) validateScenario(candidate);
  return scenarios as TestDesignScenario[];
}

function readPatternLibrary(): string {
  return ["pattern-library.md", ...profiles.map((profile) => `${profile}.md`)]
    .map((name) =>
      readFileSync(join(import.meta.dir, "../references", name), "utf8"),
    )
    .join("\n\n");
}

function decisionFor(scenario: TestDesignScenario): string {
  const route = scenario.expected.invokeTestDesign
    ? "test-design"
    : "current-workflow";
  const brief = scenario.expected.briefBeforeEdit ? "complete" : "not-required";
  const selectedProfiles = scenario.expected.invokeTestDesign
    ? scenario.profiles.join(",")
    : "none";
  return [
    route,
    brief,
    selectedProfiles,
    scenario.handback,
    scenario.expected.continuation,
  ].join("|");
}

export function createPairwiseDefinition(): SmokeTestDefinition {
  const scenarios = parseScenarios();
  const fields = scenarios.map((_, index) => `s${index + 1}Decision`);
  const v2Fields = testDesignV2QualificationCases.map(
    (_, index) => `v2c${index + 1}Reject`,
  );
  const v3Fields = testDesignV3QualificationCases.map(
    (_, index) => `v3c${index + 1}Reject`,
  );
  const expected = Object.fromEntries([
    ...scenarios.map((scenario, index) => [
      fields[index],
      decisionFor(scenario),
    ]),
    ...testDesignV2QualificationCases.map((scenario, index) => [
      v2Fields[index],
      scenario.reject,
    ]),
    ...testDesignV3QualificationCases.map((scenario, index) => [
      v3Fields[index],
      scenario.reject,
    ]),
  ]) as ExpectedResult;
  const scenarioPrompt = scenarios
    .map(
      (scenario, index) =>
        `${fields[index]} (${scenario.id}): ${scenario.prompt}`,
    )
    .join("\n");
  const v2Prompt = testDesignV2QualificationCases
    .map(
      (scenario, index) =>
        `${v2Fields[index]} (${scenario.id}): ${scenario.prompt}`,
    )
    .join("\n");
  const v3Prompt = testDesignV3QualificationCases
    .map(
      (scenario, index) =>
        `${v3Fields[index]} (${scenario.id}): ${scenario.prompt}`,
    )
    .join("\n");
  return {
    id: "test-design-pairwise-frozen",
    title: "Test-design frozen all-pairs matrix",
    schema: objectSchema({
      whoAmI: { type: "string", enum: ["claude", "codex"] },
      ...schemaProperties(fields, { type: "string" }),
      ...schemaProperties(v2Fields, { type: "boolean" }),
      ...schemaProperties(v3Fields, { type: "boolean" }),
    }),
    prompt: `Frozen test-design all-pairs qualification.

Evaluate each scenario against the canonical skill and pattern library below. Do not infer the expected profile from a supplied profile label; select it from the behaviour. Return one pipe-delimited decision per field with exactly five segments:

route|brief-status|selected-profile-ids-or-none|active-workflow|continuation

Use route test-design or current-workflow. Use brief-status complete or not-required. Selected profile ids must be exactly one of process-and-cli, browser-and-ui, state-concurrency-recovery, installation-host-hosted, runtime-ci-platform, runner-execution, or none; do not return headings or paths. Preserve the named active workflow. Use continuation return or await-seam-approval.

Canonical skill:
${readFileSync(join(import.meta.dir, "../SKILL.md"), "utf8")}

Canonical pattern library and profiles:
${readPatternLibrary()}

Scenarios:
${scenarioPrompt}

For each V2 challenge, return true when the proposed confidence claim must be rejected under the canonical guidance; return false when it is acceptable.

V2 challenges:
${v2Prompt}

For each proportional-routing challenge, return true when the proposed route or
evidence claim must be rejected; return false when it is acceptable.

Proportional-routing challenges:
${v3Prompt}

Return only the schema-matching JSON. Do not run tools or change files.`,
    expectations: {
      claude: { whoAmI: "claude", ...expected },
      codex: { whoAmI: "codex", ...expected },
    },
    runtime: {
      claudeModel: "opus",
      claudeEffort: "high",
      codexModel: "gpt-5.6-sol",
    },
  };
}
