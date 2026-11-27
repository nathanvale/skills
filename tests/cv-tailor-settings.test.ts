import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createCvTailorRunner } from "./support/cv-tailor-run.ts";
import { testFolder } from "./support/test-folder.ts";

const fixtureDir = resolve(import.meta.dir, "fixtures", "cv-tailor");
const sofficeStub = resolve(
  import.meta.dir,
  "support",
  "cv-tailor-soffice-stub.sh",
);

test("settings show prefers env over file, ignores empty and relative values, and refuses symlinks or missing HOME", async () => {
  const scratch = testFolder("cv-tailor-settings-");
  try {
    const settingsFile = join(scratch, "settings.json");
    const fileBaseline = join(scratch, "from-file.docx");
    const fileFacts = join(scratch, "from-file-facts.md");
    const envBaseline = join(scratch, "from-env.docx");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        baselineCv: fileBaseline,
        factsFile: fileFacts,
        outputFolder: "relative/ignored",
        constraintsFile: "",
        jobHuntingFolder: join(scratch, "hunting"),
      }),
      "utf8",
    );

    const run = createCvTailorRunner({
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        CV_TAILOR_SETTINGS_FILE: settingsFile,
        CV_TAILOR_STATE_DIR: join(scratch, "state"),
        CV_TAILOR_BASELINE_CV: envBaseline,
        CV_TAILOR_FACTS_FILE: "relative/env-ignored.md",
        CV_TAILOR_JOB_HUNTING_DIR: "",
      },
      cwd: scratch,
    });
    const shown = await run(["settings", "show"]);
    expect(shown.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_UNCHANGED",
      data: {
        settingsFile,
        settingsFilePresent: true,
        settings: {
          baselineCv: { value: envBaseline, source: "env" },
          factsFile: { value: fileFacts, source: "file" },
          jobHuntingFolder: { value: join(scratch, "hunting"), source: "file" },
          outputFolder: { value: null, source: "unset" },
          constraintsFile: { value: null, source: "unset" },
          soffice: { value: null, source: "unset" },
        },
      },
    });

    const linkedSettings = join(scratch, "linked-settings.json");
    symlinkSync(settingsFile, linkedSettings);
    const linkedRun = createCvTailorRunner({
      env: {
        PATH: process.env.PATH,
        CV_TAILOR_SETTINGS_FILE: linkedSettings,
        CV_TAILOR_STATE_DIR: join(scratch, "state"),
      },
      cwd: scratch,
    });
    const linkedRes = await linkedRun(["settings", "show"]);
    expect(linkedRes.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_SETTINGS_INVALID",
    });

    const noHomeRun = createCvTailorRunner({
      env: { PATH: process.env.PATH },
      cwd: scratch,
    });
    const noHomeSettings = await noHomeRun(["settings", "show"]);
    expect(noHomeSettings.exitCode).toBe(3);
    expect(noHomeSettings.message).toContain("CV_TAILOR_SETTINGS_FILE");

    const noHomePending = await noHomeRun(["pending"]);
    expect(noHomePending.exitCode).toBe(3);
    expect(noHomePending.message).toContain("CV_TAILOR_STATE_DIR");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("cv build options beat env and file, resolve relative options against cwd, and refuse missing baselineCv", async () => {
  const scratch = testFolder("cv-tailor-settings-build-");
  try {
    const settingsFile = join(scratch, "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        baselineCv: join(scratch, "nonexistent-file-template.docx"),
        outputFolder: join(scratch, "file-out"),
      }),
      "utf8",
    );

    const run = createCvTailorRunner({
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        CV_TAILOR_SETTINGS_FILE: settingsFile,
        CV_TAILOR_STATE_DIR: join(scratch, "state"),
        CV_TAILOR_BASELINE_CV: join(scratch, "nonexistent-env-template.docx"),
        CV_TAILOR_OUTPUT_DIR: join(scratch, "env-out"),
        CV_TAILOR_SOFFICE: sofficeStub,
      },
      cwd: fixtureDir,
    });
    const relOut = join(scratch, "opt-out");
    const built = await run([
      "cv",
      "build",
      "cv.md",
      "--template",
      "template.docx",
      "--out",
      relOut,
    ]);
    expect(built.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      data: {
        docx: join(relOut, "cv.docx"),
        pdf: join(relOut, "cv.pdf"),
        pages: 2,
      },
    });

    const missingTemplateRun = createCvTailorRunner({
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        CV_TAILOR_SETTINGS_FILE: join(scratch, "absent.json"),
        CV_TAILOR_STATE_DIR: join(scratch, "state"),
        CV_TAILOR_SOFFICE: sofficeStub,
      },
      cwd: fixtureDir,
    });
    const missingRes = await missingTemplateRun(["cv", "build", "cv.md"]);
    expect(missingRes.exitCode).toBe(3);
    expect(missingRes.result.causeCode).toBe(
      "DOMAIN_CV_TAILOR_SETTINGS_MISSING",
    );
    expect(missingRes.message).toContain("baselineCv");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("doctor reports missing soffice with repair and succeeds when CV_TAILOR_SOFFICE is set", async () => {
  const scratch = testFolder("cv-tailor-doctor-");
  try {
    const controlledBin = join(scratch, "bin");
    mkdirSync(controlledBin, { recursive: true });
    for (const program of ["pdftotext", "pdfinfo"]) {
      const stubPath = join(controlledBin, program);
      writeFileSync(stubPath, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(stubPath, 0o755);
    }

    const missingRun = createCvTailorRunner({
      env: {
        PATH: controlledBin,
        CV_TAILOR_SETTINGS_FILE: join(scratch, "absent.json"),
        CV_TAILOR_STATE_DIR: join(scratch, "state"),
      },
      cwd: scratch,
    });
    const missingRes = await missingRun(["doctor"]);
    expect(missingRes.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
      data: { ready: false },
    });
    expect(missingRes.message).toContain("soffice");

    const readyRun = createCvTailorRunner({
      env: {
        PATH: controlledBin,
        CV_TAILOR_SETTINGS_FILE: join(scratch, "absent.json"),
        CV_TAILOR_STATE_DIR: join(scratch, "state"),
        CV_TAILOR_SOFFICE: sofficeStub,
      },
      cwd: scratch,
    });
    const readyRes = await readyRun(["doctor"]);
    expect(readyRes.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_UNCHANGED",
      data: { ready: true, missing: [] },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
