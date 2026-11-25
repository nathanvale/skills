import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const cli = join(import.meta.dir, "../src/cli.ts");

function runFloatingSkill(
  subcommand: "check" | "list",
  home: string,
  extraArgs: readonly string[] = [],
) {
  const ran = Bun.spawnSync(
    [
      process.execPath,
      "run",
      cli,
      "floating-skill",
      subcommand,
      "--home",
      home,
      ...extraArgs,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

function writeSkill(skillDir: string): string {
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: planted\ndescription: planted\n---\n");
  return skillFile;
}

function withHome(prefix: string, body: (home: string) => void): void {
  const home = testFolder(prefix);
  try {
    body(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expectJsonExit(
  ran: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  exitCode: number,
): unknown {
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
    exitCode,
    stderr: "",
  });
  return JSON.parse(ran.stdout);
}

function expectListedFindings(
  home: string,
  findings: readonly Record<string, unknown>[],
): void {
  expect(
    expectJsonExit(runFloatingSkill("list", home, ["--json"]), 0),
  ).toMatchObject({ result: { data: { findings } } });
}

test("floating-skill check and floating-skill list pass on an empty home and report the five checked folders", () => {
  withHome("floating-skill-empty-", (home) => {
    const expectedFolders = [
      join(home, ".claude/skills"),
      join(home, ".agents/skills"),
      join(home, ".codex/skills"),
      join(home, ".gemini/config/skills"),
      join(home, ".pi/agent/skills"),
    ];

    const parsed = expectJsonExit(
      runFloatingSkill("check", home, ["--json"]),
      0,
    );
    expect(parsed).toMatchObject({
      result: {
        commandIdentity: "skills.floating-skill.check",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: { home, checkedFolders: expectedFolders, findings: [] },
      },
    });

    const findingsParsed = expectJsonExit(
      runFloatingSkill("list", home, ["--json"]),
      0,
    );
    expect(findingsParsed).toMatchObject({
      result: {
        commandIdentity: "skills.floating-skill.list",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: { home, checkedFolders: expectedFolders, findings: [] },
      },
    });
  });
});

test("floating-skill check refuses when a skill is planted under .agents/skills and points next to floating-skill list", () => {
  withHome("floating-skill-planted-", (home) => {
    const planted = writeSkill(join(home, ".agents/skills/planted"));
    const parsed = expectJsonExit(
      runFloatingSkill("check", home, ["--json"]),
      3,
    );
    expect(parsed).toMatchObject({
      message: `[floating-skill] 1 floating skill(s) found: ${planted}; run \`skills floating-skill list\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
      result: {
        commandIdentity: "skills.floating-skill.check",
        causeCode: "DOMAIN_FLOATING_SKILLS",
        outcome: "refused",
        exitCode: 3,
        data: null,
        next: {
          kind: "command",
          command: "skills.floating-skill.list",
          args: [],
        },
      },
    });

    const plain = runFloatingSkill("check", home);
    expect(plain.exitCode).toBe(3);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("[floating-skill]");
    expect(plain.stderr).toContain(planted);
    expect(plain.stderr).toContain(
      "run `skills floating-skill list` for the full list",
    );
    expect(plain.stderr).toContain("[DOMAIN_FLOATING_SKILLS]");

    const findingsParsed = expectJsonExit(
      runFloatingSkill("list", home, ["--json"]),
      0,
    );
    expect(findingsParsed).toMatchObject({
      result: {
        commandIdentity: "skills.floating-skill.list",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: { home, findings: [{ path: planted, symlinkTarget: null }] },
      },
    });
  });
});

test("floating-skill check caps its refusal message to the first five paths while floating-skill list returns all of them", () => {
  withHome("floating-skill-many-", (home) => {
    const plantedPaths = [1, 2, 3, 4, 5, 6, 7].map((index) =>
      writeSkill(join(home, `.agents/skills/skill-${String(index)}`)),
    );

    const parsed = expectJsonExit(
      runFloatingSkill("check", home, ["--json"]),
      3,
    );
    const firstFive = plantedPaths.slice(0, 5).join(", ");
    expect(parsed).toMatchObject({
      message: `[floating-skill] 7 floating skill(s) found: ${firstFive}, and 2 more; run \`skills floating-skill list\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
      result: {
        commandIdentity: "skills.floating-skill.check",
        causeCode: "DOMAIN_FLOATING_SKILLS",
        outcome: "refused",
        exitCode: 3,
        data: null,
      },
    });

    const findingsParsed = expectJsonExit(
      runFloatingSkill("list", home, ["--json"]),
      0,
    );
    expect(findingsParsed).toMatchObject({
      result: {
        commandIdentity: "skills.floating-skill.list",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: {
          home,
          findings: plantedPaths.map((path) => ({ path, symlinkTarget: null })),
        },
      },
    });
  });
});

test("floating-skill check and floating-skill list report symlinked skill directories and symlinked SKILL.md files with their targets", () => {
  withHome("floating-skill-symlink-", (home) => {
    withHome("floating-skill-target-", (targetRoot) => {
      const dirTarget = join(targetRoot, "linked-dir-source");
      writeSkill(dirTarget);
      mkdirSync(join(home, ".agents/skills"), { recursive: true });
      symlinkSync(dirTarget, join(home, ".agents/skills/linked-dir"));

      const fileTarget = writeSkill(join(targetRoot, "linked-file-source"));
      const claudeSkillDir = join(home, ".claude/skills/linked-file");
      mkdirSync(claudeSkillDir, { recursive: true });
      symlinkSync(fileTarget, join(claudeSkillDir, "SKILL.md"));

      const expectedDirLink = join(home, ".agents/skills/linked-dir/SKILL.md");
      const expectedFileLink = join(claudeSkillDir, "SKILL.md");
      const parsed = expectJsonExit(
        runFloatingSkill("check", home, ["--json"]),
        3,
      );
      expect(parsed).toMatchObject({
        message: `[floating-skill] 2 floating skill(s) found: ${expectedFileLink} -> ${fileTarget}, ${expectedDirLink} -> ${dirTarget}; run \`skills floating-skill list\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
        result: {
          commandIdentity: "skills.floating-skill.check",
          causeCode: "DOMAIN_FLOATING_SKILLS",
          outcome: "refused",
          exitCode: 3,
          data: null,
        },
      });

      const findingsParsed = expectJsonExit(
        runFloatingSkill("list", home, ["--json"]),
        0,
      );
      expect(findingsParsed).toMatchObject({
        result: {
          commandIdentity: "skills.floating-skill.list",
          causeCode: "SUCCESS_UNCHANGED",
          outcome: "success",
          exitCode: 0,
          data: {
            home,
            findings: [
              { path: expectedFileLink, symlinkTarget: fileTarget },
              { path: expectedDirLink, symlinkTarget: dirTarget },
            ],
          },
        },
      });
    });
  });
});

test("floating-skill check ignores the three tool-owned app folders", () => {
  withHome("floating-skill-app-folders-", (home) => {
    writeSkill(join(home, ".codex/skills/.system"));
    writeSkill(join(home, ".claude/skills/.trash"));
    writeSkill(join(home, ".claude/skills/synced"));

    const parsed = expectJsonExit(
      runFloatingSkill("check", home, ["--json"]),
      0,
    );
    expect(parsed).toMatchObject({
      result: {
        commandIdentity: "skills.floating-skill.check",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: { home, findings: [] },
      },
    });
  });
});

test("floating-skill check and floating-skill list skip a symlink that loops to itself and still report the other floating skills", () => {
  withHome("floating-skill-loop-", (home) => {
    const folder = join(home, ".agents", "skills");
    mkdirSync(join(folder, "planted"), { recursive: true });
    writeFileSync(
      join(folder, "planted", "SKILL.md"),
      "---\nname: planted\ndescription: planted\n---\n",
    );
    symlinkSync("aaa-loop", join(folder, "aaa-loop"));

    expect(runFloatingSkill("check", home, ["--json"]).exitCode).toBe(3);

    const listed = runFloatingSkill("list", home, ["--json"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(join(folder, "planted", "SKILL.md"));
  });
});

test("floating-skill check refuses when a skill is planted under .pi/agent/skills and floating-skill list reports it", () => {
  withHome("floating-skill-pi-planted-", (home) => {
    const planted = writeSkill(join(home, ".pi/agent/skills/planted"));

    const checked = expectJsonExit(
      runFloatingSkill("check", home, ["--json"]),
      3,
    );
    expect(checked).toMatchObject({
      message: `[floating-skill] 1 floating skill(s) found: ${planted}; run \`skills floating-skill list\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
      result: {
        causeCode: "DOMAIN_FLOATING_SKILLS",
        outcome: "refused",
        exitCode: 3,
      },
    });

    expectListedFindings(home, [
      {
        folder: ".pi/agent/skills",
        name: "planted",
        path: planted,
        symlinkTarget: null,
      },
    ]);
  });
});

test("floating-skill check and floating-skill list report a symlinked skill folder under .pi/agent/skills", () => {
  withHome("floating-skill-pi-symlink-", (home) => {
    withHome("floating-skill-pi-target-", (targetRoot) => {
      const dirTarget = join(targetRoot, "linked-pi-source");
      writeSkill(dirTarget);
      mkdirSync(join(home, ".pi/agent/skills"), { recursive: true });
      symlinkSync(dirTarget, join(home, ".pi/agent/skills/linked-pi"));
      const expectedLink = join(home, ".pi/agent/skills/linked-pi/SKILL.md");

      const checked = expectJsonExit(
        runFloatingSkill("check", home, ["--json"]),
        3,
      );
      expect(checked).toMatchObject({
        message: `[floating-skill] 1 floating skill(s) found: ${expectedLink} -> ${dirTarget}; run \`skills floating-skill list\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
        result: { causeCode: "DOMAIN_FLOATING_SKILLS", exitCode: 3 },
      });

      expectListedFindings(home, [
        {
          folder: ".pi/agent/skills",
          name: "linked-pi",
          path: expectedLink,
          symlinkTarget: dirTarget,
        },
      ]);
    });
  });
});

test("floating-skill check and floating-skill list skip a dangling symlink under .pi/agent/skills without crashing", () => {
  withHome("floating-skill-pi-dangling-", (home) => {
    const piSkills = join(home, ".pi/agent/skills");
    mkdirSync(piSkills, { recursive: true });
    symlinkSync(join(home, "does-not-exist"), join(piSkills, "aaa-dangling"));
    const planted = writeSkill(join(piSkills, "planted"));

    expectJsonExit(runFloatingSkill("check", home, ["--json"]), 3);
    expectListedFindings(home, [
      {
        folder: ".pi/agent/skills",
        name: "planted",
        path: planted,
        symlinkTarget: null,
      },
    ]);
  });
});

test("floating-skill check and floating-skill list report nested skills under .pi/agent/skills and .agents/skills", () => {
  withHome("floating-skill-nested-", (home) => {
    const agentsNested = writeSkill(join(home, ".agents/skills/group/z"));
    const piNested = writeSkill(join(home, ".pi/agent/skills/x/y"));

    const checked = expectJsonExit(
      runFloatingSkill("check", home, ["--json"]),
      3,
    );
    expect(checked).toMatchObject({
      result: {
        causeCode: "DOMAIN_FLOATING_SKILLS",
        outcome: "refused",
        exitCode: 3,
      },
    });

    expectListedFindings(home, [
      {
        folder: ".agents/skills",
        name: "z",
        path: agentsNested,
        symlinkTarget: null,
      },
      {
        folder: ".pi/agent/skills",
        name: "y",
        path: piNested,
        symlinkTarget: null,
      },
    ]);
  });
});

test("floating-skill check ignores nested skills inside excluded tool-owned app folders", () => {
  withHome("floating-skill-excluded-nested-", (home) => {
    writeSkill(join(home, ".codex/skills/.system/nested"));
    writeSkill(join(home, ".claude/skills/.trash/nested"));
    writeSkill(join(home, ".claude/skills/synced/nested"));

    const checked = expectJsonExit(
      runFloatingSkill("check", home, ["--json"]),
      0,
    );
    expect(checked).toMatchObject({
      result: {
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: { home, findings: [] },
      },
    });
  });
});

test("floating-skill check and floating-skill list terminate on a symlink cycle under .pi/agent/skills", () => {
  withHome("floating-skill-pi-cycle-", (home) => {
    const cycleDir = join(home, ".pi/agent/skills/cycle-a");
    mkdirSync(cycleDir, { recursive: true });
    symlinkSync(cycleDir, join(cycleDir, "back-to-cycle-a"));
    const planted = writeSkill(join(home, ".pi/agent/skills/group/planted"));

    expectJsonExit(runFloatingSkill("check", home, ["--json"]), 3);
    expectListedFindings(home, [
      {
        folder: ".pi/agent/skills",
        name: "planted",
        path: planted,
        symlinkTarget: null,
      },
    ]);
  });
});

test("floating-skill check and floating-skill list do not report another SKILL.md inside a skill root subfolder", () => {
  withHome("floating-skill-no-double-", (home) => {
    const outer = writeSkill(join(home, ".pi/agent/skills/outer"));
    writeSkill(join(home, ".pi/agent/skills/outer/inner"));

    expectJsonExit(runFloatingSkill("check", home, ["--json"]), 3);
    expectListedFindings(home, [
      {
        folder: ".pi/agent/skills",
        name: "outer",
        path: outer,
        symlinkTarget: null,
      },
    ]);
  });
});
