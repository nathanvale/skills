import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import { extractDocxText } from "./docx/template.ts";
import { normalise } from "./search/rules.ts";
import { findExecutable } from "./settings.ts";
import type { PathBoundary } from "./settings.ts";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_SOFFICE_TIMEOUT_MS = 60_000;
export const DEFAULT_SHUTDOWN_MS = 2_000;
const PDF_OUTPUT_LIMIT_BYTES = 4_194_304;

export type ProgramResultOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly missing: boolean; readonly detail: string };

export type ExtractedFileOutcome =
  | {
      readonly ok: true;
      readonly format: "pdf" | "docx" | "text";
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly kind: "missing-program" | "program-failed" | "file-unreadable";
      readonly detail: string;
    };

async function runInspectTool(
  programs: ProgramsCapability,
  executable: ParsedPath,
  args: readonly string[],
  outputLimitBytes: number,
  label: string,
): Promise<ProgramResultOutcome> {
  const result = await programs.inspect({
    executable,
    args,
    timeoutMilliseconds: DEFAULT_TOOL_TIMEOUT_MS,
    outputLimitBytes,
    shutdownMilliseconds: DEFAULT_SHUTDOWN_MS,
  });
  const details = programDetails(result);
  if (
    result.exitCode !== 0 ||
    !result.terminationConfirmed ||
    details === undefined ||
    details.timedOut
  ) {
    const stderrText = result.stderr.trim();
    return {
      ok: false,
      missing: false,
      detail:
        stderrText.length > 0
          ? `${label} failed: ${stderrText}`
          : `${label} exited with code ${String(result.exitCode)}.`,
    };
  }
  return { ok: true, stdout: result.stdout };
}

export async function runPdfToText(options: {
  readonly programs: ProgramsCapability;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly boundary: PathBoundary;
  readonly pdfPath: string;
  readonly raw: boolean;
  readonly page?: number | undefined;
}): Promise<ProgramResultOutcome> {
  const exe = findExecutable(
    "pdftotext",
    null,
    options.env.PATH,
    options.boundary,
  );
  if (!exe.ok) {
    return { ok: false, missing: true, detail: `${exe.detail} ${exe.repair}` };
  }
  const args: string[] = [options.raw ? "-raw" : "-layout"];
  if (options.page !== undefined) {
    args.push("-f", String(options.page), "-l", String(options.page));
  }
  args.push(options.pdfPath, "-");
  return runInspectTool(
    options.programs,
    exe.path,
    args,
    PDF_OUTPUT_LIMIT_BYTES,
    "pdftotext",
  );
}

export async function readPdfPageCount(options: {
  readonly programs: ProgramsCapability;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly boundary: PathBoundary;
  readonly pdfPath: string;
}): Promise<
  | { readonly ok: true; readonly pages: number }
  | { readonly ok: false; readonly missing: boolean; readonly detail: string }
> {
  const exe = findExecutable(
    "pdfinfo",
    null,
    options.env.PATH,
    options.boundary,
  );
  if (!exe.ok) {
    return { ok: false, missing: true, detail: `${exe.detail} ${exe.repair}` };
  }
  const outcome = await runInspectTool(
    options.programs,
    exe.path,
    [options.pdfPath],
    262_144,
    "pdfinfo",
  );
  if (!outcome.ok) return outcome;
  const match = /^Pages:\s+(\d+)/m.exec(outcome.stdout);
  if (match === null) {
    return {
      ok: false,
      missing: false,
      detail: `pdfinfo did not report a Pages line for ${options.pdfPath}.`,
    };
  }
  return { ok: true, pages: Number.parseInt(match[1] ?? "0", 10) };
}

function readDocxFileText(
  absPath: string,
  displayPath: string,
): ExtractedFileOutcome {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(absPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "file-unreadable",
      detail: `Cannot read ${displayPath}: ${detail}`,
    };
  }
  const extracted = extractDocxText(bytes);
  if (!extracted.ok) {
    return {
      ok: false,
      kind: "file-unreadable",
      detail: `Cannot extract text from ${displayPath}: ${extracted.error}`,
    };
  }
  return { ok: true, format: "docx", text: extracted.text };
}

function readPlainTextFile(
  absPath: string,
  displayPath: string,
): ExtractedFileOutcome {
  try {
    return { ok: true, format: "text", text: readFileSync(absPath, "utf8") };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "file-unreadable",
      detail: `Cannot read ${displayPath}: ${detail}`,
    };
  }
}

export async function extractAnyFileText(options: {
  readonly filePath: string;
  readonly cwd: string;
  readonly raw: boolean;
  readonly page?: number | undefined;
  readonly programs: ProgramsCapability;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly boundary: PathBoundary;
}): Promise<ExtractedFileOutcome> {
  const absPath = resolve(options.cwd, options.filePath);
  const lower = absPath.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const pdfRes = await runPdfToText({
      programs: options.programs,
      env: options.env,
      boundary: options.boundary,
      pdfPath: absPath,
      raw: options.raw,
      page: options.page,
    });
    if (!pdfRes.ok) {
      return {
        ok: false,
        kind: pdfRes.missing ? "missing-program" : "program-failed",
        detail: pdfRes.detail,
      };
    }
    return { ok: true, format: "pdf", text: pdfRes.stdout };
  }
  if (lower.endsWith(".docx")) {
    return readDocxFileText(absPath, options.filePath);
  }
  return readPlainTextFile(absPath, options.filePath);
}

function mapExtractFailure(
  failure: Extract<ExtractedFileOutcome, { readonly ok: false }>,
): {
  readonly causeCode:
    | "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING"
    | "DOMAIN_CV_TAILOR_PROGRAM_FAILED"
    | "DOMAIN_CV_TAILOR_FILE_UNREADABLE";
  readonly message: string;
  readonly data: {
    readonly missing: readonly string[];
    readonly detail: string;
  } | null;
} {
  if (failure.kind === "missing-program") {
    return {
      causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
      message: failure.detail,
      data: { missing: ["pdftotext"], detail: failure.detail },
    };
  }
  return {
    causeCode:
      failure.kind === "program-failed"
        ? "DOMAIN_CV_TAILOR_PROGRAM_FAILED"
        : "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
    message: failure.detail,
    data: null,
  };
}

export async function extractNormalisedFiles(options: {
  readonly files: readonly string[];
  readonly cwd: string;
  readonly programs: ProgramsCapability;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly boundary: PathBoundary;
}): Promise<
  | {
      readonly ok: true;
      readonly entries: readonly {
        readonly file: string;
        readonly flat: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly failure: ReturnType<typeof mapExtractFailure>;
    }
> {
  const entries: { readonly file: string; readonly flat: string }[] = [];
  for (const file of options.files) {
    const extracted = await extractAnyFileText({
      filePath: file,
      cwd: options.cwd,
      raw: false,
      programs: options.programs,
      env: options.env,
      boundary: options.boundary,
    });
    if (!extracted.ok) {
      return { ok: false, failure: mapExtractFailure(extracted) };
    }
    entries.push({ file, flat: normalise(extracted.text) });
  }
  return { ok: true, entries };
}
