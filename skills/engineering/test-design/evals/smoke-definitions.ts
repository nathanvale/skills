import {
  createPairwiseDefinition,
  type JsonSchema,
  type JsonSchemaProperty,
  objectSchema,
  type SmokeTestDefinition,
  schemaProperties,
  testDesignScenarioFactors,
} from "./smoke-pairwise.ts";

export {
  type JsonSchema,
  type JsonSchemaProperty,
  type SmokeTestDefinition,
  type TestDesignScenario,
  testDesignScenarioFactors,
  testDesignV2QualificationCases,
  testDesignV3QualificationCases,
} from "./smoke-pairwise.ts";

const { profiles } = testDesignScenarioFactors;
const runnerSensitiveRelevantProfiles = new Set<(typeof profiles)[number]>([
  "process-and-cli",
  "state-concurrency-recovery",
  "runtime-ci-platform",
  "runner-execution",
]);

const briefFields = [
  "behaviour",
  "seamAndProofLayer",
  "independentResult",
  "howItGoesRed",
  "relevantProfilesAndGotchas",
  "focusedCommand",
  "stillUnproved",
];

const lightweightBriefFields = [
  "behaviourBeingCorrected",
  "existingTestAndFocusedCommand",
  "howExistingTestGoesRed",
  "stillUnproved",
];

function fullBriefSchema(
  properties: Record<string, JsonSchemaProperty> = {},
): JsonSchema {
  return objectSchema({
    whoAmI: { type: "string", enum: ["claude", "codex"] },
    route: { type: "string", enum: ["full"] },
    ...schemaProperties(briefFields, { type: "string" }),
    exactFocusedCommand: { type: "string" },
    expectedSelectedTests: { type: "number" },
    redEvidenceKind: { type: "string", enum: ["disposable-perturbation"] },
    activeWorkflow: { type: "string" },
    qualificationChallenge: { type: "string" },
    profileQualificationChallenge: { type: "string" },
    ...properties,
  });
}

const mutationDefinition: SmokeTestDefinition = {
  id: "test-design-mutation-route",
  title: "Test-design fresh projected-skill mutation route",
  schema: fullBriefSchema({
    selectedProfiles: { type: "string" },
  }),
  prompt: `Fresh full-brief browser mutation canary.

The implementation workflow remains active. Its next step would change tests/horizontal-scroll.fixture to add a newly approved horizontal-scroll browser capture and parity-verdict contract. The test seam, oracle contract, and fixture are new, so the full route is required. The exact focused command is \`bun test tests/horizontal-scroll.test.ts -t 'captures horizontal traversal'\` from the repository root and it must select exactly one test. The owner-provided command contract and external delivery boundaries are settled and unchanged. For this authorized canary, browser-and-ui is the only relevant specialist profile; read it completely after the core library and read no other profile. No failing regression has been observed, so RED requires a disposable scroll-offset perturbation followed by restored GREEN. Follow the project startup instructions and stop at the mandatory pre-write checkpoint. Return the complete visible brief. Do not edit the fixture.

Use these JSON names for the seven brief fields: behaviour, seamAndProofLayer, independentResult, howItGoesRed, relevantProfilesAndGotchas, focusedCommand, stillUnproved. Return route as full, exactFocusedCommand as exactly \`bun test tests/horizontal-scroll.test.ts -t 'captures horizontal traversal'\`, selectedProfiles as the comma-separated profile ids actually read, expectedSelectedTests as 1, redEvidenceKind as disposable-perturbation, and activeWorkflow as implementation. The projected skill and the selected profile expose separate runtime qualification challenges; return them exactly as qualificationChallenge and profileQualificationChallenge.

Return only the schema-matching JSON. Use only read-only discovery and file-reading capabilities. Do not change files.`,
  expectations: {
    claude: {
      whoAmI: "claude",
      route: "full",
      exactFocusedCommand:
        "bun test tests/horizontal-scroll.test.ts -t 'captures horizontal traversal'",
      selectedProfiles: "browser-and-ui",
      expectedSelectedTests: 1,
      redEvidenceKind: "disposable-perturbation",
      activeWorkflow: "implementation",
    },
    codex: {
      whoAmI: "codex",
      route: "full",
      exactFocusedCommand:
        "bun test tests/horizontal-scroll.test.ts -t 'captures horizontal traversal'",
      selectedProfiles: "browser-and-ui",
      expectedSelectedTests: 1,
      redEvidenceKind: "disposable-perturbation",
      activeWorkflow: "implementation",
    },
  },
  runtime: {
    projectSkills: [
      { id: "test-design", sourceRelativePath: "skills/test-design" },
    ],
    claudeModel: "opus",
    challengeField: "qualificationChallenge",
    missingSkillPrompt: `Missing-skill negative control.

The next implementation step would change a repository-test artifact. Attempt the mandatory project skill route exactly once. If test-design is unavailable, do not search outside project skill discovery and do not invent its contents. Return the schema-matching JSON immediately: use route full, set exactFocusedCommand to skill-unavailable, keep activeWorkflow as implementation, use an empty selectedProfiles string, set expectedSelectedTests to 1 and redEvidenceKind to disposable-perturbation, put skill-unavailable in both challenge fields, and use a short non-empty unavailable explanation in every brief field. Do not change files.`,
    claudeEffort: "high",
    claudeTools: "Skill,Read",
    codexSandbox: "read-only",
    codexModel: "gpt-5.6-sol",
    mutationProof: {
      fixtureRelativePath: "tests/horizontal-scroll.fixture",
      initialFixture: "HORIZONTAL_SCROLL=before\n",
      expectedFixture: "HORIZONTAL_SCROLL=before\n",
      requiredBriefFields: briefFields,
    },
    traceProof: {
      skillId: "test-design",
      profileRelativePath: "references/browser-and-ui.md",
      profileChallengeField: "profileQualificationChallenge",
      forbiddenProfileRelativePaths: profiles
        .filter((profile) => profile !== "browser-and-ui")
        .map((profile) => `references/${profile}.md`),
    },
  },
};

const runnerSensitiveDefinition: SmokeTestDefinition = {
  id: "test-design-runner-sensitive-route",
  title: "Test-design conditional runner-execution route",
  schema: fullBriefSchema({
    runnerProfileSelected: { type: "boolean" },
    runnerEnvelopeApplied: { type: "boolean" },
  }),
  prompt: `Fresh runner-sensitive test mutation canary.

The implementation workflow remains active. Its next step would change tests/runner.fixture at an existing repository-approved seam. The promised behaviour is a one-shot Bun test command that selects exactly one test, exits without entering watch mode, cancels owned work on timeout, releases an exclusive port, emits a complete machine result, and returns the semantic exit status. The exact focused command is \`bun test tests/runner.test.ts -t 'emits one-shot cleanup receipt'\` from the repository root and it selects exactly one test. For this authorized trace canary, the relevant specialist set is process-and-cli, state-concurrency-recovery, runtime-ci-platform, and runner-execution; read those selected profiles completely and stop profile loading there. No failing regression has been observed, so RED requires a disposable stuck-watch perturbation followed by restored GREEN. Follow the project startup instructions and stop at the mandatory pre-write checkpoint. Return the complete visible brief. Do not edit the fixture.

Use these JSON names for the seven brief fields: behaviour, seamAndProofLayer, independentResult, howItGoesRed, relevantProfilesAndGotchas, focusedCommand, stillUnproved. Return route as full, exactFocusedCommand as exactly \`bun test tests/runner.test.ts -t 'emits one-shot cleanup receipt'\`, runnerProfileSelected as true only when runner-execution was selected, runnerEnvelopeApplied as true only when relevantProfilesAndGotchas covers one-shot termination, exact selection count, cancellation versus cleanup, and the machine receipt plus exit status, expectedSelectedTests as 1, redEvidenceKind as disposable-perturbation, and activeWorkflow as implementation. The projected skill and the selected profile expose separate runtime qualification challenges; return them exactly as qualificationChallenge and profileQualificationChallenge.

Return only the schema-matching JSON. Use only read-only discovery and file-reading capabilities. Do not change files.`,
  expectations: {
    claude: {
      whoAmI: "claude",
      route: "full",
      exactFocusedCommand:
        "bun test tests/runner.test.ts -t 'emits one-shot cleanup receipt'",
      runnerProfileSelected: true,
      runnerEnvelopeApplied: true,
      expectedSelectedTests: 1,
      redEvidenceKind: "disposable-perturbation",
      activeWorkflow: "implementation",
    },
    codex: {
      whoAmI: "codex",
      route: "full",
      exactFocusedCommand:
        "bun test tests/runner.test.ts -t 'emits one-shot cleanup receipt'",
      runnerProfileSelected: true,
      runnerEnvelopeApplied: true,
      expectedSelectedTests: 1,
      redEvidenceKind: "disposable-perturbation",
      activeWorkflow: "implementation",
    },
  },
  runtime: {
    projectSkills: [
      { id: "test-design", sourceRelativePath: "skills/test-design" },
    ],
    challengeField: "qualificationChallenge",
    claudeModel: "opus",
    claudeEffort: "high",
    claudeTools: "Skill,Read",
    codexSandbox: "read-only",
    codexModel: "gpt-5.6-sol",
    mutationProof: {
      fixtureRelativePath: "tests/runner.fixture",
      initialFixture: "RUNNER=before\n",
      expectedFixture: "RUNNER=before\n",
      requiredBriefFields: briefFields,
    },
    traceProof: {
      skillId: "test-design",
      profileRelativePath: "references/runner-execution.md",
      profileChallengeField: "profileQualificationChallenge",
      forbiddenProfileRelativePaths: profiles
        .filter((profile) => !runnerSensitiveRelevantProfiles.has(profile))
        .map((profile) => `references/${profile}.md`),
    },
  },
};

const simpleUnitDefinition: SmokeTestDefinition = {
  id: "test-design-simple-unit-route",
  title: "Test-design lightweight unchanged-boundary route",
  schema: objectSchema({
    whoAmI: { type: "string", enum: ["claude", "codex"] },
    route: { type: "string", enum: ["lightweight"] },
    ...schemaProperties(lightweightBriefFields, { type: "string" }),
    exactFocusedCommand: { type: "string" },
    selectedProfiles: { type: "string" },
    runnerEnvelopeApplied: { type: "boolean" },
    expectedSelectedTests: { type: "number" },
    redEvidenceKind: { type: "string", enum: ["observed-regression"] },
    activeWorkflow: { type: "string" },
    qualificationChallenge: { type: "string" },
  }),
  prompt: `Fresh lightweight tiny-CSS correction canary.

The implementation workflow remains active. It is correcting a 2px Select height mismatch with a tiny CSS dimension correction on the repository-approved browser parity seam. Its next step would change tests/select-height.fixture only to update the existing focused assertion to the already-approved canonical Select dimension. The seam, oracle contract, fixture meaning, harness behaviour, and claimed proof boundary are unchanged. The existing regression is already observed failing on the implementation defect. The exact focused command is \`bun test tests/select-height.test.ts -t 'keeps approved Select dimensions'\` from the repository root and it selects exactly one test. Follow the project startup instructions and stop at the proportional pre-write checkpoint. Return the lightweight brief. Do not edit the fixture.

Use these JSON names for the four lightweight fields: behaviourBeingCorrected, existingTestAndFocusedCommand, howExistingTestGoesRed, stillUnproved. Return route as lightweight, exactFocusedCommand as exactly \`bun test tests/select-height.test.ts -t 'keeps approved Select dimensions'\`, selectedProfiles as none, runnerEnvelopeApplied as false, expectedSelectedTests as 1, redEvidenceKind as observed-regression, and activeWorkflow as implementation. The projected skill exposes a runtime qualification challenge; return it exactly as qualificationChallenge.

Return only the schema-matching JSON. Use only read-only discovery and file-reading capabilities. Do not change files.`,
  expectations: {
    claude: {
      whoAmI: "claude",
      route: "lightweight",
      exactFocusedCommand:
        "bun test tests/select-height.test.ts -t 'keeps approved Select dimensions'",
      selectedProfiles: "none",
      runnerEnvelopeApplied: false,
      expectedSelectedTests: 1,
      redEvidenceKind: "observed-regression",
      activeWorkflow: "implementation",
    },
    codex: {
      whoAmI: "codex",
      route: "lightweight",
      exactFocusedCommand:
        "bun test tests/select-height.test.ts -t 'keeps approved Select dimensions'",
      selectedProfiles: "none",
      runnerEnvelopeApplied: false,
      expectedSelectedTests: 1,
      redEvidenceKind: "observed-regression",
      activeWorkflow: "implementation",
    },
  },
  runtime: {
    projectSkills: [
      { id: "test-design", sourceRelativePath: "skills/test-design" },
    ],
    challengeField: "qualificationChallenge",
    claudeModel: "opus",
    claudeEffort: "high",
    claudeTools: "Skill,Read",
    codexSandbox: "read-only",
    codexModel: "gpt-5.6-sol",
    mutationProof: {
      fixtureRelativePath: "tests/select-height.fixture",
      initialFixture: "SELECT_HEIGHT=before\n",
      expectedFixture: "SELECT_HEIGHT=before\n",
      requiredBriefFields: lightweightBriefFields,
    },
  },
};

const runOnlyDefinition: SmokeTestDefinition = {
  id: "test-design-run-only-negative",
  title: "Test-design fresh projected-skill run-only negative",
  schema: objectSchema({
    whoAmI: { type: "string", enum: ["claude", "codex"] },
    route: { type: "string", enum: ["no-new-brief"] },
    invokesTestDesign: { type: "boolean" },
    briefEmitted: { type: "boolean" },
    activeWorkflow: { type: "string" },
  }),
  prompt: `Fresh repository-test run-only canary.

The test-runner workflow remains active and owns the existing regression proof. Run-only work is requested conceptually: report whether the current route invokes test-design when no repository-test artifact will be created or changed. Do not run the tests. Return only the schema-matching JSON. Do not run tools or change files.`,
  expectations: {
    claude: {
      whoAmI: "claude",
      route: "no-new-brief",
      invokesTestDesign: false,
      briefEmitted: false,
      activeWorkflow: "test-runner",
    },
    codex: {
      whoAmI: "codex",
      route: "no-new-brief",
      invokesTestDesign: false,
      briefEmitted: false,
      activeWorkflow: "test-runner",
    },
  },
  runtime: {
    projectSkills: [
      { id: "test-design", sourceRelativePath: "skills/test-design" },
    ],
    claudeModel: "opus",
    claudeEffort: "high",
    codexModel: "gpt-5.6-sol",
  },
};

const boundaryEscalationDefinition: SmokeTestDefinition = {
  id: "test-design-boundary-escalation",
  title: "Test-design changed-boundary full-route guard",
  schema: fullBriefSchema({
    selectedProfiles: { type: "string" },
  }),
  prompt: `Fresh changed-boundary escalation canary.

The implementation workflow remains active. A proposed shortcut calls this a tiny CSS correction and asks for the lightweight route, but the next step changes tests/boundary.fixture to replace the rendered-height oracle contract, introduce a new browser fixture, and widen the browser claim from static height to interactive overflow and scroll position. The seam change is approved for this qualification, but these proof-boundary changes require the full route. The exact focused command is \`bun test tests/select-height.test.ts -t 'matches Select overflow contract'\` from the repository root and it selects exactly one test. The owner-provided command contract and external delivery boundaries are settled and unchanged. For this authorized canary, browser-and-ui is the only relevant specialist profile; read it completely after the core library and read no other profile. No failing regression has been observed, so RED requires a disposable wrong-height perturbation followed by restored GREEN. Follow the project startup instructions and stop at the pre-write checkpoint. Return the full brief. Do not edit the fixture.

Use these JSON names for the seven brief fields: behaviour, seamAndProofLayer, independentResult, howItGoesRed, relevantProfilesAndGotchas, focusedCommand, stillUnproved. Return route as full, exactFocusedCommand as exactly \`bun test tests/select-height.test.ts -t 'matches Select overflow contract'\`, selectedProfiles as browser-and-ui, expectedSelectedTests as 1, redEvidenceKind as disposable-perturbation, and activeWorkflow as implementation. The projected skill and selected profile expose separate runtime qualification challenges; return them exactly as qualificationChallenge and profileQualificationChallenge.

Return only the schema-matching JSON. Use only read-only discovery and file-reading capabilities. Do not change files.`,
  expectations: {
    claude: {
      whoAmI: "claude",
      route: "full",
      exactFocusedCommand:
        "bun test tests/select-height.test.ts -t 'matches Select overflow contract'",
      selectedProfiles: "browser-and-ui",
      expectedSelectedTests: 1,
      redEvidenceKind: "disposable-perturbation",
      activeWorkflow: "implementation",
    },
    codex: {
      whoAmI: "codex",
      route: "full",
      exactFocusedCommand:
        "bun test tests/select-height.test.ts -t 'matches Select overflow contract'",
      selectedProfiles: "browser-and-ui",
      expectedSelectedTests: 1,
      redEvidenceKind: "disposable-perturbation",
      activeWorkflow: "implementation",
    },
  },
  runtime: {
    projectSkills: [
      { id: "test-design", sourceRelativePath: "skills/test-design" },
    ],
    challengeField: "qualificationChallenge",
    claudeModel: "opus",
    claudeEffort: "high",
    claudeTools: "Skill,Read",
    codexSandbox: "read-only",
    codexModel: "gpt-5.6-sol",
    mutationProof: {
      fixtureRelativePath: "tests/boundary.fixture",
      initialFixture: "BOUNDARY=before\n",
      expectedFixture: "BOUNDARY=before\n",
      requiredBriefFields: briefFields,
    },
    traceProof: {
      skillId: "test-design",
      profileRelativePath: "references/browser-and-ui.md",
      profileChallengeField: "profileQualificationChallenge",
      forbiddenProfileRelativePaths: profiles
        .filter((profile) => profile !== "browser-and-ui")
        .map((profile) => `references/${profile}.md`),
    },
  },
};

export const testDesignSmokeTests: readonly SmokeTestDefinition[] = [
  createPairwiseDefinition(),
  mutationDefinition,
  runnerSensitiveDefinition,
  simpleUnitDefinition,
  runOnlyDefinition,
  boundaryEscalationDefinition,
];
