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
import { extractNormalisedFiles } from "../programs.ts";
import { hasTerm } from "../search/rules.ts";
import type { PathBoundary } from "../settings.ts";

export type TermReportDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getBoundary: () => PathBoundary;
  readonly cwd: string;
};

type FileTermVerdict = {
  readonly file: string;
  readonly found: readonly string[];
  readonly missing: readonly string[];
  readonly foundCount: number;
  readonly totalCount: number;
};

export function createTermReportCommand(deps: TermReportDeps) {
  return command({
    identity: "cv-tailor.term-report",
    route: ["term", "report"],
    summary:
      "Report each ad term as found or missing in each PDF, Word .docx, or text file.",
    input: {
      ...noInput,
      options: [
        {
          name: "--file",
          aliases: [],
          summary: "Target file to scan (repeatable).",
          required: true,
          repeatable: true,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--term",
          aliases: [],
          summary: "Ad term to look for (repeatable).",
          required: true,
          repeatable: true,
          value: NON_EMPTY_TEXT_VALUE,
        },
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.term-report",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "All files were scanned for every requested term.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.term-report:reported",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.term-report",
        causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
        trigger: "pdftotext was not found on PATH when scanning a PDF file.",
        guidance: {
          next: { kind: "command", command: "cv-tailor.doctor", args: [] },
        },
        repairAction:
          "Install Poppler so pdftotext is on PATH, then run doctor.",
        independentObservable: "cv-tailor.term-report:missing-pdftotext",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.term-report",
        causeCode: "DOMAIN_CV_TAILOR_PROGRAM_FAILED",
        trigger: "pdftotext failed while scanning a PDF file.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Verify each PDF file is readable by pdftotext.",
          },
        },
        repairAction: "Check the PDF file and retry term report.",
        independentObservable: "cv-tailor.term-report:pdftotext-failed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.term-report",
        causeCode: "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
        trigger: "A target file could not be read.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass existing, readable paths to --file.",
          },
        },
        repairAction: "Verify each --file path exists and is readable.",
        independentObservable: "cv-tailor.term-report:file-unreadable",
      }),
    ],
    run: async (input, context) => {
      const terms = input["--term"];
      const loaded = await extractNormalisedFiles({
        files: input["--file"],
        cwd: deps.cwd,
        programs: context.programs,
        env: deps.env,
        boundary: deps.getBoundary(),
      });
      if (!loaded.ok) {
        return context.result(
          {
            commandIdentity: "cv-tailor.term-report",
            causeCode: loaded.failure.causeCode,
          },
          {
            message: loaded.failure.message,
            data: loaded.failure.data,
            effects: noEffects,
          },
        );
      }
      const files: FileTermVerdict[] = loaded.entries.map(({ file, flat }) => {
        const found = terms.filter((term) => hasTerm(flat, term));
        const missing = terms.filter((term) => !hasTerm(flat, term));
        return {
          file,
          found,
          missing,
          foundCount: found.length,
          totalCount: terms.length,
        };
      });

      return context.result(
        {
          commandIdentity: "cv-tailor.term-report",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Reported ${String(terms.length)} term(s) across ${String(files.length)} file(s).`,
          data: { files },
          effects: noEffects,
        },
      );
    },
  });
}
