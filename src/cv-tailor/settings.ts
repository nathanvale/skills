import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { ParsedPath } from "agent-cli-kernel";
import { readRootedFile } from "agent-cli-kernel/rooted-file";
import { xdgBaseFolder } from "agent-cli-kernel/xdg-base";

const SETTINGS_FILE_LIMIT_BYTES = 65_536;

const SETTINGS_KEYS = [
  "jobHuntingFolder",
  "baselineCv",
  "outputFolder",
  "factsFile",
  "constraintsFile",
  "soffice",
] as const;

export type SettingKey = (typeof SETTINGS_KEYS)[number];

const SETTING_ENV_NAMES: Readonly<Record<SettingKey, string>> = {
  jobHuntingFolder: "CV_TAILOR_JOB_HUNTING_DIR",
  baselineCv: "CV_TAILOR_BASELINE_CV",
  outputFolder: "CV_TAILOR_OUTPUT_DIR",
  factsFile: "CV_TAILOR_FACTS_FILE",
  constraintsFile: "CV_TAILOR_CONSTRAINTS_FILE",
  soffice: "CV_TAILOR_SOFFICE",
};

export type SettingSource = "option" | "env" | "file" | "unset";

export type ResolvedSetting = {
  readonly value: string | null;
  readonly source: SettingSource;
};

export type ResolvedSettingsMap = Readonly<Record<SettingKey, ResolvedSetting>>;

export type StateDirResolution =
  | {
      readonly ok: true;
      readonly root: string;
      readonly source:
        | "CV_TAILOR_STATE_DIR"
        | "NATHANVALE_SKILLS_DATA_HOME"
        | "XDG_DATA_HOME"
        | "HOME";
    }
  | {
      readonly ok: false;
      readonly reason: "relative-state-dir" | "missing-home";
      readonly path: string;
      readonly detail: string;
    };

export type SettingsFileResolution =
  | {
      readonly ok: true;
      readonly path: string;
      readonly source: "CV_TAILOR_SETTINGS_FILE" | "XDG_CONFIG_HOME" | "HOME";
    }
  | {
      readonly ok: false;
      readonly detail: string;
    };

export type LoadedSettingsResult =
  | {
      readonly ok: true;
      readonly settingsFile: string;
      readonly settingsFileSource: SettingsFileResolution & {
        readonly ok: true;
      };
      readonly settingsFilePresent: boolean;
      readonly values: ResolvedSettingsMap;
    }
  | {
      readonly ok: false;
      readonly detail: string;
    };

export type PathBoundary = {
  readonly path: (raw: string) => ParsedPath;
};

export type ExecutableLookupResult =
  | { readonly ok: true; readonly path: ParsedPath; readonly rawPath: string }
  | { readonly ok: false; readonly detail: string; readonly repair: string };

const SUITE_SEGMENT = "nathanvale-skills";
const SKILL_SEGMENT = "cv-tailor";
const SCOPE_KEY_PATTERN = /^[\p{L}\p{N}._:/@+-]{1,256}$/u;

function absoluteNonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) return null;
  return trimmed;
}

export function resolveStateDir(
  env: Readonly<Record<string, string | undefined>>,
): StateDirResolution {
  const explicit = env.CV_TAILOR_STATE_DIR;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const trimmed = explicit.trim();
    if (!isAbsolute(trimmed)) {
      return {
        ok: false,
        reason: "relative-state-dir",
        path: trimmed,
        detail:
          "CV_TAILOR_STATE_DIR must be an absolute path. Set CV_TAILOR_STATE_DIR to an absolute folder path.",
      };
    }
    return { ok: true, root: trimmed, source: "CV_TAILOR_STATE_DIR" };
  }
  const suiteRoot = absoluteNonEmpty(env.NATHANVALE_SKILLS_DATA_HOME);
  if (suiteRoot !== null) {
    return {
      ok: true,
      root: join(suiteRoot, SKILL_SEGMENT, "state"),
      source: "NATHANVALE_SKILLS_DATA_HOME",
    };
  }
  const dataBase = xdgBaseFolder(env, "data");
  if (dataBase === undefined) {
    return {
      ok: false,
      reason: "missing-home",
      path: env.HOME ?? "",
      detail:
        "Cannot resolve state folder because HOME is unset or relative. Set CV_TAILOR_STATE_DIR or HOME to an absolute path.",
    };
  }
  const xdgData = absoluteNonEmpty(env.XDG_DATA_HOME);
  return {
    ok: true,
    root: join(dataBase, SUITE_SEGMENT, SKILL_SEGMENT, "state"),
    source: xdgData !== null ? "XDG_DATA_HOME" : "HOME",
  };
}

function resolveSettingsFilePath(
  env: Readonly<Record<string, string | undefined>>,
): SettingsFileResolution {
  const explicit = absoluteNonEmpty(env.CV_TAILOR_SETTINGS_FILE);
  if (explicit !== null) {
    return { ok: true, path: explicit, source: "CV_TAILOR_SETTINGS_FILE" };
  }
  const configBase = xdgBaseFolder(env, "config");
  if (configBase === undefined) {
    return {
      ok: false,
      detail:
        "Cannot resolve settings file because HOME is unset or relative. Set CV_TAILOR_SETTINGS_FILE or HOME to an absolute path.",
    };
  }
  const xdgConfig = absoluteNonEmpty(env.XDG_CONFIG_HOME);
  return {
    ok: true,
    path: join(configBase, SUITE_SEGMENT, SKILL_SEGMENT, "settings.json"),
    source: xdgConfig !== null ? "XDG_CONFIG_HOME" : "HOME",
  };
}

function parseSettingsObject(
  bytes: Uint8Array,
  settingsPath: string,
):
  | { readonly ok: true; readonly record: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: `Settings file ${settingsPath} is not valid JSON: ${detail}. Replace it with a valid JSON object.`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      detail: `Settings file ${settingsPath} must contain a JSON object. Replace it with a regular JSON object file.`,
    };
  }
  const entries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    entries[key] = value;
  }
  return { ok: true, record: entries };
}

function readAbsoluteSettingFromRecord(
  record: Readonly<Record<string, unknown>>,
  key: SettingKey,
): string | null {
  if (!Object.hasOwn(record, key)) return null;
  const raw = record[key];
  return typeof raw === "string" ? absoluteNonEmpty(raw) : null;
}

export function loadSettings(
  env: Readonly<Record<string, string | undefined>>,
  options?: Readonly<Partial<Record<SettingKey, string | undefined>>>,
  cwd: string = process.cwd(),
): LoadedSettingsResult {
  const pathRes = resolveSettingsFilePath(env);
  if (!pathRes.ok) return pathRes;

  let fileRecord: Readonly<Record<string, unknown>> = {};
  let settingsFilePresent = false;
  const rooted = readRootedFile(
    dirname(pathRes.path),
    pathRes.path,
    SETTINGS_FILE_LIMIT_BYTES,
  );
  if (rooted.kind === "refused") {
    return {
      ok: false,
      detail: `Settings file ${pathRes.path} was refused (${rooted.reason}): ${rooted.message} Replace it with a regular file.`,
    };
  }
  if (rooted.kind === "read") {
    settingsFilePresent = true;
    const parsed = parseSettingsObject(rooted.bytes, pathRes.path);
    if (!parsed.ok) return parsed;
    fileRecord = parsed.record;
  }

  const values: Record<SettingKey, ResolvedSetting> = {
    jobHuntingFolder: { value: null, source: "unset" },
    baselineCv: { value: null, source: "unset" },
    outputFolder: { value: null, source: "unset" },
    factsFile: { value: null, source: "unset" },
    constraintsFile: { value: null, source: "unset" },
    soffice: { value: null, source: "unset" },
  };

  for (const key of SETTINGS_KEYS) {
    const opt = options?.[key];
    if (typeof opt === "string" && opt.trim().length > 0) {
      values[key] = { value: resolve(cwd, opt.trim()), source: "option" };
      continue;
    }
    const envVal = absoluteNonEmpty(env[SETTING_ENV_NAMES[key]]);
    if (envVal !== null) {
      values[key] = { value: envVal, source: "env" };
      continue;
    }
    const fileVal = readAbsoluteSettingFromRecord(fileRecord, key);
    if (fileVal !== null) {
      values[key] = { value: fileVal, source: "file" };
    }
  }

  return {
    ok: true,
    settingsFile: pathRes.path,
    settingsFileSource: pathRes,
    settingsFilePresent,
    values,
  };
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  name: "pdftotext" | "pdfinfo" | "soffice",
  explicitPath: string | null,
  envPath: string | undefined,
  boundary: PathBoundary,
): ExecutableLookupResult {
  const repair =
    name === "soffice"
      ? "Install LibreOffice (for example `brew install --cask libreoffice`) or set CV_TAILOR_SOFFICE or soffice in settings.json."
      : `Install Poppler (for example \`brew install poppler\` or \`apt-get install poppler-utils\`) so ${name} is on PATH.`;

  if (explicitPath !== null) {
    if (!isAbsolute(explicitPath)) {
      return {
        ok: false,
        detail: `${name} path must be absolute: ${explicitPath}`,
        repair,
      };
    }
    if (!isExecutableFile(explicitPath)) {
      return {
        ok: false,
        detail: `Configured ${name} is not an executable file: ${explicitPath}`,
        repair,
      };
    }
    return {
      ok: true,
      path: boundary.path(explicitPath),
      rawPath: explicitPath,
    };
  }

  const dirs = (envPath ?? "").split(delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (!isAbsolute(candidate)) continue;
    if (isExecutableFile(candidate)) {
      return { ok: true, path: boundary.path(candidate), rawPath: candidate };
    }
  }

  return {
    ok: false,
    detail: `${name} was not found on PATH.`,
    repair,
  };
}

export function scopeKeyForPath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  if (normalized.length <= 256 && SCOPE_KEY_PATTERN.test(normalized)) {
    return normalized;
  }
  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 24);
  return `path-${digest}`;
}

export function compareCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
