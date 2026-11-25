import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const skillFolder = join(root, ".agents", "skills");
const fullSkillLine = /^Full skill: `([^`\n]+)`$/m;
const installedKernelFolder = "node_modules/agent-cli-kernel";
const installedKernel = `${installedKernelFolder}/`;
const pinnedCommitLine = /^Pinned commit: `([^`\n]*)`$/m;

type PointerSkill = {
  readonly name: string;
  readonly fullSkill: string;
  readonly pinnedCommit: string;
};

type ClassifiedSkill =
  | { readonly kind: "pointer"; readonly skill: PointerSkill }
  | { readonly kind: "repo-local"; readonly name: string };

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return found;
}

function pinnedCommit(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const pin = ownValue(ownValue(manifest, "dependencies"), "agent-cli-kernel");
  const commit =
    typeof pin === "string" ? /#([0-9a-f]{40})$/.exec(pin)?.[1] : undefined;
  if (commit === undefined)
    throw new Error(
      `package.json pins no full kernel commit: its agent-cli-kernel dependency is ${JSON.stringify(pin)}. Repair: write the dependency as github:nathanvale/agent-cli-kernel#<full 40-character commit>.`,
    );
  return commit;
}

function classifyAgentSkill(name: string, text: string): ClassifiedSkill {
  const fullSkill = fullSkillLine.exec(text)?.[1];
  const pinnedCommit = pinnedCommitLine.exec(text)?.[1];
  if (fullSkill === undefined && pinnedCommit === undefined) {
    return { kind: "repo-local", name };
  }
  return {
    kind: "pointer",
    skill: {
      name,
      fullSkill: fullSkill ?? "no Full skill",
      pinnedCommit: pinnedCommit ?? "no Pinned commit",
    },
  };
}

function classifiedAgentSkills(): ClassifiedSkill[] {
  const names = existsSync(skillFolder) ? readdirSync(skillFolder).sort() : [];
  return names.map((name) =>
    classifyAgentSkill(
      name,
      readFileSync(join(skillFolder, name, "SKILL.md"), "utf8"),
    ),
  );
}

function pointerSkills(): PointerSkill[] {
  return classifiedAgentSkills().flatMap((entry) =>
    entry.kind === "pointer" ? [entry.skill] : [],
  );
}

function repoLocalSkills(): string[] {
  return classifiedAgentSkills().flatMap((entry) =>
    entry.kind === "repo-local" ? [entry.name] : [],
  );
}

test("repository-local skills without kernel pointer lines live alongside pointer skills", () => {
  expect(repoLocalSkills()).toContain("verify-delivery-slice");
  expect(pointerSkills().map(({ name }) => name)).not.toContain(
    "verify-delivery-slice",
  );
  expect(
    classifyAgentSkill(
      "local-probe",
      "---\nname: local-probe\ndescription: Local skill\n---\n\n# Local\n",
    ),
  ).toEqual({ kind: "repo-local", name: "local-probe" });
  expect(
    classifyAgentSkill(
      "partial-pointer",
      "Pinned commit: `0123456789abcdef0123456789abcdef01234567`\n",
    ),
  ).toEqual({
    kind: "pointer",
    skill: {
      name: "partial-pointer",
      fullSkill: "no Full skill",
      pinnedCommit: "0123456789abcdef0123456789abcdef01234567",
    },
  });
});

test("the repository has a pointer skill", () => {
  expect(
    pointerSkills().length === 0
      ? [
          `No skill in .agents/skills names a Full skill. Repair: restore the pointer skills Bootstrap wrote, each with its Full skill and Pinned commit lines.`,
        ]
      : [],
  ).toEqual([]);
});

test("each pointer skill names the commit package.json pins", () => {
  const commit = pinnedCommit();
  expect(
    pointerSkills()
      .filter((skill) => skill.pinnedCommit !== commit)
      .map(
        ({ name, pinnedCommit }) =>
          `.agents/skills/${name}/SKILL.md names ${pinnedCommit}, and package.json pins ${commit}. Repair: write ${commit} on its Pinned commit line, then read the full skill at that commit for any change.`,
      ),
  ).toEqual([]);
});

function lockedKernel() {
  const lock = readFileSync(join(root, "bun.lock"), "utf8");
  return {
    declared:
      /"agent-cli-kernel": "[^"\n]*#([0-9a-f]{40})"/.exec(lock)?.[1] ??
      "no full kernel commit",
    resolved:
      /"agent-cli-kernel": \["agent-cli-kernel@[^"\n]*#([0-9a-f]{7,40})"/.exec(
        lock,
      )?.[1],
  };
}

function installedTag(): string | undefined {
  const tag = join(root, installedKernelFolder, ".bun-tag");
  return existsSync(tag) ? readFileSync(tag, "utf8").trim() : undefined;
}

test("bun.lock and the installed kernel hold the commit package.json pins", () => {
  const commit = pinnedCommit();
  const locked = lockedKernel();
  const installed = installedTag();
  const installedCommit = /([0-9a-f]{7,40})$/.exec(installed ?? "")?.[1];
  expect([
    ...(locked.declared === commit
      ? []
      : [
          `bun.lock pins ${locked.declared}, and package.json pins ${commit}. Repair: run bun install after the pin changes in package.json, commit bun.lock with it, then run bun install --frozen-lockfile.`,
        ]),
    ...(locked.resolved !== undefined && commit.startsWith(locked.resolved)
      ? []
      : [
          `bun.lock resolves the kernel to ${locked.resolved ?? "no record"}, and package.json pins ${commit}. Repair: run bun update agent-cli-kernel, commit bun.lock, then run bun install --frozen-lockfile.`,
        ]),
    ...(installedCommit !== undefined && commit.startsWith(installedCommit)
      ? []
      : [
          `the installed kernel is ${installed ?? "not there"}, and package.json pins ${commit}. Repair: run bun install --frozen-lockfile.`,
        ]),
  ]).toEqual([]);
});

test("each pointer skill names a full skill inside the installed kernel", () => {
  expect(
    pointerSkills()
      .filter(
        ({ fullSkill }) =>
          !fullSkill.startsWith(installedKernel) ||
          fullSkill.split("/").includes(".."),
      )
      .map(
        ({ name, fullSkill }) =>
          `.agents/skills/${name}/SKILL.md names ${fullSkill}, which is not inside the installed kernel, ${installedKernel}. Repair: write the path of the skill the installed kernel ships, as ${installedKernel}skills/<name>/SKILL.md, on its Full skill line.`,
      ),
  ).toEqual([]);
});

test("the installed kernel holds the full skill each pointer skill names", () => {
  const commit = pinnedCommit();
  expect(
    pointerSkills()
      .filter(
        ({ fullSkill }) =>
          !existsSync(join(root, fullSkill)) ||
          !lstatSync(join(root, fullSkill)).isFile(),
      )
      .map(
        ({ name, fullSkill }) =>
          `.agents/skills/${name}/SKILL.md names ${fullSkill}, which the installed kernel at ${commit} does not hold. Repair: run bun install --frozen-lockfile; if it is still missing, find where the kernel at ${commit} keeps the skill and write that path on its Full skill line.`,
      ),
  ).toEqual([]);
});
