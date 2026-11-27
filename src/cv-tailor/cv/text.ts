import { command, station } from "agent-cli-kernel";
import {
  cvTailorCauses,
  FILE_PATH_VALUE,
  noEffects,
  noInput,
  stationWords,
  SUCCESS_UNCHANGED,
} from "../causes.ts";
import { extractAnyFileText } from "../programs.ts";
import type { PathBoundary } from "../settings.ts";

export type CvTextDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getBoundary: () => PathBoundary;
  readonly cwd: string;
};

export function createCvTextCommand(deps: CvTextDeps) {
  return command({
    identity: "cv-tailor.cv-text",
    route: ["cv", "text"],
    summary:
      "Extract parser text from a PDF (layout or raw), a Word .docx file, or a UTF-8 text file.",
    input: {
      ...noInput,
      arguments: [
        {
          name: "file",
          summary: "Path to a PDF, Word .docx, or UTF-8 text file.",
          required: true,
          value: FILE_PATH_VALUE,
        },
      ],
      options: [
        {
          name: "--raw",
          aliases: [],
          summary: "Use pdftotext -raw instead of -layout for PDF files.",
          required: false,
          repeatable: false,
          value: null,
        },
        {
          name: "--page",
          aliases: [],
          summary: "Extract only a single 1-based page from a PDF file.",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 10_000 },
        },
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-text",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "Text was extracted from the target file.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.cv-text:extracted",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-text",
        causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
        trigger: "pdftotext was not found on PATH when reading a PDF file.",
        guidance: {
          next: { kind: "command", command: "cv-tailor.doctor", args: [] },
        },
        repairAction:
          "Install Poppler so pdftotext is on PATH, then run doctor.",
        independentObservable: "cv-tailor.cv-text:missing-pdftotext",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-text",
        causeCode: "DOMAIN_CV_TAILOR_PROGRAM_FAILED",
        trigger: "pdftotext exited with a non-zero status or timed out.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Check that the PDF file is valid and readable by pdftotext.",
          },
        },
        repairAction: "Verify the PDF file is readable and retry cv text.",
        independentObservable: "cv-tailor.cv-text:pdftotext-failed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-text",
        causeCode: "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
        trigger:
          "The target file could not be read or its .docx XML was invalid.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass an existing, readable PDF, .docx, or UTF-8 text file.",
          },
        },
        repairAction:
          "Verify the file path exists and is readable, then retry cv text.",
        independentObservable: "cv-tailor.cv-text:file-unreadable",
      }),
    ],
    run: async (input, context) => {
      const extracted = await extractAnyFileText({
        filePath: input.file,
        cwd: deps.cwd,
        raw: input["--raw"] === true,
        page: input["--page"],
        programs: context.programs,
        env: deps.env,
        boundary: deps.getBoundary(),
      });
      if (!extracted.ok) {
        if (extracted.kind === "missing-program") {
          return context.result(
            {
              commandIdentity: "cv-tailor.cv-text",
              causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
            },
            {
              message: extracted.detail,
              data: { missing: ["pdftotext"], detail: extracted.detail },
              effects: noEffects,
            },
          );
        }
        return context.result(
          {
            commandIdentity: "cv-tailor.cv-text",
            causeCode:
              extracted.kind === "program-failed"
                ? "DOMAIN_CV_TAILOR_PROGRAM_FAILED"
                : "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
          },
          {
            message: extracted.detail,
            data: null,
            effects: noEffects,
          },
        );
      }

      return context.result(
        {
          commandIdentity: "cv-tailor.cv-text",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Extracted ${String(extracted.text.length)} characters from ${input.file}.`,
          data: {
            file: input.file,
            format: extracted.format,
            text: extracted.text,
          },
          effects: noEffects,
        },
      );
    },
  });
}
