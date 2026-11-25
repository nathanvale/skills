import { YAML } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asObjectMapping,
  compareCodeUnit,
  decodePiManifestSkills,
  decodePluginManifestSkills,
  formatRuleIssue,
  type JsonReadResult,
  validateSkillsList,
} from "./rules.ts";

export type SkillBucket =
  | "engineering"
  | "experimental"
  | "productivity"
  | "in-progress"
  | "misc"
  | "deprecated";

export type SkillEntry = {
  readonly name: string;
  readonly bucket: SkillBucket;
  readonly description: string;
  readonly invocation: "user-invoked" | "model-invoked";
  readonly promoted: boolean;
  readonly skillPath: string;
  readonly portableCli: string | null;
};

export type ValidationReport = {
  readonly valid: boolean;
  readonly skillCount: number;
  readonly promotedCount: number;
  readonly issues: readonly string[];
};

const PROMOTED_BUCKETS: ReadonlySet<string> = new Set([
  "engineering",
  "experimental",
  "productivity",
]);

const KNOWN_BUCKETS: ReadonlyMap<string, SkillBucket> = new Map([
  ["engineering", "engineering"],
  ["experimental", "experimental"],
  ["productivity", "productivity"],
  ["in-progress", "in-progress"],
  ["misc", "misc"],
  ["deprecated", "deprecated"],
]);

const MODULE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function parseFrontmatter(markdown: string): object | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (match === null) return null;
  const block = match[1] ?? "";
  try {
    return asObjectMapping(YAML.parse(block));
  } catch {
    return null;
  }
}

function readFrontmatterString(
  frontmatter: object | null,
  key: string,
): string | null {
  if (frontmatter === null || !Object.hasOwn(frontmatter, key)) return null;
  const value: unknown = Reflect.get(frontmatter, key);
  return typeof value === "string" ? value : null;
}

function isModelInvocationDisabled(frontmatter: object | null): boolean {
  return (
    frontmatter !== null &&
    Object.hasOwn(frontmatter, "disable-model-invocation") &&
    Reflect.get(frontmatter, "disable-model-invocation") === true
  );
}

function parseJsonFile(path: string): JsonReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "read" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "parse" };
  }
}

export function repositoryRoot(): string {
  return MODULE_ROOT;
}

export function discoverSkills(root = MODULE_ROOT): readonly SkillEntry[] {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];
  const entries: SkillEntry[] = [];
  const bucketDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnit);

  for (const bucketName of bucketDirs) {
    const bucket = KNOWN_BUCKETS.get(bucketName);
    if (bucket === undefined) continue;
    const bucketPath = join(skillsDir, bucketName);
    const skillDirs = readdirSync(bucketPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCodeUnit);

    for (const skillDir of skillDirs) {
      const skillFolder = join(bucketPath, skillDir);
      const skillFile = join(skillFolder, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const fields = parseFrontmatter(readFileSync(skillFile, "utf8"));
      const name = readFrontmatterString(fields, "name") ?? skillDir;
      const description = readFrontmatterString(fields, "description") ?? "";
      const disabled = isModelInvocationDisabled(fields);
      const cliBundle = join(skillFolder, "dist", "cli.mjs");
      entries.push({
        name,
        bucket,
        description,
        invocation: disabled ? "user-invoked" : "model-invoked",
        promoted: PROMOTED_BUCKETS.has(bucket),
        skillPath: relative(root, skillFolder).split("\\").join("/"),
        portableCli: existsSync(cliBundle)
          ? relative(root, cliBundle).split("\\").join("/")
          : null,
      });
    }
  }
  return entries;
}

const FRONTMATTER_OPENS_WITH_A_FIELD = /^---\r?\n[A-Za-z]/;

function readYamlOrNull(path: string): unknown {
  try {
    return YAML.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function codexRefusesImplicitInvocation(document: unknown): boolean {
  const root = asObjectMapping(document);
  if (root === null || !Object.hasOwn(root, "policy")) {
    return false;
  }
  const policy = asObjectMapping(Reflect.get(root, "policy"));
  return (
    policy !== null &&
    Object.hasOwn(policy, "allow_implicit_invocation") &&
    Reflect.get(policy, "allow_implicit_invocation") === false
  );
}

function invocationMarkerIssue(
  root: string,
  entry: SkillEntry,
  frontmatter: object,
): string | null {
  if (
    Object.hasOwn(frontmatter, "disable-model-invocation") &&
    Reflect.get(frontmatter, "disable-model-invocation") !== true
  ) {
    return formatRuleIssue(
      "typed-drift",
      entry.skillPath,
      "disable-model-invocation must be the YAML boolean true",
      "write disable-model-invocation: true, or remove the key for an automatic skill",
    );
  }
  const policyPath = join(root, entry.skillPath, "agents", "openai.yaml");
  const codexDisabled = codexRefusesImplicitInvocation(
    readYamlOrNull(policyPath),
  );
  if (entry.invocation === "user-invoked" && !codexDisabled) {
    return formatRuleIssue(
      "typed-drift",
      entry.skillPath,
      "disable-model-invocation is true but Codex ignores it",
      'add agents/openai.yaml with "policy:" and "  allow_implicit_invocation: false"',
    );
  }
  if (entry.invocation === "model-invoked" && codexDisabled) {
    return formatRuleIssue(
      "auto-drift",
      entry.skillPath,
      "agents/openai.yaml sets allow_implicit_invocation: false but SKILL.md lacks disable-model-invocation: true",
      'add "disable-model-invocation: true" to SKILL.md front matter, or remove the policy if the skill should load automatically',
    );
  }
  return null;
}

function collectSkillFiles(dir: string, files: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    compareCodeUnit(a.name, b.name),
  );
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSkillFiles(fullPath, files);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(fullPath);
    }
  }
}

function isKnownBucketSkillFile(relFromSkills: string): boolean {
  const parts = relFromSkills.split("/");
  const bucket = parts[0] ?? "";
  return parts.length === 3 && KNOWN_BUCKETS.has(bucket);
}

function validateStraySkills(root: string): string[] {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];
  const found: string[] = [];
  collectSkillFiles(skillsDir, found);
  const issues: string[] = [];
  for (const filePath of found) {
    const relFromSkills = relative(skillsDir, filePath).split("\\").join("/");
    if (isKnownBucketSkillFile(relFromSkills)) continue;
    const rel = relative(root, filePath).split("\\").join("/");
    issues.push(
      formatRuleIssue(
        "stray-skill",
        rel,
        "SKILL.md is outside a known bucket folder (skills/<bucket>/<skill>/SKILL.md)",
        "move it into a bucket, or delete it",
      ),
    );
  }
  return issues;
}

function validateSkillFiles(
  root: string,
  entries: readonly SkillEntry[],
): string[] {
  const issues: string[] = [];
  for (const entry of entries) {
    const file = join(root, entry.skillPath, "SKILL.md");
    const markdown = readFileSync(file, "utf8");
    const fields = parseFrontmatter(markdown);
    if (fields === null) {
      issues.push(`${entry.skillPath}/SKILL.md: missing YAML frontmatter`);
      continue;
    }
    if (!FRONTMATTER_OPENS_WITH_A_FIELD.test(markdown)) {
      issues.push(
        `${entry.skillPath}/SKILL.md: frontmatter must start with a field on the line after the opening "---". Repair: delete the blank line after "---".`,
      );
    }
    const markerIssue = invocationMarkerIssue(root, entry, fields);
    if (markerIssue !== null) issues.push(markerIssue);
    const declaredName = readFrontmatterString(fields, "name") ?? "";
    const description = readFrontmatterString(fields, "description") ?? "";
    if (declaredName.trim().length === 0) {
      issues.push(`${entry.skillPath}/SKILL.md: missing frontmatter "name"`);
    }
    if (description.trim().length === 0) {
      issues.push(
        `${entry.skillPath}/SKILL.md: missing frontmatter "description"`,
      );
    }
  }
  return issues;
}

function validateManifestSync(
  root: string,
  expectedPromoted: readonly string[],
): string[] {
  const issues: string[] = [];
  const manifestPaths = [
    join(root, ".claude-plugin", "plugin.json"),
    join(root, "plugin.json"),
  ];
  for (const manifestPath of manifestPaths) {
    const rel = relative(root, manifestPath).split("\\").join("/");
    const result = decodePluginManifestSkills(parseJsonFile(manifestPath), rel);
    if (result.issue !== null) {
      issues.push(result.issue);
      continue;
    }
    issues.push(
      ...validateSkillsList(
        "manifest-drift",
        rel,
        "skills",
        result.skills ?? [],
        expectedPromoted,
      ),
    );
  }
  const piResult = decodePiManifestSkills(
    parseJsonFile(join(root, "package.json")),
  );
  if (piResult.issue !== null) {
    issues.push(piResult.issue);
  } else {
    issues.push(
      ...validateSkillsList(
        "invalid-manifest",
        "package.json",
        "pi.skills",
        piResult.skills ?? [],
        expectedPromoted,
      ),
    );
  }
  return issues;
}

export function validateSkillsRepository(root = MODULE_ROOT): ValidationReport {
  const entries = discoverSkills(root);
  const expectedPromoted = entries
    .filter((entry) => entry.promoted)
    .map((entry) => `./${entry.skillPath}`)
    .sort(compareCodeUnit);

  const issues = [
    ...validateStraySkills(root),
    ...validateSkillFiles(root, entries),
    ...validateManifestSync(root, expectedPromoted),
  ];
  return {
    valid: issues.length === 0,
    skillCount: entries.length,
    promotedCount: expectedPromoted.length,
    issues,
  };
}
