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
import type { PathBoundary } from "../settings.ts";
import { evaluateQuery, parseQuery } from "./rules.ts";
import type { ParsedQuery } from "./rules.ts";

export type SearchRunDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getBoundary: () => PathBoundary;
  readonly cwd: string;
};

type QueryVerdict = {
  readonly query: string;
  readonly verdict: "HIT" | "MISS";
  readonly absent: readonly string[];
  readonly excludedPresent: readonly string[];
};

type FileSearchResult = {
  readonly file: string;
  readonly results: readonly QueryVerdict[];
};

export function createSearchRunCommand(deps: SearchRunDeps) {
  return command({
    identity: "cv-tailor.search-run",
    route: ["search", "run"],
    summary:
      "Run recruiter Boolean searches (AND, OR, NOT, quotes, prefix *) across one or more files.",
    input: {
      ...noInput,
      options: [
        {
          name: "--file",
          aliases: [],
          summary: "Target file to search (repeatable).",
          required: true,
          repeatable: true,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--query",
          aliases: [],
          summary: "Recruiter Boolean search query (repeatable).",
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
        commandIdentity: "cv-tailor.search-run",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "All Boolean queries were evaluated on every file.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.search-run:evaluated",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.search-run",
        causeCode: "DOMAIN_CV_TAILOR_QUERY_INVALID",
        trigger: "A Boolean query had a syntax error.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix the Boolean query syntax (balanced parentheses and valid AND/OR/NOT terms) and retry.",
          },
        },
        repairAction: "Correct the invalid --query expression and retry.",
        independentObservable: "cv-tailor.search-run:query-invalid",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.search-run",
        causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
        trigger: "pdftotext was not found on PATH when searching a PDF file.",
        guidance: {
          next: { kind: "command", command: "cv-tailor.doctor", args: [] },
        },
        repairAction:
          "Install Poppler so pdftotext is on PATH, then run doctor.",
        independentObservable: "cv-tailor.search-run:missing-pdftotext",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.search-run",
        causeCode: "DOMAIN_CV_TAILOR_PROGRAM_FAILED",
        trigger: "pdftotext failed while searching a PDF file.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Verify each PDF file is readable by pdftotext.",
          },
        },
        repairAction: "Check the PDF file and retry search run.",
        independentObservable: "cv-tailor.search-run:pdftotext-failed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.search-run",
        causeCode: "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
        trigger: "A target file could not be read.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass existing, readable paths to --file.",
          },
        },
        repairAction: "Verify each --file path exists and is readable.",
        independentObservable: "cv-tailor.search-run:file-unreadable",
      }),
    ],
    run: async (input, context) => {
      const parsedQueries: ParsedQuery[] = [];
      for (const raw of input["--query"]) {
        const parsed = parseQuery(raw);
        if (!parsed.ok) {
          return context.result(
            {
              commandIdentity: "cv-tailor.search-run",
              causeCode: "DOMAIN_CV_TAILOR_QUERY_INVALID",
            },
            {
              message: parsed.error,
              data: null,
              effects: noEffects,
            },
          );
        }
        parsedQueries.push(parsed.query);
      }

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
            commandIdentity: "cv-tailor.search-run",
            causeCode: loaded.failure.causeCode,
          },
          {
            message: loaded.failure.message,
            data: loaded.failure.data,
            effects: noEffects,
          },
        );
      }

      const files: FileSearchResult[] = loaded.entries.map(({ file, flat }) => {
        const results: QueryVerdict[] = parsedQueries.map((query) => {
          const evaluated = evaluateQuery(query, flat);
          return {
            query: query.raw,
            verdict: evaluated.hit ? "HIT" : "MISS",
            absent: evaluated.absent,
            excludedPresent: evaluated.excludedPresent,
          };
        });
        return { file, results };
      });

      return context.result(
        {
          commandIdentity: "cv-tailor.search-run",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Ran ${String(parsedQueries.length)} query/queries across ${String(files.length)} file(s).`,
          data: { files },
          effects: noEffects,
        },
      );
    },
  });
}
