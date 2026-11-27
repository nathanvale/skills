import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ParsedPath,
  ProgramsCapability,
  RecordedEffect,
} from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import { buildDocxFromTemplate } from "../docx/template.ts";
import { DEFAULT_SHUTDOWN_MS } from "../programs.ts";
import { findExecutable, loadSettings } from "../settings.ts";
import type { PathBoundary, StateDirResolution } from "../settings.ts";
import { parseCvMarkdown } from "./rules.ts";

export type BuildPreflightDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getBoundary: () => PathBoundary;
  readonly stateResolution: StateDirResolution;
  readonly cwd: string;
};

export type BuildPreflightFailure = {
  readonly ok: false;
  readonly causeCode:
    | "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE"
    | "DOMAIN_CV_TAILOR_SETTINGS_INVALID"
    | "DOMAIN_CV_TAILOR_SETTINGS_MISSING"
    | "DOMAIN_CV_TAILOR_SOURCE_INVALID"
    | "DOMAIN_CV_TAILOR_TEMPLATE_INVALID"
    | "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE"
    | "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING";
  readonly message: string;
  readonly missingPrograms?: readonly string[];
};

export type BuildPreflightReady = {
  readonly ok: true;
  readonly sourcePath: string;
  readonly outDir: string;
  readonly stem: string;
  readonly docxPath: string;
  readonly pdfPath: string;
  readonly docxBytes: Uint8Array;
  readonly sofficeExe: ParsedPath;
};

function sameTargetPath(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  if (!existsSync(left) || !existsSync(right)) return false;
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

function readAndBuildDocx(
  sourcePath: string,
  displaySource: string,
  templatePath: string,
): { readonly ok: true; readonly bytes: Uint8Array } | BuildPreflightFailure {
  let sourceText: string;
  try {
    sourceText = readFileSync(sourcePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
      message: `Cannot read Markdown source ${displaySource}: ${detail}`,
    };
  }
  const parsedMd = parseCvMarkdown(sourceText);
  if (!parsedMd.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
      message: `Invalid Markdown source ${displaySource}: ${parsedMd.error}`,
    };
  }
  let templateBytes: Uint8Array;
  try {
    templateBytes = readFileSync(templatePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_INVALID",
      message: `Cannot read template ${templatePath}: ${detail}`,
    };
  }
  const built = buildDocxFromTemplate(templateBytes, parsedMd.document);
  if (!built.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_INVALID",
      message: `Template error: ${built.error}`,
    };
  }
  return { ok: true, bytes: built.bytes };
}

function checkBuildPrograms(
  sofficeSetting: string | null,
  envPath: string | undefined,
  boundary: PathBoundary,
):
  | { readonly ok: true; readonly sofficeExe: ParsedPath }
  | BuildPreflightFailure {
  const soffice = findExecutable("soffice", sofficeSetting, envPath, boundary);
  const pdfinfo = findExecutable("pdfinfo", null, envPath, boundary);
  const missing: string[] = [];
  const details: string[] = [];
  if (!soffice.ok) {
    missing.push("soffice");
    details.push(`${soffice.detail} ${soffice.repair}`);
  }
  if (!pdfinfo.ok) {
    missing.push("pdfinfo");
    details.push(`${pdfinfo.detail} ${pdfinfo.repair}`);
  }
  if (missing.length > 0 || !soffice.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
      message: details.join(" "),
      missingPrograms: missing,
    };
  }
  return { ok: true, sofficeExe: soffice.path };
}

export function runBuildPreflight(
  deps: BuildPreflightDeps,
  input: {
    readonly source: string;
    readonly "--template"?: string | undefined;
    readonly "--out"?: string | undefined;
  },
): BuildPreflightReady | BuildPreflightFailure {
  if (!deps.stateResolution.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
      message: deps.stateResolution.detail,
    };
  }
  const settingsRes = loadSettings(
    deps.env,
    { baselineCv: input["--template"], outputFolder: input["--out"] },
    deps.cwd,
  );
  if (!settingsRes.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_SETTINGS_INVALID",
      message: settingsRes.detail,
    };
  }
  const templatePath = settingsRes.values.baselineCv.value;
  if (templatePath === null) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_SETTINGS_MISSING",
      message:
        "Missing baselineCv template. Set it with --template, CV_TAILOR_BASELINE_CV, or baselineCv in settings.json.",
    };
  }
  const sourcePath = resolve(deps.cwd, input.source);
  const outDir = settingsRes.values.outputFolder.value ?? dirname(sourcePath);
  const stem = basename(sourcePath, ".md");
  const docxPath = join(outDir, `${stem}.docx`);
  const pdfPath = join(outDir, `${stem}.pdf`);

  if (sameTargetPath(docxPath, templatePath)) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE",
      message: `Output ${docxPath} would overwrite the template ${templatePath}. Pass a different --out folder or rename the Markdown file.`,
    };
  }
  const docxRes = readAndBuildDocx(sourcePath, input.source, templatePath);
  if (!docxRes.ok) return docxRes;

  const programsRes = checkBuildPrograms(
    settingsRes.values.soffice.value,
    deps.env.PATH,
    deps.getBoundary(),
  );
  if (!programsRes.ok) return programsRes;

  return {
    ok: true,
    sourcePath,
    outDir,
    stem,
    docxPath,
    pdfPath,
    docxBytes: docxRes.bytes,
    sofficeExe: programsRes.sofficeExe,
  };
}

export function executeBuildWork(
  preflight: BuildPreflightReady,
  sofficeTimeout: number,
  programs: ProgramsCapability,
  signal: AbortSignal,
): {
  readonly work: (transaction: {
    readonly record: <T>(
      effect: "cv.docx.write" | "cv.pdf.convert",
      operation: (
        recorded: RecordedEffect<"cv.docx.write" | "cv.pdf.convert">,
      ) => Promise<T>,
      readBack: (value: T) => Promise<boolean>,
    ) => Promise<T>;
  }) => Promise<void>;
  readonly getSofficeOutcome: () => {
    readonly exitCode: number | null;
    readonly stderr: string;
  };
} {
  let sofficeExitCode: number | null = null;
  let sofficeStderr = "";
  const work = async (transaction: {
    readonly record: <T>(
      effect: "cv.docx.write" | "cv.pdf.convert",
      operation: (
        recorded: RecordedEffect<"cv.docx.write" | "cv.pdf.convert">,
      ) => Promise<T>,
      readBack: (value: T) => Promise<boolean>,
    ) => Promise<T>;
  }): Promise<void> => {
    let docxConfirmed = false;
    await transaction.record(
      "cv.docx.write",
      () => {
        mkdirSync(preflight.outDir, { recursive: true });
        writeFileSync(preflight.docxPath, preflight.docxBytes);
        return Promise.resolve();
      },
      () => {
        const actual = readFileSync(preflight.docxPath);
        docxConfirmed = Buffer.compare(actual, preflight.docxBytes) === 0;
        return Promise.resolve(docxConfirmed);
      },
    );
    if (!docxConfirmed) return;

    const profileDir = mkdtempSync(join(tmpdir(), "cv-soffice-"));
    try {
      if (existsSync(preflight.pdfPath)) {
        rmSync(preflight.pdfPath, { force: true });
      }
      const launched = await transaction.record(
        "cv.pdf.convert",
        (recorded) =>
          programs.domain(recorded).start({
            executable: preflight.sofficeExe,
            args: [
              `-env:UserInstallation=file://${profileDir}`,
              "--headless",
              "--convert-to",
              "pdf",
              "--outdir",
              preflight.outDir,
              preflight.docxPath,
            ],
            timeoutMilliseconds: sofficeTimeout,
            outputLimitBytes: 262_144,
            shutdownMilliseconds: DEFAULT_SHUTDOWN_MS,
          }),
        (result) => {
          const details = programDetails(result);
          return Promise.resolve(
            !signal.aborted &&
              result.exitCode !== null &&
              result.terminationConfirmed &&
              details !== undefined &&
              !details.timedOut,
          );
        },
      );
      sofficeExitCode = launched.exitCode;
      sofficeStderr = launched.stderr.trim();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  };
  return {
    work,
    getSofficeOutcome: () => ({
      exitCode: sofficeExitCode,
      stderr: sofficeStderr,
    }),
  };
}
