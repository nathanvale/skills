import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  ParsedPath,
  ProgramResult,
  ProgramsCapability,
  RecordedEffect,
} from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import { decodeContactRecord } from "./decoders/rules.ts";
import { asObject, ownArray, ownString, ownValue } from "./domain/rules.ts";
import type { ContactRecord } from "./domain/rules.ts";

export type PathBoundary = {
  readonly path: (raw: string) => ParsedPath;
};

export const GOG_MIN_VERSION = "0.48.1";
const CONTACTS_WRITE_SCOPE = "https://www.googleapis.com/auth/contacts";
export const OUTPUT_LIMIT_SMALL = 65_536;
export const OUTPUT_LIMIT_MEDIUM = 2_097_152;
export const OUTPUT_LIMIT_LARGE = 4_194_304;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_SHUTDOWN_MS = 5_000;

export type GogRuntimeConfig = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly gogBinOverride?: string | undefined;
  readonly timeoutMilliseconds: number;
  readonly shutdownMilliseconds: number;
};

export type SemverTuple = readonly [number, number, number];

export function parseSemver(text: string): SemverTuple | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }
  return [major, minor, patch];
}

export function semverAtLeast(
  actual: SemverTuple,
  minimum: SemverTuple,
): boolean {
  if (actual[0] !== minimum[0]) return actual[0] > minimum[0];
  if (actual[1] !== minimum[1]) return actual[1] > minimum[1];
  return actual[2] >= minimum[2];
}

export function resolveExecutablePath(
  explicitPath: string | undefined,
  envPath: string | undefined,
  binaryName: string,
  boundary: PathBoundary,
):
  | { readonly ok: true; readonly path: ParsedPath }
  | { readonly ok: false; readonly reason: string } {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    const trimmed = explicitPath.trim();
    if (!isAbsolute(trimmed)) {
      return {
        ok: false,
        reason: `Configured ${binaryName} path must be absolute: ${trimmed}`,
      };
    }
    if (!existsSync(trimmed) || !statSync(trimmed).isFile()) {
      return {
        ok: false,
        reason: `Configured ${binaryName} executable not found: ${trimmed}`,
      };
    }
    return { ok: true, path: boundary.path(trimmed) };
  }
  const searchDirs = (envPath ?? "")
    .split(delimiter)
    .filter((d) => d.length > 0);
  for (const dir of searchDirs) {
    const candidate = join(dir, binaryName);
    if (!isAbsolute(candidate)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { ok: true, path: boundary.path(candidate) };
    }
  }
  return { ok: false, reason: `${binaryName} executable not found in PATH.` };
}

export type GogCallOutcome =
  | { readonly kind: "ok"; readonly json: unknown; readonly raw: ProgramResult }
  | { readonly kind: "empty"; readonly raw: ProgramResult }
  | {
      readonly kind: "not-found";
      readonly detail: string;
      readonly raw: ProgramResult;
    }
  | {
      readonly kind: "transient";
      readonly detail: string;
      readonly raw: ProgramResult;
    }
  | {
      readonly kind: "unavailable";
      readonly detail: string;
      readonly raw: ProgramResult;
    }
  | {
      readonly kind: "rejected";
      readonly exitCode: number;
      readonly detail: string;
      readonly raw: ProgramResult;
    }
  | {
      readonly kind: "unconfirmed";
      readonly detail: string;
      readonly raw: ProgramResult;
    };

const UNAVAILABLE_EXIT_CODES = new Set([4, 6, 10, 11]);
const TRANSIENT_EXIT_CODES = new Set([7, 8]);

function classifyZeroExit(result: ProgramResult): GogCallOutcome {
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) return { kind: "ok", json: {}, raw: result };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return { kind: "ok", json: parsed, raw: result };
  } catch {
    return {
      kind: "unavailable",
      detail: "gog returned non-JSON stdout.",
      raw: result,
    };
  }
}

function classifyNonZeroExit(
  code: number,
  result: ProgramResult,
): GogCallOutcome {
  const detail =
    result.stderr.trim() || `gog exited with code ${String(code)}.`;
  if (code === 3) return { kind: "empty", raw: result };
  if (code === 5) return { kind: "not-found", detail, raw: result };
  if (TRANSIENT_EXIT_CODES.has(code)) {
    return { kind: "transient", detail, raw: result };
  }
  if (UNAVAILABLE_EXIT_CODES.has(code)) {
    return { kind: "unavailable", detail, raw: result };
  }
  return { kind: "rejected", exitCode: code, detail, raw: result };
}

function classifyProgramResult(
  result: ProgramResult,
  aborted: boolean,
): GogCallOutcome {
  const details = programDetails(result);
  const unclean =
    aborted ||
    details === undefined ||
    details.timedOut ||
    !result.terminationConfirmed ||
    result.exitCode === null ||
    result.exitCode === 130;
  if (unclean) {
    return {
      kind: "unconfirmed",
      detail:
        details?.timedOut === true
          ? "gog subprocess timed out."
          : "gog subprocess did not terminate cleanly.",
      raw: result,
    };
  }
  if (details.stdoutTruncated) {
    return {
      kind: "unavailable",
      detail: "gog stdout exceeded outputLimitBytes and was truncated.",
      raw: result,
    };
  }
  return result.exitCode === 0
    ? classifyZeroExit(result)
    : classifyNonZeroExit(result.exitCode, result);
}

export function buildGogBaseArgs(params: {
  readonly enableCommand: string;
  readonly account?: string | undefined;
  readonly client?: string | undefined;
}): readonly string[] {
  const args: string[] = [
    "--no-input",
    "--json",
    `--enable-commands-exact=${params.enableCommand}`,
  ];
  if (params.account !== undefined) args.push("--account", params.account);
  if (params.client !== undefined) args.push("--client", params.client);
  return args;
}

export async function runGogInspect(
  programs: ProgramsCapability,
  executable: ParsedPath,
  args: readonly string[],
  outputLimitBytes: number,
  config: GogRuntimeConfig,
  aborted: () => boolean,
): Promise<GogCallOutcome> {
  const result = await programs.inspect({
    executable,
    args,
    timeoutMilliseconds: config.timeoutMilliseconds,
    outputLimitBytes,
    shutdownMilliseconds: config.shutdownMilliseconds,
  });
  return classifyProgramResult(result, aborted());
}

export async function runGogDomain(
  programs: ProgramsCapability,
  recorded: RecordedEffect<"contacts.mutate">,
  executable: ParsedPath,
  args: readonly string[],
  outputLimitBytes: number,
  config: GogRuntimeConfig,
  aborted: () => boolean,
  stdinBytes?: Uint8Array,
): Promise<GogCallOutcome> {
  const result = await programs.domain(recorded).start({
    executable,
    args,
    ...(stdinBytes !== undefined ? { input: stdinBytes } : {}),
    timeoutMilliseconds: config.timeoutMilliseconds,
    outputLimitBytes,
    shutdownMilliseconds: config.shutdownMilliseconds,
  });
  return classifyProgramResult(result, aborted());
}

export type GogAccountAuthStatus = {
  readonly account: string;
  readonly valid: boolean;
  readonly hasContactsWriteScope: boolean;
  readonly scopes: readonly string[];
  readonly detail: string;
};

function parseSingleAuthAccount(raw: unknown): GogAccountAuthStatus | null {
  const obj = asObject(raw);
  if (obj === null) return null;
  const account = ownString(obj, "account") ?? ownString(obj, "email");
  if (account === null || account.trim().length === 0) return null;
  const rawScopes = ownArray(obj, "scopes") ?? [];
  const scopes: string[] = [];
  for (const item of rawScopes) {
    if (typeof item === "string") scopes.push(item);
  }
  const hasContactsWriteScope = scopes.includes(CONTACTS_WRITE_SCOPE);
  const statusStr = ownString(obj, "status");
  const validVal = ownValue(obj, "valid");
  const valid =
    typeof validVal === "boolean"
      ? validVal
      : statusStr === null ||
        statusStr === "ok" ||
        statusStr === "valid" ||
        statusStr === "authenticated";
  const detail =
    ownString(obj, "error") ??
    (valid && hasContactsWriteScope
      ? "Authenticated with contacts write scope."
      : !valid
        ? "Token invalid or expired."
        : "Missing https://www.googleapis.com/auth/contacts write scope.");
  return {
    account: account.trim().toLowerCase(),
    valid,
    hasContactsWriteScope,
    scopes,
    detail,
  };
}

export function parseGogAuthList(
  json: unknown,
): readonly GogAccountAuthStatus[] {
  const obj = asObject(json);
  const list = Array.isArray(json)
    ? json
    : obj === null
      ? []
      : (ownArray(obj, "accounts") ?? ownArray(obj, "items") ?? []);
  const out: GogAccountAuthStatus[] = [];
  for (const entry of list) {
    const parsed = parseSingleAuthAccount(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function parseGogContactsListPage(json: unknown): {
  readonly contacts: readonly ContactRecord[];
  readonly nextPageToken: string | null;
} {
  const obj = asObject(json);
  const rawList = Array.isArray(json)
    ? json
    : obj === null
      ? []
      : (ownArray(obj, "contacts") ??
        ownArray(obj, "connections") ??
        ownArray(obj, "people") ??
        []);
  const contacts: ContactRecord[] = [];
  for (const item of rawList) {
    const rec = decodeContactRecord(item);
    if (rec !== null) contacts.push(rec);
  }
  const token = obj !== null ? ownString(obj, "nextPageToken") : null;
  return {
    contacts,
    nextPageToken: token !== null && token.trim().length > 0 ? token : null,
  };
}

function extractBatchGetItems(json: unknown): readonly unknown[] {
  if (Array.isArray(json)) return json;
  const obj = asObject(json);
  if (obj === null) return [];
  const list =
    ownArray(obj, "responses") ??
    ownArray(obj, "contacts") ??
    ownArray(obj, "people");
  if (list !== null) return list;
  return Object.keys(obj).map((key): unknown => Reflect.get(obj, key));
}

export function parseGogBatchGetResponse(
  json: unknown,
  requested: readonly string[],
): {
  readonly found: ReadonlyMap<string, ContactRecord>;
  readonly missing: readonly string[];
} {
  const found = new Map<string, ContactRecord>();
  for (const candidate of extractBatchGetItems(json)) {
    const obj = asObject(candidate);
    if (obj === null) continue;
    const person = ownValue(obj, "person");
    const rec = decodeContactRecord(person !== undefined ? person : obj);
    if (rec !== null) found.set(rec.resourceName, rec);
  }
  const missing = requested.filter((rn) => !found.has(rn));
  return { found, missing };
}
