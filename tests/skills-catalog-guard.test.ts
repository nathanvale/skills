import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  discoverSkills,
  repositoryRoot,
  validateSkillsRepository,
} from "../src/skills-catalog/skills-catalog.ts";
import { withCatalogCopy } from "./support/catalog-copy.ts";

test("validate flags unreadable plugin manifests as missing-manifest and passes once readable", () => {
  for (const rel of [".claude-plugin/plugin.json", "plugin.json"]) {
    withCatalogCopy("skills-unreadable-manifest-", (copy) => {
      const manifestPath = join(copy, rel);
      chmodSync(manifestPath, 0o000);
      try {
        expect(validateSkillsRepository(copy).issues).toEqual([
          `[missing-manifest] ${rel}: missing or unreadable plugin manifest. Repair: ensure ${rel} is present and readable with a "skills" array listing every promoted skill. See agent-engineering ADR 0003.`,
        ]);
      } finally {
        chmodSync(manifestPath, 0o644);
      }
      expect(validateSkillsRepository(copy).issues).toEqual([]);
    });
  }
});

test("validate reads disable-model-invocation from parsed YAML frontmatter, ignoring block scalars and allowing trailing comments", () => {
  withCatalogCopy("skills-frontmatter-yaml-", (copy) => {
    const skillDir = join(copy, "skills/in-progress/yaml-probe");
    const skillFile = join(skillDir, "SKILL.md");
    const policyDir = join(skillDir, "agents");
    const policyFile = join(policyDir, "openai.yaml");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(policyFile, "policy:\n  allow_implicit_invocation: false\n");

    writeFileSync(
      skillFile,
      [
        "---",
        "name: yaml-probe",
        "description: |",
        "  Explain this field:",
        "  disable-model-invocation: true",
        "---",
        "",
      ].join("\n"),
    );

    expect(
      discoverSkills(copy).find((entry) => entry.name === "yaml-probe")
        ?.invocation,
    ).toBe("model-invoked");
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[auto-drift] skills/in-progress/yaml-probe: agents/openai.yaml sets allow_implicit_invocation: false but SKILL.md lacks disable-model-invocation: true. Repair: add "disable-model-invocation: true" to SKILL.md front matter, or remove the policy if the skill should load automatically. See agent-engineering ADR 0003.',
    ]);

    writeFileSync(
      skillFile,
      [
        "---",
        "name: yaml-probe",
        "description: Typed only skill",
        "disable-model-invocation: true  # typed only",
        "---",
        "",
      ].join("\n"),
    );

    expect(
      discoverSkills(copy).find((entry) => entry.name === "yaml-probe")
        ?.invocation,
    ).toBe("user-invoked");
    expect(validateSkillsRepository(copy).issues).toEqual([]);

    rmSync(policyFile);
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[typed-drift] skills/in-progress/yaml-probe: disable-model-invocation is true but Codex ignores it. Repair: add agents/openai.yaml with "policy:" and "  allow_implicit_invocation: false". See agent-engineering ADR 0003.',
    ]);
  });
});

test("validate refuses non-boolean-true disable-model-invocation values and accepts plain true", () => {
  withCatalogCopy("skills-typed-only-values-", (copy) => {
    const skillDir = join(copy, "skills/in-progress/marker-probe");
    const skillFile = join(skillDir, "SKILL.md");
    const policyDir = join(skillDir, "agents");
    const policyFile = join(policyDir, "openai.yaml");
    mkdirSync(skillDir, { recursive: true });

    const refusal =
      "[typed-drift] skills/in-progress/marker-probe: disable-model-invocation must be the YAML boolean true. Repair: write disable-model-invocation: true, or remove the key for an automatic skill. See agent-engineering ADR 0003.";

    const invalidMarkers: Readonly<Record<string, string>> = {
      'double-quoted "true"': 'disable-model-invocation: "true"',
      "single-quoted 'true'": "disable-model-invocation: 'true'",
      "string yes": "disable-model-invocation: yes",
      "number 1": "disable-model-invocation: 1",
      "boolean false": "disable-model-invocation: false",
      "empty value": "disable-model-invocation:",
    };

    const outcomes: Record<string, readonly string[]> = {};
    for (const [label, line] of Object.entries(invalidMarkers)) {
      writeFileSync(
        skillFile,
        [
          "---",
          "name: marker-probe",
          "description: Probe skill",
          line,
          "---",
          "",
        ].join("\n"),
      );
      outcomes[label] = validateSkillsRepository(copy).issues;
    }

    mkdirSync(policyDir, { recursive: true });
    writeFileSync(policyFile, "policy:\n  allow_implicit_invocation: false\n");
    writeFileSync(
      skillFile,
      [
        "---",
        "name: marker-probe",
        "description: Probe skill",
        'disable-model-invocation: "true"',
        "---",
        "",
      ].join("\n"),
    );
    outcomes['quoted "true" with Codex policy'] =
      validateSkillsRepository(copy).issues;

    writeFileSync(
      skillFile,
      [
        "---",
        "name: marker-probe",
        "description: Probe skill",
        "disable-model-invocation: true",
        "---",
        "",
      ].join("\n"),
    );
    outcomes["plain boolean true with Codex policy"] =
      validateSkillsRepository(copy).issues;

    expect(outcomes).toEqual({
      'double-quoted "true"': [refusal],
      "single-quoted 'true'": [refusal],
      "string yes": [refusal],
      "number 1": [refusal],
      "boolean false": [refusal],
      "empty value": [refusal],
      'quoted "true" with Codex policy': [refusal],
      "plain boolean true with Codex policy": [],
    });
  });
});

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for "${key}"`);
  }
  return value.map((item) => String(item));
}

test("validate checks package.json pi.skills for missing pi, missing promoted skills, and extra in-progress skills", () => {
  withCatalogCopy("skills-pi-manifest-", (copy) => {
    const packageJsonPath = join(copy, "package.json");
    const original = readFileSync(packageJsonPath, "utf8");
    const parsed = readJsonObject(packageJsonPath);

    const withoutPi = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== "pi"),
    );
    writeFileSync(packageJsonPath, `${JSON.stringify(withoutPi, null, 2)}\n`);
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[missing-manifest] package.json: missing "pi" manifest. Repair: add a "pi" object with a "skills" array listing every promoted skill to package.json. See agent-engineering ADR 0003.',
    ]);

    const pluginSkills = readStringField(
      readJsonObject(join(copy, ".claude-plugin", "plugin.json")),
      "skills",
    );
    const missingPromoted = pluginSkills.filter(
      (skill) => skill !== "./skills/engineering/xdg",
    );
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(
        {
          ...withoutPi,
          pi: {
            skills: missingPromoted,
            extensions: [],
            prompts: [],
            themes: [],
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[invalid-manifest] package.json: missing promoted skill "./skills/engineering/xdg". Repair: add "./skills/engineering/xdg" to "pi.skills" in package.json. See agent-engineering ADR 0003.',
    ]);

    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(
        {
          ...withoutPi,
          pi: {
            skills: [...pluginSkills, "./skills/in-progress/google-contacts"],
            extensions: [],
            prompts: [],
            themes: [],
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[invalid-manifest] package.json: lists non-promoted or absent skill "./skills/in-progress/google-contacts". Repair: remove "./skills/in-progress/google-contacts" from "pi.skills" in package.json. See agent-engineering ADR 0003.',
    ]);

    writeFileSync(packageJsonPath, original);
    expect(validateSkillsRepository(copy).issues).toEqual([]);
  });
});

test("repository package.json pi.skills matches .claude-plugin/plugin.json and passes validation", () => {
  const root = repositoryRoot();
  const packageJson = readJsonObject(join(root, "package.json"));
  const claudePlugin = readJsonObject(
    join(root, ".claude-plugin", "plugin.json"),
  );
  const pi = packageJson.pi;
  expect(typeof pi === "object" && pi !== null && !Array.isArray(pi)).toBe(
    true,
  );
  expect(
    typeof pi === "object" && pi !== null ? Reflect.get(pi, "skills") : null,
  ).toEqual(claudePlugin.skills);
  expect(validateSkillsRepository(root)).toMatchObject({
    valid: true,
    issues: [],
  });
});
