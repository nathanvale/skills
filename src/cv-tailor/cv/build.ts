import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { changing, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import {
  cvTailorCauses,
  FILE_PATH_VALUE,
  noEffects,
  noInput,
  stationWords,
  SUCCESS_COMPLETED,
} from "../causes.ts";
import { DEFAULT_SOFFICE_TIMEOUT_MS, readPdfPageCount } from "../programs.ts";
import { scopeKeyForPath } from "../settings.ts";
import type { PathBoundary, StateDirResolution } from "../settings.ts";
import { executeBuildWork, runBuildPreflight } from "./build-preflight.ts";

export type CvBuildDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getBoundary: () => PathBoundary;
  readonly stateResolution: StateDirResolution;
  readonly state: ReturnType<typeof stateAddon>;
  readonly cwd: string;
  readonly sofficeTimeoutMilliseconds?: number | undefined;
};

function buildHandoff(reason: string) {
  return {
    handoff: {
      owner: "human" as const,
      reason,
      inspect: [
        {
          kind: "command" as const,
          command: "cv-tailor.pending" as const,
          args: [] as const,
        },
      ],
    },
  } as const;
}

function mapTransactionRefusal(
  outcome:
    | { readonly kind: "held-lock"; readonly operationId: string }
    | { readonly kind: "unresolved-case"; readonly operationId: string }
    | { readonly kind: string },
  stem: string,
): {
  readonly causeCode:
    | "DOMAIN_CV_TAILOR_BUILD_HELD"
    | "DOMAIN_CV_TAILOR_BUILD_UNRESOLVED"
    | "DOMAIN_CV_TAILOR_BUILD_UNAVAILABLE";
  readonly message: string;
} {
  if (outcome.kind === "held-lock" && "operationId" in outcome) {
    return {
      causeCode: "DOMAIN_CV_TAILOR_BUILD_HELD",
      message: `Another cv build (${outcome.operationId}) holds a lock on ${stem}.`,
    };
  }
  if (outcome.kind === "unresolved-case" && "operationId" in outcome) {
    return {
      causeCode: "DOMAIN_CV_TAILOR_BUILD_UNRESOLVED",
      message: `Unfinished cv build (${outcome.operationId}) blocks ${stem}.`,
    };
  }
  return {
    causeCode: "DOMAIN_CV_TAILOR_BUILD_UNAVAILABLE",
    message: "State store could not start the cv build transaction.",
  };
}

async function verifyBuiltPdf(options: {
  readonly pdfPath: string;
  readonly sofficeExitCode: number | null;
  readonly sofficeStderr: string;
  readonly programs: import("agent-cli-kernel").ProgramsCapability;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly boundary: PathBoundary;
}): Promise<
  | { readonly ok: true; readonly pages: number }
  | { readonly ok: false; readonly message: string }
> {
  const pdfExists =
    existsSync(options.pdfPath) && statSync(options.pdfPath).size > 0;
  if (options.sofficeExitCode !== 0 || !pdfExists) {
    return {
      ok: false,
      message:
        options.sofficeStderr.length > 0
          ? `soffice failed (exit ${String(options.sofficeExitCode)}): ${options.sofficeStderr}`
          : `soffice did not produce ${options.pdfPath} (exit ${String(options.sofficeExitCode)}).`,
    };
  }
  const pagesRes = await readPdfPageCount({
    programs: options.programs,
    env: options.env,
    boundary: options.boundary,
    pdfPath: options.pdfPath,
  });
  if (!pagesRes.ok) return { ok: false, message: pagesRes.detail };
  return { ok: true, pages: pagesRes.pages };
}

export function createCvBuildCommand(deps: CvBuildDeps) {
  const sofficeTimeout =
    deps.sofficeTimeoutMilliseconds ?? DEFAULT_SOFFICE_TIMEOUT_MS;

  return changing({
    identity: "cv-tailor.cv-build",
    route: ["cv", "build"],
    summary:
      "Build a deterministic Word .docx from Markdown in the template's styles, convert to PDF via soffice, and report page count.",
    input: {
      ...noInput,
      arguments: [
        {
          name: "source",
          summary: "Path to the Markdown CV source file.",
          required: true,
          value: FILE_PATH_VALUE,
        },
      ],
      options: [
        {
          name: "--template",
          aliases: [],
          summary: "Path to the template .docx file (overrides baselineCv).",
          required: false,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--out",
          aliases: [],
          summary: "Output folder for .docx and .pdf (overrides outputFolder).",
          required: false,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
      ],
    },
    capabilities: { programs: true },
    effectClass: "external",
    effects: ["cv.docx.write", "cv.pdf.convert"],
    ifNoResult: deps.state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_CV_TAILOR_BUILD_HELD",
    unresolvedCaseCause: "DOMAIN_CV_TAILOR_BUILD_UNRESOLVED",
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: SUCCESS_COMPLETED,
        trigger: "The .docx and .pdf were written and confirmed.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.cv-build:completed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
        trigger: "The state folder is invalid or unavailable.",
        guidance: buildHandoff("The cv-tailor state folder is unavailable."),
        repairAction:
          "Set CV_TAILOR_STATE_DIR or HOME to an absolute path pointing to a readable folder.",
        independentObservable: "cv-tailor.cv-build:state-unavailable",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_SETTINGS_INVALID",
        trigger: "The settings file was refused or held invalid JSON.",
        guidance: {
          next: {
            kind: "command",
            command: "cv-tailor.settings-show",
            args: [],
          },
        },
        repairAction:
          "Replace the settings file with a regular JSON object file at most 64 KiB.",
        independentObservable: "cv-tailor.cv-build:settings-invalid",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_SETTINGS_MISSING",
        trigger:
          "No baselineCv template was supplied by option, environment, or settings file.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass --template, set CV_TAILOR_BASELINE_CV, or set baselineCv in settings.json.",
          },
        },
        repairAction:
          "Provide baselineCv via --template, CV_TAILOR_BASELINE_CV, or settings.json.",
        independentObservable: "cv-tailor.cv-build:settings-missing",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
        trigger:
          "The Markdown source file could not be read or contained a heading deeper than ###.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Ensure the Markdown source exists and uses only #, ## and ### headings.",
          },
        },
        repairAction: "Fix the Markdown source file and retry cv build.",
        independentObservable: "cv-tailor.cv-build:source-invalid",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_INVALID",
        trigger:
          "The template .docx could not be read or lacked one of the seven required styles.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Supply a valid Word .docx template containing all seven required styles.",
          },
        },
        repairAction:
          "Repair or replace the template .docx so it includes all seven required styles.",
        independentObservable: "cv-tailor.cv-build:template-invalid",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE",
        trigger: "The output .docx path resolves to the template .docx file.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass a different --out folder or rename the Markdown file so it does not overwrite the template.",
          },
        },
        repairAction:
          "Pass --out pointing to another folder or rename the Markdown source.",
        independentObservable: "cv-tailor.cv-build:template-overwrite",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
        trigger: "soffice or pdfinfo was not found.",
        guidance: {
          next: { kind: "command", command: "cv-tailor.doctor", args: [] },
        },
        repairAction:
          "Run doctor and install LibreOffice and Poppler or configure CV_TAILOR_SOFFICE.",
        independentObservable: "cv-tailor.cv-build:prerequisite-missing",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_BUILD_HELD",
        trigger: "Another cv build holds a lock on this output stem.",
        guidance: buildHandoff(
          "Another cv build is active for this output stem.",
        ),
        repairAction:
          "Wait for the active cv build on this stem to finish, then inspect with pending.",
        independentObservable: "cv-tailor.cv-build:held",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_BUILD_UNRESOLVED",
        trigger: "An earlier cv build for this output stem never finished.",
        guidance: buildHandoff(
          "An earlier cv build for this output stem is unresolved.",
        ),
        repairAction:
          "Run pending to inspect the unfinished build and check the output files by hand. That stem stays blocked until a qualified close exists.",
        independentObservable: "cv-tailor.cv-build:unresolved",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_BUILD_UNAVAILABLE",
        trigger: "The state transaction could not start.",
        guidance: buildHandoff(
          "The cv-tailor state store could not open a transaction.",
        ),
        repairAction:
          "Run pending and verify the state folder permissions before retrying.",
        independentObservable: "cv-tailor.cv-build:unavailable",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_BUILD_FAILED",
        trigger:
          "soffice exited cleanly with an error, did not produce the PDF, or pdfinfo failed.",
        guidance: buildHandoff(
          "PDF conversion failed after writing the .docx.",
        ),
        repairAction:
          "Check LibreOffice soffice and pdfinfo output, then retry cv build.",
        independentObservable: "cv-tailor.cv-build:failed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_BUILD_PARTIAL",
        trigger: "The .docx write confirmed but PDF conversion never started.",
        guidance: buildHandoff(
          "cv build wrote the .docx but did not start PDF conversion.",
        ),
        repairAction:
          "Run pending and inspect the output folder by hand before retrying.",
        independentObservable: "cv-tailor.cv-build:partial",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.cv-build",
        causeCode: "DOMAIN_CV_TAILOR_BUILD_UNCONFIRMED",
        trigger: "An effect started but could not be confirmed on read-back.",
        guidance: buildHandoff("An effect in cv build could not be confirmed."),
        repairAction:
          "Run pending to inspect the unfinished build and check the output files by hand. That stem stays blocked until a qualified close exists.",
        independentObservable: "cv-tailor.cv-build:unconfirmed",
      }),
    ],
    run: async (input, context) => {
      const preflight = runBuildPreflight(deps, input);
      if (!preflight.ok) {
        return context.result(
          {
            commandIdentity: "cv-tailor.cv-build",
            causeCode: preflight.causeCode,
          },
          {
            message: preflight.message,
            data:
              preflight.causeCode === "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING"
                ? {
                    missing: preflight.missingPrograms ?? [],
                    detail: preflight.message,
                  }
                : null,
            effects: noEffects,
          },
        );
      }

      const stemKey = scopeKeyForPath(join(preflight.outDir, preflight.stem));
      const runner = executeBuildWork(
        preflight,
        sofficeTimeout,
        context.programs,
        context.signal,
      );

      const outcome = await deps.state.transaction(
        context.state,
        {
          command: "cv-tailor.cv-build",
          scope: { resources: [{ resource: "cv-output", key: stemKey }] },
          facts: {
            stem: preflight.stem,
            docx: preflight.docxPath,
            pdf: preflight.pdfPath,
          },
        },
        runner.work,
      );
      const { exitCode: sofficeExitCode, stderr: sofficeStderr } =
        runner.getSofficeOutcome();

      if (
        outcome.kind !== "ran" ||
        outcome.proof.transactionState === "unchanged"
      ) {
        const refused = mapTransactionRefusal(outcome, preflight.stem);
        return context.result(
          {
            commandIdentity: "cv-tailor.cv-build",
            causeCode: refused.causeCode,
          },
          { message: refused.message, data: null, effects: noEffects },
        );
      }

      if (outcome.proof.transactionState !== "completed") {
        const isPartial =
          outcome.proof.transactionState === "partially-completed";
        return context.result(
          {
            commandIdentity: "cv-tailor.cv-build",
            causeCode: isPartial
              ? "DOMAIN_CV_TAILOR_BUILD_PARTIAL"
              : "DOMAIN_CV_TAILOR_BUILD_UNCONFIRMED",
          },
          {
            message: isPartial
              ? "cv build wrote the .docx but did not start PDF conversion."
              : "cv build could not confirm its output.",
            data: null,
            transaction: outcome.proof,
          },
        );
      }

      const verified = await verifyBuiltPdf({
        pdfPath: preflight.pdfPath,
        sofficeExitCode,
        sofficeStderr,
        programs: context.programs,
        env: deps.env,
        boundary: deps.getBoundary(),
      });
      if (!verified.ok) {
        return context.result(
          {
            commandIdentity: "cv-tailor.cv-build",
            causeCode: "DOMAIN_CV_TAILOR_BUILD_FAILED",
          },
          { message: verified.message, data: null, transaction: outcome.proof },
        );
      }

      return context.result(
        { commandIdentity: "cv-tailor.cv-build", causeCode: SUCCESS_COMPLETED },
        {
          message: `Built ${preflight.docxPath} and ${preflight.pdfPath} (${String(verified.pages)} pages).`,
          data: {
            docx: preflight.docxPath,
            pdf: preflight.pdfPath,
            pages: verified.pages,
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
