import { YAML } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(
  markdown: string,
): ReadonlyMap<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (match === null) return null;
  const block = match[1] ?? "";
  const fields = new Map<string, string>();
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = unquoteYamlScalar(line.slice(colon + 1));
    fields.set(key, value);
  }
  return fields;
}

function readManifestSkills(manifestPath: string): {
  readonly skills: readonly string[] | null;
  readonly issue: string | null;
} {
  if (!existsSync(manifestPath)) {
    return { skills: null, issue: `Missing plugin manifest: ${manifestPath}` };
  }
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { skills: null, issue: `${manifestPath}: expected JSON object` };
  }
  if (!Object.hasOwn(parsed, "skills")) {
    return { skills: null, issue: `${manifestPath}: missing "skills" array` };
  }
  const rawSkills: unknown = Reflect.get(parsed, "skills");
  if (!Array.isArray(rawSkills)) {
    return {
      skills: null,
      issue: `${manifestPath}: "skills" must be an array`,
    };
  }
  const items: string[] = [];
  for (const item of rawSkills) {
    if (typeof item !== "string") {
      return {
        skills: null,
        issue: `${manifestPath}: every "skills" entry must be a string`,
      };
    }
    items.push(item);
  }
  return { skills: items, issue: null };
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
      const name = fields?.get("name") ?? skillDir;
      const description = fields?.get("description") ?? "";
      const disabled = fields?.get("disable-model-invocation") === "true";
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

function asYamlMapping(value: unknown): object | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function readYamlOrNull(path: string): unknown {
  try {
    return YAML.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function codexRefusesImplicitInvocation(document: unknown): boolean {
  const root = asYamlMapping(document);
  if (root === null || !Object.hasOwn(root, "policy")) {
    return false;
  }
  const policy = asYamlMapping(Reflect.get(root, "policy"));
  return (
    policy !== null &&
    Object.hasOwn(policy, "allow_implicit_invocation") &&
    Reflect.get(policy, "allow_implicit_invocation") === false
  );
}

function codexPolicyIssue(root: string, entry: SkillEntry): string | null {
  if (entry.invocation !== "user-invoked") return null;
  const policyPath = join(root, entry.skillPath, "agents", "openai.yaml");
  if (codexRefusesImplicitInvocation(readYamlOrNull(policyPath))) return null;
  return `${entry.skillPath}: disable-model-invocation is true but Codex ignores it. Repair: add agents/openai.yaml with "policy:" and "  allow_implicit_invocation: false".`;
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
    const policyIssue = codexPolicyIssue(root, entry);
    if (policyIssue !== null) issues.push(policyIssue);
    const declaredName = fields.get("name") ?? "";
    const description = fields.get("description") ?? "";
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
    const result = readManifestSkills(manifestPath);
    if (result.issue !== null) {
      issues.push(result.issue);
      continue;
    }
    const actual = [...(result.skills ?? [])].sort(compareCodeUnit);
    for (const expected of expectedPromoted) {
      if (!actual.includes(expected)) {
        issues.push(`${rel}: missing promoted skill "${expected}"`);
      }
    }
    for (const listed of actual) {
      if (!expectedPromoted.includes(listed)) {
        issues.push(`${rel}: lists non-promoted or absent skill "${listed}"`);
      }
    }
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
