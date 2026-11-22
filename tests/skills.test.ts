import { expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildSkillClis,
  renderSkillCliBundle,
  SKILL_CLIS,
} from "../scripts/build-skill-clis.ts";
import { helloWorldContract } from "../src/skill-clis/hello-world.ts";
import {
  discoverSkills,
  repositoryRoot,
  validateSkillsRepository,
} from "../src/skills-catalog.ts";
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
              name: "hello-world",
              bucket: "engineering",
              promoted: true,
              portableCli: "skills/engineering/hello-world/dist/cli.mjs",
            },
            {
              name: "weekly-hardening",
              bucket: "engineering",
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
        data: { valid: true, skillCount: 2, promotedCount: 2, issues: [] },
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
    expect(JSON.parse(discovered.stdout.toString())).toMatchObject({
      contractVersion: "3.0.0",
      availablePaths: [
        "hello-world.command-discovery",
        "hello-world.discovery",
        "hello-world.dispatch",
        "hello-world.greet",
        "hello-world.help",
      ],
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

test("portable skill CLI bundles match fresh builds and repository catalogs stay valid", async () => {
  expect(helloWorldContract.cli).toBe("hello-world");
  expect(discoverSkills().length).toBe(2);
  expect(validateSkillsRepository().valid).toBe(true);

  const checked = await buildSkillClis({ check: true });
  expect(checked.length).toBe(SKILL_CLIS.length);
  for (const item of checked) {
    expect(item.upToDate).toBe(true);
    expect(item.bytes).toBeGreaterThan(0);
  }

  const firstSpec = SKILL_CLIS[0];
  expect(firstSpec).toBeDefined();
  if (firstSpec !== undefined) {
    const rendered = await renderSkillCliBundle(firstSpec);
    const committed = readFileSync(
      join(repositoryRoot(), firstSpec.outputFile),
      "utf8",
    );
    expect(committed).toBe(rendered);
  }
});
