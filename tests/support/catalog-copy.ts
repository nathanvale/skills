import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSkills,
  repositoryRoot,
} from "../../src/skills-catalog/skills-catalog.ts";
import { testFolder } from "./test-folder.ts";

export function missingPromotedReadmeLinks(root: string): readonly string[] {
  const rootReadme = readFileSync(join(root, "README.md"), "utf8");
  const missing: string[] = [];
  for (const skill of discoverSkills().filter((item) => item.promoted)) {
    const rootLink = `./skills/${skill.bucket}/${skill.name}/SKILL.md`;
    if (!rootReadme.includes(rootLink)) {
      missing.push(`README.md missing ${rootLink}`);
    }
    const bucketReadme = readFileSync(
      join(root, "skills", skill.bucket, "README.md"),
      "utf8",
    );
    const bucketLink = `./${skill.name}/SKILL.md`;
    if (!bucketReadme.includes(bucketLink)) {
      missing.push(`skills/${skill.bucket}/README.md missing ${bucketLink}`);
    }
  }
  return missing;
}

export const plantedCodexPolicies: Readonly<Record<string, string>> = {
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

export function withCatalogCopy(
  prefix: string,
  run: (copy: string) => void,
): void {
  const copy = testFolder(prefix);
  cpSync(join(repositoryRoot(), "skills"), join(copy, "skills"), {
    recursive: true,
  });
  cpSync(
    join(repositoryRoot(), ".claude-plugin"),
    join(copy, ".claude-plugin"),
    { recursive: true },
  );
  cpSync(join(repositoryRoot(), "plugin.json"), join(copy, "plugin.json"));
  cpSync(join(repositoryRoot(), "package.json"), join(copy, "package.json"));
  try {
    run(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
