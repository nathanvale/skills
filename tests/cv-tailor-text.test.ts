import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalise } from "../src/cv-tailor/search/rules.ts";
import { createCvTailorRunner } from "./support/cv-tailor-run.ts";
import { testFolder } from "./support/test-folder.ts";

const fixtureDir = resolve(import.meta.dir, "fixtures", "cv-tailor");

function createRunner(scratch: string) {
  return createCvTailorRunner({
    env: {
      ...process.env,
      CV_TAILOR_STATE_DIR: join(scratch, "state"),
      CV_TAILOR_SETTINGS_FILE: join(scratch, "settings.json"),
    },
    cwd: fixtureDir,
  });
}

function readStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : "";
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

test("cv text word output is byte-identical to golden and PDF layout/raw match word for word after normalising", async () => {
  const scratch = testFolder("cv-tailor-text-");
  try {
    const run = createRunner(scratch);

    const wordRes = await run(["cv", "text", "expected/cv.docx"]);
    expect(wordRes.exitCode).toBe(0);
    const expectedWord = readFileSync(
      join(fixtureDir, "expected", "word-text.txt"),
      "utf8",
    );
    expect(wordRes.result.data).toEqual({
      file: "expected/cv.docx",
      format: "docx",
      text: expectedWord,
    });

    const pdfLayoutRes = await run(["cv", "text", "new.pdf"]);
    expect(pdfLayoutRes.exitCode).toBe(0);
    const expectedLayout = readFileSync(
      join(fixtureDir, "expected", "pdf-layout.txt"),
      "utf8",
    );
    expect(normalise(readStringField(pdfLayoutRes.result.data, "text"))).toBe(
      normalise(expectedLayout),
    );

    const pdfRawRes = await run(["cv", "text", "new.pdf", "--raw"]);
    expect(pdfRawRes.exitCode).toBe(0);
    const expectedRaw = readFileSync(
      join(fixtureDir, "expected", "pdf-raw.txt"),
      "utf8",
    );
    expect(normalise(readStringField(pdfRawRes.result.data, "text"))).toBe(
      normalise(expectedRaw),
    );

    const page1Res = await run(["cv", "text", "new.pdf", "--page", "1"]);
    expect(page1Res.exitCode).toBe(0);
    const page1Text = readStringField(page1Res.result.data, "text");
    expect(page1Text).toContain("Alex Example");
    expect(page1Text).not.toContain("Southern Cross Institute");

    const mdRes = await run(["cv", "text", "job-ad.md"]);
    expect(mdRes.exitCode).toBe(0);
    expect(mdRes.result.data).toMatchObject({
      file: "job-ad.md",
      format: "text",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("term report, search run, and cv check verdicts equal expected JSON", async () => {
  const scratch = testFolder("cv-tailor-verdicts-");
  try {
    const run = createRunner(scratch);
    const expected: unknown = JSON.parse(
      readFileSync(join(fixtureDir, "expected", "verdicts.json"), "utf8"),
    );

    const termsRes = await run([
      "term",
      "report",
      "--file",
      "new.pdf",
      "--file",
      "expected/cv.docx",
      "--term",
      "TypeScript",
      "--term",
      "PostgreSQL",
      "--term",
      "Terraform",
      "--term",
      "Kubernetes",
      "--term",
      "GraphQL",
      "--term",
      "OpenTelemetry",
    ]);
    expect(termsRes.exitCode).toBe(0);
    const actualTerms: unknown = termsRes.result.data;
    expect(actualTerms).toEqual({
      files: readField(readField(expected, "terms"), "files"),
    });

    const searchRes = await run([
      "search",
      "run",
      "--file",
      "new.pdf",
      "--file",
      "expected/cv.docx",
      "--query",
      "TypeScript AND PostgreSQL AND Terraform",
      "--query",
      '"event-driven" AND mentor* AND NOT Java',
      "--query",
      "TypeScript AND Kubernetes",
    ]);
    expect(searchRes.exitCode).toBe(0);
    const actualSearch: unknown = searchRes.result.data;
    expect(actualSearch).toEqual({
      files: readField(readField(expected, "search"), "files"),
    });

    const checkRes = await run([
      "cv",
      "check",
      "--pdf",
      "new.pdf",
      "--docx",
      "expected/cv.docx",
      "--source",
      "cv.md",
      "--term",
      "TypeScript",
      "--term",
      "PostgreSQL",
      "--term",
      "Terraform",
      "--term",
      "OpenTelemetry",
    ]);
    expect(checkRes.exitCode).toBe(0);
    expect(checkRes.result.causeCode).toBe("SUCCESS_UNCHANGED");
    const actualCheck: unknown = checkRes.result.data;
    expect(actualCheck).toEqual(readField(expected, "check"));

    const failTermRes = await run([
      "cv",
      "check",
      "--pdf",
      "new.pdf",
      "--docx",
      "expected/cv.docx",
      "--source",
      "cv.md",
      "--term",
      "Kubernetes",
    ]);
    expect(failTermRes.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_CHECK_FAILED",
      data: {
        verdict: "FAIL",
        failures: 2,
      },
    });

    const dashMd = join(scratch, "dash.md");
    writeFileSync(
      dashMd,
      readFileSync(join(fixtureDir, "cv.md"), "utf8").replace(
        "to present",
        "\u2014 present",
      ),
      "utf8",
    );
    const dashRes = await run([
      "cv",
      "check",
      "--pdf",
      "new.pdf",
      "--docx",
      "expected/cv.docx",
      "--source",
      dashMd,
    ]);
    expect(dashRes.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_CHECK_FAILED",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
