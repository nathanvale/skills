const ADR_0003_POINTER = "See agent-engineering ADR 0003.";

export type CatalogRule =
  | "typed-drift"
  | "auto-drift"
  | "stray-skill"
  | "missing-manifest"
  | "invalid-manifest"
  | "manifest-drift";

export type JsonReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "read" | "parse" };

export type ManifestSkillsResult = {
  readonly skills: readonly string[] | null;
  readonly issue: string | null;
};

export function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function asObjectMapping(value: unknown): object | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

export function formatRuleIssue(
  rule: CatalogRule,
  subject: string,
  detail: string,
  repair: string,
): string {
  return `[${rule}] ${subject}: ${detail}. Repair: ${repair}. ${ADR_0003_POINTER}`;
}

function manifestIssue(
  rule: CatalogRule,
  rel: string,
  detail: string,
  repair: string,
): ManifestSkillsResult {
  return { skills: null, issue: formatRuleIssue(rule, rel, detail, repair) };
}

function unwrapJsonObject(
  parsed: JsonReadResult,
  rel: string,
  kind: string,
  field: string,
): { readonly object: object | null; readonly issue: string | null } {
  if (!parsed.ok) {
    if (parsed.reason === "read") {
      return {
        object: null,
        issue: formatRuleIssue(
          "missing-manifest",
          rel,
          `missing or unreadable ${kind} manifest`,
          `ensure ${rel} is present and readable with a "${field}" array listing every promoted skill`,
        ),
      };
    }
    return {
      object: null,
      issue: formatRuleIssue(
        "invalid-manifest",
        rel,
        "invalid JSON",
        `fix the JSON syntax in ${rel}`,
      ),
    };
  }
  const manifest = asObjectMapping(parsed.value);
  if (manifest === null) {
    return {
      object: null,
      issue: formatRuleIssue(
        "invalid-manifest",
        rel,
        "expected JSON object",
        `write a JSON object with a "${field}" array in ${rel}`,
      ),
    };
  }
  return { object: manifest, issue: null };
}

function readStringArray(
  rawSkills: unknown,
  rel: string,
  field: string,
): ManifestSkillsResult {
  if (!Array.isArray(rawSkills)) {
    return manifestIssue(
      "invalid-manifest",
      rel,
      `"${field}" must be an array`,
      `set "${field}" to an array of skill paths in ${rel}`,
    );
  }
  const items: string[] = [];
  for (const item of rawSkills) {
    if (typeof item !== "string") {
      return manifestIssue(
        "invalid-manifest",
        rel,
        `every "${field}" entry must be a string`,
        `list each skill path as a string in ${rel}`,
      );
    }
    items.push(item);
  }
  return { skills: items, issue: null };
}

export function decodePluginManifestSkills(
  parsed: JsonReadResult,
  rel: string,
): ManifestSkillsResult {
  const loaded = unwrapJsonObject(parsed, rel, "plugin", "skills");
  if (loaded.object === null) return { skills: null, issue: loaded.issue };
  if (!Object.hasOwn(loaded.object, "skills")) {
    return manifestIssue(
      "invalid-manifest",
      rel,
      'missing "skills" array',
      `add a "skills" array listing every promoted skill to ${rel}`,
    );
  }
  return readStringArray(Reflect.get(loaded.object, "skills"), rel, "skills");
}

export function decodePiManifestSkills(
  parsed: JsonReadResult,
): ManifestSkillsResult {
  const rel = "package.json";
  const loaded = unwrapJsonObject(parsed, rel, "package", "pi.skills");
  if (loaded.object === null) return { skills: null, issue: loaded.issue };
  if (!Object.hasOwn(loaded.object, "pi")) {
    return manifestIssue(
      "missing-manifest",
      rel,
      'missing "pi" manifest',
      'add a "pi" object with a "skills" array listing every promoted skill to package.json',
    );
  }
  const rawPi = asObjectMapping(Reflect.get(loaded.object, "pi"));
  if (rawPi === null) {
    return manifestIssue(
      "invalid-manifest",
      rel,
      '"pi" must be a JSON object',
      'set "pi" to an object with a "skills" array in package.json',
    );
  }
  if (!Object.hasOwn(rawPi, "skills")) {
    return manifestIssue(
      "missing-manifest",
      rel,
      'missing "pi.skills" array',
      'add a "skills" array listing every promoted skill under "pi" in package.json',
    );
  }
  return readStringArray(Reflect.get(rawPi, "skills"), rel, "pi.skills");
}

export function validateSkillsList(
  rule: CatalogRule,
  rel: string,
  field: string,
  listedSkills: readonly string[],
  expectedPromoted: readonly string[],
): string[] {
  const issues: string[] = [];
  const actual = [...listedSkills].sort(compareCodeUnit);
  for (const expected of expectedPromoted) {
    if (!actual.includes(expected)) {
      issues.push(
        formatRuleIssue(
          rule,
          rel,
          `missing promoted skill "${expected}"`,
          `add "${expected}" to "${field}" in ${rel}`,
        ),
      );
    }
  }
  for (const listed of actual) {
    if (!expectedPromoted.includes(listed)) {
      issues.push(
        formatRuleIssue(
          rule,
          rel,
          `lists non-promoted or absent skill "${listed}"`,
          `remove "${listed}" from "${field}" in ${rel}`,
        ),
      );
    }
  }
  return issues;
}
