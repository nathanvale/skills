import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSkills,
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
