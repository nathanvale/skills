import { command, station } from "agent-cli-kernel";
import {
  cvTailorCauses,
  FILE_PATH_VALUE,
  noEffects,
  noInput,
  NON_EMPTY_TEXT_VALUE,
  stationWords,
  SUCCESS_UNCHANGED,
} from "../causes.ts";
import type { PathBoundary } from "../settings.ts";
import { evaluateCvCheck } from "./check-eval.ts";

export type CvCheckDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getBoundary: () => PathBoundary;
  readonly cwd: string;
};

export function createCvCheckCommand(deps: CvCheckDeps) {
  return command({
    identity: "cv-tailor.cv-check",
    route: ["cv", "check"],
    summary:
      "Compare extracted PDF and Word text against the Markdown CV source and optional required terms.",
    input: {
      ...noInput,
      options: [
        {
          name: "--pdf",
          aliases: [],
          summary: "Path to the built PDF file.",
          required: true,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--docx",
          aliases: [],
          summary: "Path to the built Word .docx file.",
          required: true,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--source",
          aliases: [],
          summary: "Path to the Markdown CV source file.",
          required: true,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--max-pages",
          aliases: [],
          summary: "Maximum allowed PDF page count (default 2).",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 1000 },
        },
        {
          name: "--term",
          aliases: [],
          summary: "Term required in both PDF and Word text (repeatable).",
          required: false,
          repeatable: true,
          value: NON_EMPTY_TEXT_VALUE,
        },
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-check",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "All parse and term checks passed.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.cv-check:passed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-check",
        causeCode: "DOMAIN_CV_TAILOR_CHECK_FAILED",
        trigger: "One or more parse or term checks failed.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Inspect data.checks for each FAIL item, repair the Markdown or rebuild with cv build, and re-run cv check.",
          },
        },
        repairAction:
          "Fix every FAIL check reported in data.checks and re-run cv check.",
        independentObservable: "cv-tailor.cv-check:failed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-check",
        causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
        trigger:
          "The Markdown source could not be read or used an unsupported heading level.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Use only #, ## and ### headings in a readable UTF-8 Markdown file.",
          },
        },
        repairAction: "Fix the Markdown source file and retry cv check.",
        independentObservable: "cv-tailor.cv-check:source-invalid",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-check",
        causeCode: "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
        trigger: "The .docx file could not be read or its XML was invalid.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass an existing, valid .docx file to --docx.",
          },
        },
        repairAction: "Verify the --docx file path is readable and valid.",
        independentObservable: "cv-tailor.cv-check:file-unreadable",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-check",
        causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
        trigger: "pdftotext or pdfinfo was not found on PATH.",
        guidance: {
          next: { kind: "command", command: "cv-tailor.doctor", args: [] },
        },
        repairAction:
          "Install Poppler so pdftotext and pdfinfo are on PATH, then run doctor.",
        independentObservable: "cv-tailor.cv-check:missing-poppler",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-check",
        causeCode: "DOMAIN_CV_TAILOR_PROGRAM_FAILED",
        trigger: "pdftotext or pdfinfo exited non-zero or timed out.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Verify the PDF file is readable by pdfinfo and pdftotext.",
          },
        },
        repairAction: "Verify the PDF file is valid and retry cv check.",
        independentObservable: "cv-tailor.cv-check:program-failed",
      }),
    ],
    run: async (input, context) => {
      const evaluated = await evaluateCvCheck({
        cwd: deps.cwd,
        env: deps.env,
        boundary: deps.getBoundary(),
        programs: context.programs,
        pdf: input["--pdf"],
        docx: input["--docx"],
        source: input["--source"],
        maxPages: input["--max-pages"] ?? 2,
        terms: input["--term"] ?? [],
      });
      if (!evaluated.ok) {
        return context.result(
          {
            commandIdentity: "cv-tailor.cv-check",
            causeCode: evaluated.causeCode,
          },
          {
            message: evaluated.message,
            data:
              evaluated.causeCode === "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING"
                ? {
                    missing: evaluated.missing ?? [],
                    detail: evaluated.message,
                  }
                : null,
            effects: noEffects,
          },
        );
      }
      const { report } = evaluated;
      if (report.failures > 0) {
        return context.result(
          {
            commandIdentity: "cv-tailor.cv-check",
            causeCode: "DOMAIN_CV_TAILOR_CHECK_FAILED",
          },
          {
            message: `FAIL: ${String(report.failures)} failing check(s), ${String(report.warnings)} warning(s).`,
            data: report,
            effects: noEffects,
          },
        );
      }
      return context.result(
        {
          commandIdentity: "cv-tailor.cv-check",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `PASS: 0 failing check(s), ${String(report.warnings)} warning(s).`,
          data: report,
          effects: noEffects,
        },
      );
    },
  });
}
