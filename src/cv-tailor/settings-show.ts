import { command, station } from "agent-cli-kernel";
import {
  cvTailorCauses,
  noEffects,
  noInput,
  stationWords,
  SUCCESS_UNCHANGED,
} from "./causes.ts";
import { loadSettings, resolveStateDir } from "./settings.ts";

export type SettingsShowDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
};

export function createSettingsShowCommand(deps: SettingsShowDeps) {
  return command({
    identity: "cv-tailor.settings-show",
    route: ["settings", "show"],
    summary:
      "Print each resolved cv-tailor folder and program path and the source it came from.",
    input: noInput,
    capabilities: {},
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.settings-show",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "Settings were resolved cleanly.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.settings-show:resolved",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.settings-show",
        causeCode: "DOMAIN_CV_TAILOR_SETTINGS_INVALID",
        trigger:
          "The settings file path could not be resolved, was refused as non-regular/oversize, or held invalid JSON.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Set CV_TAILOR_SETTINGS_FILE or HOME to an absolute path and ensure the settings file is a regular JSON object file at most 64 KiB.",
          },
        },
        repairAction:
          "Replace the settings file with a regular JSON file at most 64 KiB, or set CV_TAILOR_SETTINGS_FILE to an absolute path.",
        independentObservable: "cv-tailor.settings-show:settings-invalid",
      }),
    ],
    run: (_input, context) => {
      const loaded = loadSettings(deps.env, undefined, deps.cwd);
      if (!loaded.ok) {
        return context.result(
          {
            commandIdentity: "cv-tailor.settings-show",
            causeCode: "DOMAIN_CV_TAILOR_SETTINGS_INVALID",
          },
          {
            message: loaded.detail,
            data: null,
            effects: noEffects,
          },
        );
      }
      const stateDir = resolveStateDir(deps.env);
      return context.result(
        {
          commandIdentity: "cv-tailor.settings-show",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `Resolved cv-tailor settings from ${loaded.settingsFile} (${loaded.settingsFilePresent ? "present" : "absent"}).`,
          data: {
            settingsFile: loaded.settingsFile,
            settingsFileSource: loaded.settingsFileSource.source,
            settingsFilePresent: loaded.settingsFilePresent,
            stateDir: stateDir.ok ? stateDir.root : null,
            stateDirSource: stateDir.ok ? stateDir.source : stateDir.reason,
            settings: loaded.values,
          },
          effects: noEffects,
        },
      );
    },
  });
}
