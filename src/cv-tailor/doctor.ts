import { command, station } from "agent-cli-kernel";
import {
  cvTailorCauses,
  noEffects,
  noInput,
  stationWords,
  SUCCESS_UNCHANGED,
} from "./causes.ts";
import { findExecutable, loadSettings } from "./settings.ts";
import type { PathBoundary } from "./settings.ts";

export type DoctorDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getBoundary: () => PathBoundary;
  readonly cwd: string;
};

type ProgramCheckStatus = {
  readonly name: "pdftotext" | "pdfinfo" | "soffice";
  readonly found: boolean;
  readonly path: string | null;
  readonly repair: string | null;
};

export function createDoctorCommand(deps: DoctorDeps) {
  return command({
    identity: "cv-tailor.doctor",
    route: ["doctor"],
    summary:
      "Check external prerequisites (pdftotext, pdfinfo, soffice) and name each missing program with its repair.",
    input: noInput,
    capabilities: {},
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.doctor",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "All required external programs were found.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.doctor:ready",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.doctor",
        causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
        trigger: "One or more of pdftotext, pdfinfo or soffice was not found.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Install each missing program named in data.missing and re-run doctor.",
          },
        },
        repairAction:
          "Install Poppler for pdftotext/pdfinfo and LibreOffice for soffice, or set CV_TAILOR_SOFFICE.",
        independentObservable: "cv-tailor.doctor:missing-prerequisite",
      }),
    ],
    run: (_input, context) => {
      const settingsRes = loadSettings(deps.env, undefined, deps.cwd);
      const sofficeSetting = settingsRes.ok
        ? settingsRes.values.soffice.value
        : null;
      const boundary = deps.getBoundary();

      const names = ["pdftotext", "pdfinfo", "soffice"] as const;
      const programs: ProgramCheckStatus[] = names.map((name) => {
        const res = findExecutable(
          name,
          name === "soffice" ? sofficeSetting : null,
          deps.env.PATH,
          boundary,
        );
        if (res.ok) {
          return { name, found: true, path: res.rawPath, repair: null };
        }
        return { name, found: false, path: null, repair: res.repair };
      });

      const missing = programs.filter((item) => !item.found);
      if (missing.length > 0) {
        const summary = missing
          .map((item) => `${item.name}: ${item.repair ?? ""}`)
          .join("; ");
        return context.result(
          {
            commandIdentity: "cv-tailor.doctor",
            causeCode: "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING",
          },
          {
            message: `Missing prerequisite(s): ${summary}`,
            data: { ready: false, programs, missing },
            effects: noEffects,
          },
        );
      }

      return context.result(
        {
          commandIdentity: "cv-tailor.doctor",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: "All prerequisites found (pdftotext, pdfinfo, soffice).",
          data: { ready: true, programs, missing: [] },
          effects: noEffects,
        },
      );
    },
  });
}
