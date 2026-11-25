import type { CauseTable, commonCauses } from "agent-cli-kernel";
import {
  command,
  commonCauses as sharedCauses,
  station,
} from "agent-cli-kernel";
import {
  helloWorldCauses,
  helloWorldCommand,
} from "./skill-clis/hello-world.ts";
import {
  discoverSkills,
  validateSkillsRepository,
} from "./skills-catalog/skills-catalog.ts";
import {
  FLOATING_SKILL_REPAIR,
  inspectUserSkillFolders,
} from "./skills-doctor/skills-doctor.ts";

const causes = {
  ...sharedCauses,
  ...helloWorldCauses,
  DOMAIN_SKILLS_INVALID: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_FLOATING_SKILLS: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
} as const satisfies CauseTable;

const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

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

const status = command({
  identity: "skills.status",
  route: ["status"],
  summary: "Report that this command-line tool runs.",
  input: noInput,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      {
        commandIdentity: "skills.status",
        causeCode: succeeded,
      },
      {
        message: "The command-line tool runs.",
        data: { ready: true },
        effects: noEffects,
      },
    ),
});

const list = command({
  identity: "skills.list",
  route: ["list"],
  summary:
    "List every skill in this repository with bucket and portable CLI info.",
  input: {
    ...noInput,
    options: [
      {
        name: "--promoted-only",
        aliases: [],
        summary: "Show only skills shipped in the plugin manifests.",
        required: false,
        repeatable: false,
        value: null,
      },
    ],
  },
  capabilities: {},
  run: (input, context) => {
    const all = discoverSkills();
    const skills =
      input["--promoted-only"] === true
        ? all.filter((entry) => entry.promoted)
        : all;
    return context.result(
      {
        commandIdentity: "skills.list",
        causeCode: succeeded,
      },
      {
        message: `${String(skills.length)} skills found.`,
        data: { skills },
        effects: noEffects,
      },
    );
  },
});

const validate = command({
  identity: "skills.validate",
  route: ["validate"],
  summary: "Validate SKILL.md frontmatter and plugin manifest parity.",
  input: noInput,
  capabilities: {},
  stations: [
    station(causes, {
      ...stationWords,
      commandIdentity: "skills.validate",
      causeCode: succeeded,
      trigger: "Every skill frontmatter and plugin manifest is in sync.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      independentObservable:
        "Zero validation issues across skills and manifests.",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: "skills.validate",
      causeCode: "DOMAIN_SKILLS_INVALID",
      trigger: "One or more skills or plugin manifests failed validation.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Repair the reported SKILL.md frontmatter or plugin manifest mismatch, then run validate again.",
        },
      },
      repairAction:
        "Fix the reported SKILL.md frontmatter or sync plugin.json and .claude-plugin/plugin.json.",
      independentObservable: "Validation issues list is non-empty.",
    }),
  ],
  run: (_input, context) => {
    const report = validateSkillsRepository();
    if (!report.valid) {
      return context.result(
        {
          commandIdentity: "skills.validate",
          causeCode: "DOMAIN_SKILLS_INVALID",
        },
        {
          message: `${String(report.issues.length)} validation issue(s): ${report.issues.join("; ")}`,
          data: null,
          effects: noEffects,
        },
      );
    }
    return context.result(
      {
        commandIdentity: "skills.validate",
        causeCode: succeeded,
      },
      {
        message: `Validated ${String(report.skillCount)} skills (${String(report.promotedCount)} promoted).`,
        data: report,
        effects: noEffects,
      },
    );
  },
});

const DOCTOR_PREVIEW_LIMIT = 5;

const doctorInput = {
  ...noInput,
  options: [
    {
      name: "--home",
      aliases: [],
      summary:
        "Home directory to scan (defaults to the current user's home directory).",
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
  ],
} as const;

const doctor = command({
  identity: "skills.doctor",
  route: ["doctor"],
  summary:
    "Check user-level skill folders for floating skills (agent-engineering ADR 0003); run doctor findings for the full list.",
  input: doctorInput,
  capabilities: {},
  stations: [
    station(causes, {
      ...stationWords,
      commandIdentity: "skills.doctor",
      causeCode: succeeded,
      trigger:
        "No floating SKILL.md files exist in the scanned user-level skill folders.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      independentObservable:
        "Zero floating skills across the checked user-level folders.",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: "skills.doctor",
      causeCode: "DOMAIN_FLOATING_SKILLS",
      trigger:
        "One or more SKILL.md files sit in a scanned user-level skill folder outside a plugin or repository.",
      guidance: {
        next: {
          kind: "command",
          command: "skills.doctor.findings",
          args: [],
        },
      },
      repairAction: `Run \`skills doctor findings\` for the full list, then ${FLOATING_SKILL_REPAIR}`,
      independentObservable:
        "At least one SKILL.md was found in a scanned user-level skill folder.",
    }),
  ],
  run: (input, context) => {
    const report = inspectUserSkillFolders(input["--home"]);
    if (report.findings.length > 0) {
      const preview = report.findings
        .slice(0, DOCTOR_PREVIEW_LIMIT)
        .map((finding) =>
          finding.symlinkTarget === null
            ? finding.path
            : `${finding.path} -> ${finding.symlinkTarget}`,
        )
        .join(", ");
      const remaining = report.findings.length - DOCTOR_PREVIEW_LIMIT;
      const more = remaining > 0 ? `, and ${String(remaining)} more` : "";
      return context.result(
        {
          commandIdentity: "skills.doctor",
          causeCode: "DOMAIN_FLOATING_SKILLS",
        },
        {
          message: `[floating-skill] ${String(report.findings.length)} floating skill(s) found: ${preview}${more}; run \`skills doctor findings\` for the full list. Repair: ${FLOATING_SKILL_REPAIR}`,
          data: null,
          effects: noEffects,
        },
      );
    }
    return context.result(
      {
        commandIdentity: "skills.doctor",
        causeCode: succeeded,
      },
      {
        message: `No floating skills found across ${String(report.checkedFolders.length)} user-level folders.`,
        data: report,
        effects: noEffects,
      },
    );
  },
});

const doctorFindings = command({
  identity: "skills.doctor.findings",
  route: ["doctor", "findings"],
  summary:
    "Return the full floating-skill report for user-level skill folders as typed data.",
  input: doctorInput,
  capabilities: {},
  run: (input, context) => {
    const report = inspectUserSkillFolders(input["--home"]);
    const message =
      report.findings.length === 0
        ? `No floating skills found across ${String(report.checkedFolders.length)} user-level folders.`
        : `${String(report.findings.length)} floating skill(s) found across ${String(report.checkedFolders.length)} user-level folders.`;
    return context.result(
      {
        commandIdentity: "skills.doctor.findings",
        causeCode: succeeded,
      },
      {
        message,
        data: report,
        effects: noEffects,
      },
    );
  },
});

export const skillCauses = causes;

export const commands = [
  status,
  list,
  validate,
  doctor,
  doctorFindings,
  helloWorldCommand,
] as const;
