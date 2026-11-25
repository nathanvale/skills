import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const cli = join(import.meta.dir, "../src/cli.ts");

function runDoctor(home: string, extraArgs: readonly string[] = []) {
  const ran = Bun.spawnSync(
    [process.execPath, "run", cli, "doctor", "--home", home, ...extraArgs],
    { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

function runDoctorFindings(home: string, extraArgs: readonly string[] = []) {
  const ran = Bun.spawnSync(
    [
      process.execPath,
      "run",
      cli,
      "doctor",
      "findings",
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

test("doctor and doctor findings pass on an empty home and report the four checked folders", () => {
  const home = testFolder("skills-doctor-empty-");
  try {
    const expectedFolders = [
      join(home, ".claude/skills"),
      join(home, ".agents/skills"),
      join(home, ".codex/skills"),
      join(home, ".gemini/config/skills"),
    ];

    const ran = runDoctor(home, ["--json"]);
    expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const parsed: unknown = JSON.parse(ran.stdout);
    expect(parsed).toMatchObject({
      result: {
        commandIdentity: "skills.doctor",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: {
          home,
          checkedFolders: expectedFolders,
          findings: [],
        },
      },
    });

    const findingsRan = runDoctorFindings(home, ["--json"]);
    expect({
      exitCode: findingsRan.exitCode,
      stderr: findingsRan.stderr,
    }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const findingsParsed: unknown = JSON.parse(findingsRan.stdout);
    expect(findingsParsed).toMatchObject({
      result: {
        commandIdentity: "skills.doctor.findings",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: {
          home,
          checkedFolders: expectedFolders,
          findings: [],
        },
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor refuses when a skill is planted under .agents/skills and points next to doctor findings", () => {
  const home = testFolder("skills-doctor-planted-");
  try {
    const planted = writeSkill(join(home, ".agents/skills/planted"));
    const ran = runDoctor(home, ["--json"]);
    expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
      exitCode: 3,
      stderr: "",
    });
    const parsed: unknown = JSON.parse(ran.stdout);
    expect(parsed).toMatchObject({
      message: `[floating-skill] 1 floating skill(s) found: ${planted}; run \`skills doctor findings\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
      result: {
        commandIdentity: "skills.doctor",
        causeCode: "DOMAIN_FLOATING_SKILLS",
        outcome: "refused",
        exitCode: 3,
        data: null,
        next: {
          kind: "command",
          command: "skills.doctor.findings",
          args: [],
        },
      },
    });

    const plain = runDoctor(home);
    expect(plain.exitCode).toBe(3);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("[floating-skill]");
    expect(plain.stderr).toContain(planted);
    expect(plain.stderr).toContain(
      "run `skills doctor findings` for the full list",
    );
    expect(plain.stderr).toContain("[DOMAIN_FLOATING_SKILLS]");

    const findingsRan = runDoctorFindings(home, ["--json"]);
    expect({
      exitCode: findingsRan.exitCode,
      stderr: findingsRan.stderr,
    }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const findingsParsed: unknown = JSON.parse(findingsRan.stdout);
    expect(findingsParsed).toMatchObject({
      result: {
        commandIdentity: "skills.doctor.findings",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: {
          home,
          findings: [
            {
              path: planted,
              symlinkTarget: null,
            },
          ],
        },
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor caps its refusal message to the first five paths while doctor findings returns all of them", () => {
  const home = testFolder("skills-doctor-many-");
  try {
    const plantedPaths = [1, 2, 3, 4, 5, 6, 7].map((index) =>
      writeSkill(join(home, `.agents/skills/skill-${String(index)}`)),
    );

    const ran = runDoctor(home, ["--json"]);
    expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
      exitCode: 3,
      stderr: "",
    });
    const parsed: unknown = JSON.parse(ran.stdout);
    const firstFive = plantedPaths.slice(0, 5).join(", ");
    expect(parsed).toMatchObject({
      message: `[floating-skill] 7 floating skill(s) found: ${firstFive}, and 2 more; run \`skills doctor findings\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
      result: {
        commandIdentity: "skills.doctor",
        causeCode: "DOMAIN_FLOATING_SKILLS",
        outcome: "refused",
        exitCode: 3,
        data: null,
      },
    });

    const findingsRan = runDoctorFindings(home, ["--json"]);
    expect({
      exitCode: findingsRan.exitCode,
      stderr: findingsRan.stderr,
    }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const findingsParsed: unknown = JSON.parse(findingsRan.stdout);
    expect(findingsParsed).toMatchObject({
      result: {
        commandIdentity: "skills.doctor.findings",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: {
          home,
          findings: plantedPaths.map((path) => ({
            path,
            symlinkTarget: null,
          })),
        },
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor and doctor findings report symlinked skill directories and symlinked SKILL.md files with their targets", () => {
  const home = testFolder("skills-doctor-symlink-");
  const targetRoot = testFolder("skills-doctor-target-");
  try {
    const dirTarget = join(targetRoot, "linked-dir-source");
    writeSkill(dirTarget);
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    symlinkSync(dirTarget, join(home, ".agents/skills/linked-dir"));

    const fileTarget = writeSkill(join(targetRoot, "linked-file-source"));
    const claudeSkillDir = join(home, ".claude/skills/linked-file");
    mkdirSync(claudeSkillDir, { recursive: true });
    symlinkSync(fileTarget, join(claudeSkillDir, "SKILL.md"));

    const ran = runDoctor(home, ["--json"]);
    expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
      exitCode: 3,
      stderr: "",
    });
    const expectedDirLink = join(home, ".agents/skills/linked-dir/SKILL.md");
    const expectedFileLink = join(claudeSkillDir, "SKILL.md");
    const parsed: unknown = JSON.parse(ran.stdout);
    expect(parsed).toMatchObject({
      message: `[floating-skill] 2 floating skill(s) found: ${expectedFileLink} -> ${fileTarget}, ${expectedDirLink} -> ${dirTarget}; run \`skills doctor findings\` for the full list. Repair: move the skill into one of the plugins, or into the repository it serves, or uninstall it. See agent-engineering ADR 0003.`,
      result: {
        commandIdentity: "skills.doctor",
        causeCode: "DOMAIN_FLOATING_SKILLS",
        outcome: "refused",
        exitCode: 3,
        data: null,
      },
    });

    const findingsRan = runDoctorFindings(home, ["--json"]);
    expect({
      exitCode: findingsRan.exitCode,
      stderr: findingsRan.stderr,
    }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const findingsParsed: unknown = JSON.parse(findingsRan.stdout);
    expect(findingsParsed).toMatchObject({
      result: {
        commandIdentity: "skills.doctor.findings",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: {
          home,
          findings: [
            {
              path: expectedFileLink,
              symlinkTarget: fileTarget,
            },
            {
              path: expectedDirLink,
              symlinkTarget: dirTarget,
            },
          ],
        },
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("doctor ignores the three tool-owned app folders", () => {
  const home = testFolder("skills-doctor-app-folders-");
  try {
    writeSkill(join(home, ".codex/skills/.system"));
    writeSkill(join(home, ".claude/skills/.trash"));
    writeSkill(join(home, ".claude/skills/synced"));

    const ran = runDoctor(home, ["--json"]);
    expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const parsed: unknown = JSON.parse(ran.stdout);
    expect(parsed).toMatchObject({
      result: {
        commandIdentity: "skills.doctor",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        exitCode: 0,
        data: {
          home,
          findings: [],
        },
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
