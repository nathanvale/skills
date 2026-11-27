import { YAML } from "bun";
import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { helloWorldContract } from "../src/skill-clis/hello-world.ts";
import {
  discoverSkills,
  repositoryRoot,
  validateSkillsRepository,
} from "../src/skills-catalog/skills-catalog.ts";
import { withCatalogCopy } from "./support/catalog-copy.ts";
import { testFolder } from "./support/test-folder.ts";

const repoCli = join(repositoryRoot(), "src", "cli.ts");

test("front-door CLI lists promoted skills, validates manifests, and runs greet", () => {
  const elsewhere = testFolder("skills-frontdoor-");
  try {
    const listed = Bun.spawnSync(
      [process.execPath, "run", repoCli, "list", "--promoted-only", "--json"],
      { cwd: elsewhere, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: listed.exitCode,
      stderr: listed.stderr.toString(),
    }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(JSON.parse(listed.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "skills.list",
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          skills: [
            {
              name: "ci-reproduce",
              bucket: "engineering",
              invocation: "user-invoked",
              promoted: true,
              portableCli: null,
            },
            {
              name: "hello-world",
              bucket: "engineering",
              promoted: true,
              portableCli: "skills/engineering/hello-world/dist/cli.mjs",
            },
            {
              name: "test-design",
              bucket: "engineering",
              invocation: "model-invoked",
              promoted: true,
              portableCli: null,
            },
            {
              name: "weekly-hardening",
              bucket: "engineering",
              promoted: true,
              portableCli: null,
            },
            {
              name: "xdg",
              bucket: "engineering",
              invocation: "user-invoked",
              promoted: true,
              portableCli: null,
            },
            {
              name: "delivery-slice",
              bucket: "experimental",
              invocation: "model-invoked",
              promoted: true,
              portableCli: null,
            },
            {
              name: "test-runner",
              bucket: "experimental",
              invocation: "model-invoked",
              promoted: true,
              portableCli: null,
            },
            {
              name: "imessage-reader",
              bucket: "productivity",
              invocation: "user-invoked",
              promoted: true,
              portableCli: null,
            },
            {
              name: "linear-intake",
              bucket: "productivity",
              invocation: "model-invoked",
              promoted: true,
              portableCli: null,
            },
          ],
        },
      },
    });

    const validated = Bun.spawnSync(
      [process.execPath, "run", repoCli, "validate", "--json"],
      { cwd: elsewhere, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: validated.exitCode,
      stderr: validated.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(validated.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "skills.validate",
        causeCode: "SUCCESS_UNCHANGED",
        data: { valid: true, skillCount: 10, promotedCount: 9, issues: [] },
      },
    });

    const greeted = Bun.spawnSync(
      [process.execPath, "run", repoCli, "greet", "Nathan", "--loud", "--json"],
      { cwd: elsewhere, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: greeted.exitCode,
      stderr: greeted.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(greeted.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "hello-world.greet",
        causeCode: "SUCCESS_UNCHANGED",
        data: { greeting: "HELLO, NATHAN!", name: "Nathan", loud: true },
      },
    });
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("copied hello-world skill runs standalone in a sterile folder without node_modules", () => {
  const isolated = testFolder("portable-hello-world-");
  const unrelatedCwd = testFolder("portable-cwd-");
  try {
    const sourceSkill = join(
      repositoryRoot(),
      "skills",
      "engineering",
      "hello-world",
    );
    const copiedSkill = join(isolated, "hello-world");
    cpSync(sourceSkill, copiedSkill, { recursive: true });
    const portableCli = join(copiedSkill, "dist", "cli.mjs");

    const bundleText = readFileSync(portableCli, "utf8");
    expect(bundleText).not.toContain("@logtape");
    expect(bundleText).not.toContain("linux-flock");
    expect(bundleText).not.toContain("addons/diagnostics");

    const discovered = Bun.spawnSync(
      [process.execPath, portableCli, "--discover", "--json"],
      { cwd: unrelatedCwd, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: discovered.exitCode,
      stderr: discovered.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    const discoveredBody: unknown = JSON.parse(discovered.stdout.toString());
    expect(discoveredBody).toHaveProperty(
      "availablePaths",
      expect.arrayContaining([
        "hello-world.command-discovery",
        "hello-world.discovery",
        "hello-world.dispatch",
        "hello-world.greet",
        "hello-world.help",
      ]),
    );
    expect(discoveredBody).toMatchObject({
      contractVersion: "3.0.0",
      result: {
        commandIdentity: "hello-world.discovery",
        causeCode: "SUCCESS_UNCHANGED",
      },
    });

    const ok = Bun.spawnSync(
      [process.execPath, portableCli, "greet", "Portable", "--json"],
      { cwd: unrelatedCwd, stdout: "pipe", stderr: "pipe" },
    );
    expect({ exitCode: ok.exitCode, stderr: ok.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(JSON.parse(ok.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "hello-world.greet",
        causeCode: "SUCCESS_UNCHANGED",
        data: { greeting: "Hello, Portable!", name: "Portable", loud: false },
      },
    });

    const blank = Bun.spawnSync(
      [process.execPath, portableCli, "greet", "   ", "--json"],
      { cwd: unrelatedCwd, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: blank.exitCode,
      stderr: blank.stderr.toString(),
    }).toEqual({
      exitCode: 3,
      stderr: "",
    });
    expect(JSON.parse(blank.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "hello-world.greet",
        causeCode: "DOMAIN_HELLO_BLANK_NAME",
      },
    });

    const badFlag = Bun.spawnSync(
      [process.execPath, portableCli, "--unknown-flag"],
      { cwd: unrelatedCwd, stdout: "pipe", stderr: "pipe" },
    );
    expect(badFlag.exitCode).toBe(2);
    expect(badFlag.stdout.toString()).toBe("");
    expect(badFlag.stderr.toString().trim().length).toBeGreaterThan(0);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});

test("portable skill CLI bundles match fresh builds and repository catalogs stay valid", () => {
  expect(helloWorldContract.cli).toBe("hello-world");
  const skills = discoverSkills();
  expect(skills.length).toBe(10);
  expect(skills.find((item) => item.name === "google-contacts")).toMatchObject({
    name: "google-contacts",
    bucket: "in-progress",
    invocation: "user-invoked",
    promoted: false,
    portableCli: "skills/in-progress/google-contacts/dist/cli.mjs",
  });
  expect(validateSkillsRepository().valid).toBe(true);

  const manifest: unknown = JSON.parse(
    readFileSync(join(repositoryRoot(), "package.json"), "utf8"),
  );
  const bundlesField: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "bundles")
      : undefined;
  expect(typeof bundlesField === "object" && bundlesField !== null).toBe(true);
  const bundleOutputs =
    typeof bundlesField === "object" && bundlesField !== null
      ? Object.keys(bundlesField)
      : [];
  expect(bundleOutputs.length).toBeGreaterThan(0);
  for (const outputFile of bundleOutputs) {
    const fullPath = join(repositoryRoot(), outputFile);
    expect(existsSync(fullPath)).toBe(true);
    expect(readFileSync(fullPath, "utf8").length).toBeGreaterThan(0);
  }

  const checked = Bun.spawnSync(
    [process.execPath, "run", "--silent", "check:bundles"],
    {
      cwd: repositoryRoot(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect({
    exitCode: checked.exitCode,
    stderr: checked.stderr.toString(),
  }).toEqual({ exitCode: 0, stderr: "" });
});

function issuesOrThrownError(root: string): readonly string[] {
  try {
    return validateSkillsRepository(root).issues;
  } catch (error) {
    return [`threw ${String(error)}`];
  }
}

test("validate refuses a blank line after the opening front matter fence and a user-only skill without its Codex policy", () => {
  withCatalogCopy("skills-planted-", (copy) => {
    expect(validateSkillsRepository(copy).issues).toEqual([]);

    const skillFile = join(
      copy,
      "skills/engineering/weekly-hardening/SKILL.md",
    );
    writeFileSync(
      skillFile,
      readFileSync(skillFile, "utf8").replace(/^---\n/, "---\n\n"),
    );
    rmSync(join(copy, "skills/engineering/hello-world/agents/openai.yaml"));

    expect(validateSkillsRepository(copy).issues).toEqual([
      '[typed-drift] skills/engineering/hello-world: disable-model-invocation is true but Codex ignores it. Repair: add agents/openai.yaml with "policy:" and "  allow_implicit_invocation: false". See agent-engineering ADR 0003.',
      'skills/engineering/weekly-hardening/SKILL.md: frontmatter must start with a field on the line after the opening "---". Repair: delete the blank line after "---".',
    ]);
  });
});

test("validate accepts a user-only skill only when Codex reads allow_implicit_invocation false under a top-level policy mapping", () => {
  withCatalogCopy("skills-codex-policy-", (copy) => {
    const policyFile = join(
      copy,
      "skills/engineering/hello-world/agents/openai.yaml",
    );
    const refusal =
      '[typed-drift] skills/engineering/hello-world: disable-model-invocation is true but Codex ignores it. Repair: add agents/openai.yaml with "policy:" and "  allow_implicit_invocation: false". See agent-engineering ADR 0003.';
    const plantedPolicies: Readonly<Record<string, string>> = {
      "key at top level": "allow_implicit_invocation: false\n",
      "key under interface while policy says true":
        "interface:\n  allow_implicit_invocation: false\npolicy:\n  allow_implicit_invocation: true\n",
      "policy nested under another parent":
        "interface:\n  policy:\n    allow_implicit_invocation: false\n",
      "text inside a block scalar while policy says true":
        "interface:\n  default_prompt: |\n    allow_implicit_invocation: false\npolicy:\n  allow_implicit_invocation: true\n",
      "text only inside a block scalar":
        "interface:\n  default_prompt: |\n    allow_implicit_invocation: false\n",
      "text only inside a comment":
        "policy:\n  # allow_implicit_invocation: false\n",
      "quoted string false": 'policy:\n  allow_implicit_invocation: "false"\n',
      "broken YAML": "policy:\n  allow_implicit_invocation: [false\n",
      "trailing comment after false":
        "policy:\n  allow_implicit_invocation: false # manual only\n",
    };
    const outcomes: Record<string, readonly string[]> = {};
    for (const [label, contents] of Object.entries(plantedPolicies)) {
      writeFileSync(policyFile, contents);
      outcomes[label] = issuesOrThrownError(copy);
    }

    chmodSync(policyFile, 0o000);
    outcomes["unreadable file"] = issuesOrThrownError(copy);
    chmodSync(policyFile, 0o644);

    rmSync(policyFile);
    mkdirSync(policyFile);
    outcomes["folder in place of the file"] = issuesOrThrownError(copy);

    expect(outcomes).toEqual({
      "key at top level": [refusal],
      "key under interface while policy says true": [refusal],
      "policy nested under another parent": [refusal],
      "text inside a block scalar while policy says true": [refusal],
      "text only inside a block scalar": [refusal],
      "text only inside a comment": [refusal],
      "quoted string false": [refusal],
      "broken YAML": [refusal],
      "trailing comment after false": [],
      "unreadable file": [refusal],
      "folder in place of the file": [refusal],
    });
  });
});

test("validate flags typed-drift and passes once Codex policy is restored", () => {
  withCatalogCopy("skills-typed-drift-", (copy) => {
    const policy = join(
      copy,
      "skills/engineering/hello-world/agents/openai.yaml",
    );
    rmSync(policy);
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[typed-drift] skills/engineering/hello-world: disable-model-invocation is true but Codex ignores it. Repair: add agents/openai.yaml with "policy:" and "  allow_implicit_invocation: false". See agent-engineering ADR 0003.',
    ]);
    writeFileSync(policy, "policy:\n  allow_implicit_invocation: false\n");
    expect(validateSkillsRepository(copy).issues).toEqual([]);
  });
});

test("validate flags auto-drift and passes after adding the frontmatter marker or removing the policy", () => {
  withCatalogCopy("skills-auto-drift-", (copy) => {
    const skillFile = join(copy, "skills/engineering/test-design/SKILL.md");
    const originalSkill = readFileSync(skillFile, "utf8");
    const policyDir = join(copy, "skills/engineering/test-design/agents");
    const policyFile = join(policyDir, "openai.yaml");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(policyFile, "policy:\n  allow_implicit_invocation: false\n");
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[auto-drift] skills/engineering/test-design: agents/openai.yaml sets allow_implicit_invocation: false but SKILL.md lacks disable-model-invocation: true. Repair: add "disable-model-invocation: true" to SKILL.md front matter, or remove the policy if the skill should load automatically. See agent-engineering ADR 0003.',
    ]);
    writeFileSync(
      skillFile,
      originalSkill.replace(/^---\n/, "---\ndisable-model-invocation: true\n"),
    );
    expect(validateSkillsRepository(copy).issues).toEqual([]);
    writeFileSync(skillFile, originalSkill);
    rmSync(policyFile);
    expect(validateSkillsRepository(copy).issues).toEqual([]);
  });
});

test("validate flags stray-skill files outside known buckets and passes once moved or removed", () => {
  withCatalogCopy("skills-stray-", (copy) => {
    const strayPaths = [
      join(copy, "skills/engineering/hello-world/nested/SKILL.md"),
      join(copy, "skills/rogue/SKILL.md"),
      join(copy, "skills/unknown-bucket/orphan/SKILL.md"),
    ];
    for (const file of strayPaths) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "---\nname: stray\ndescription: stray\n---\n");
    }
    expect(validateSkillsRepository(copy).issues).toEqual([
      "[stray-skill] skills/engineering/hello-world/nested/SKILL.md: SKILL.md is outside a known bucket folder (skills/<bucket>/<skill>/SKILL.md). Repair: move it into a bucket, or delete it. See agent-engineering ADR 0003.",
      "[stray-skill] skills/rogue/SKILL.md: SKILL.md is outside a known bucket folder (skills/<bucket>/<skill>/SKILL.md). Repair: move it into a bucket, or delete it. See agent-engineering ADR 0003.",
      "[stray-skill] skills/unknown-bucket/orphan/SKILL.md: SKILL.md is outside a known bucket folder (skills/<bucket>/<skill>/SKILL.md). Repair: move it into a bucket, or delete it. See agent-engineering ADR 0003.",
    ]);
    for (const file of strayPaths) rmSync(file);
    mkdirSync(join(copy, "skills/in-progress/orphan"), { recursive: true });
    writeFileSync(
      join(copy, "skills/in-progress/orphan/SKILL.md"),
      "---\nname: orphan\ndescription: moved into in-progress\n---\n",
    );
    expect(validateSkillsRepository(copy).issues).toEqual([]);
  });
});

test("validate flags missing-manifest, invalid-manifest, and manifest-drift and passes once repaired", () => {
  withCatalogCopy("skills-manifests-", (copy) => {
    const manifestPath = join(copy, "plugin.json");
    const original = readFileSync(manifestPath, "utf8");
    rmSync(manifestPath);
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[missing-manifest] plugin.json: missing or unreadable plugin manifest. Repair: ensure plugin.json is present and readable with a "skills" array listing every promoted skill. See agent-engineering ADR 0003.',
    ]);
    writeFileSync(manifestPath, "{broken");
    expect(validateSkillsRepository(copy).issues).toEqual([
      "[invalid-manifest] plugin.json: invalid JSON. Repair: fix the JSON syntax in plugin.json. See agent-engineering ADR 0003.",
    ]);
    const drifted = original.replace(
      '"./skills/engineering/xdg"',
      '"./skills/in-progress/google-contacts"',
    );
    writeFileSync(manifestPath, drifted);
    expect(validateSkillsRepository(copy).issues).toEqual([
      '[manifest-drift] plugin.json: missing promoted skill "./skills/engineering/xdg". Repair: add "./skills/engineering/xdg" to "skills" in plugin.json. See agent-engineering ADR 0003.',
      '[manifest-drift] plugin.json: lists non-promoted or absent skill "./skills/in-progress/google-contacts". Repair: remove "./skills/in-progress/google-contacts" from "skills" in plugin.json. See agent-engineering ADR 0003.',
    ]);
    writeFileSync(manifestPath, original);
    expect(validateSkillsRepository(copy).issues).toEqual([]);
  });
});

test("xdg skill is thin, model-invoked, backed by sources.md, and uses a single-line YAML scalar description", () => {
  const skillDir = join(repositoryRoot(), "skills", "engineering", "xdg");
  const skillFile = join(skillDir, "SKILL.md");
  const sourcesFile = join(skillDir, "references", "sources.md");
  expect(existsSync(skillFile)).toBe(true);
  expect(existsSync(sourcesFile)).toBe(true);

  const markdown = readFileSync(skillFile, "utf8");
  const lineCount = markdown.trimEnd().split(/\r?\n/).length;
  expect(lineCount).toBeLessThan(50);

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    markdown,
  );
  expect(frontmatterMatch).not.toBeNull();
  const parsed: unknown = YAML.parse(frontmatterMatch?.[1] ?? "");
  const parsedDescription: unknown =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "description")
      : undefined;

  const entry = discoverSkills().find((item) => item.name === "xdg");
  expect(entry).toMatchObject({
    name: "xdg",
    bucket: "engineering",
    invocation: "user-invoked",
    promoted: true,
    portableCli: null,
  });
  expect(typeof parsedDescription).toBe("string");
  if (typeof parsedDescription === "string") {
    expect(parsedDescription).not.toContain("\n");
    expect(entry?.description).toBe(parsedDescription);
  }
});
