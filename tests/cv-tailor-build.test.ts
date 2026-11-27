import { expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCvTailorRunner } from "./support/cv-tailor-run.ts";
import { testFolder } from "./support/test-folder.ts";

const fixtureDir = resolve(import.meta.dir, "fixtures", "cv-tailor");
const sofficeStub = resolve(
  import.meta.dir,
  "support",
  "cv-tailor-soffice-stub.sh",
);

function createRunner(scratch: string, cwd: string = fixtureDir) {
  return createCvTailorRunner({
    env: {
      ...process.env,
      CV_TAILOR_STATE_DIR: join(scratch, "state"),
      CV_TAILOR_SETTINGS_FILE: join(scratch, "settings.json"),
      CV_TAILOR_SOFFICE: sofficeStub,
    },
    cwd,
  });
}

test("cv build run twice into two scratch folders gives byte-identical docx files matching expected/cv.docx", async () => {
  const scratchA = testFolder("cv-tailor-build-a-");
  const scratchB = testFolder("cv-tailor-build-b-");
  try {
    const runA = createRunner(scratchA);
    const runB = createRunner(scratchB);
    const outA = join(scratchA, "out");
    const outB = join(scratchB, "out");

    const resA = await runA([
      "cv",
      "build",
      "cv.md",
      "--template",
      "template.docx",
      "--out",
      outA,
    ]);
    const resB = await runB([
      "cv",
      "build",
      "cv.md",
      "--template",
      "template.docx",
      "--out",
      outB,
    ]);

    expect(resA.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      data: {
        docx: join(outA, "cv.docx"),
        pdf: join(outA, "cv.pdf"),
        pages: 2,
      },
    });
    expect(resB.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      data: {
        docx: join(outB, "cv.docx"),
        pdf: join(outB, "cv.pdf"),
        pages: 2,
      },
    });

    const bytesA = readFileSync(join(outA, "cv.docx"));
    const bytesB = readFileSync(join(outB, "cv.docx"));
    const expectedBytes = readFileSync(join(fixtureDir, "expected", "cv.docx"));

    expect(Buffer.compare(bytesA, bytesB)).toBe(0);
    expect(Buffer.compare(bytesA, expectedBytes)).toBe(0);
  } finally {
    rmSync(scratchA, { recursive: true, force: true });
    rmSync(scratchB, { recursive: true, force: true });
  }
});

test("cv build refuses to overwrite the template and refuses headings deeper than ###", async () => {
  const scratch = testFolder("cv-tailor-build-refuse-");
  try {
    const copiedTemplate = join(scratch, "cv.docx");
    cpSync(join(fixtureDir, "template.docx"), copiedTemplate);
    const badMd = join(scratch, "bad.md");
    writeFileSync(badMd, "# Alex Example\n#### Too Deep\n", "utf8");

    const run = createRunner(scratch, scratch);
    const overwrite = await run([
      "cv",
      "build",
      join(fixtureDir, "cv.md"),
      "--template",
      copiedTemplate,
      "--out",
      scratch,
    ]);
    expect(overwrite.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE",
      transactionState: "unchanged",
    });

    const deepHeading = await run([
      "cv",
      "build",
      badMd,
      "--template",
      copiedTemplate,
      "--out",
      join(scratch, "out"),
    ]);
    expect(deepHeading.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
      transactionState: "unchanged",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
