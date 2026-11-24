import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import { asObject, ownArray, ownNumber, ownString } from "./domain/rules.ts";
import {
  OUTPUT_LIMIT_LARGE,
  OUTPUT_LIMIT_MEDIUM,
  OUTPUT_LIMIT_SMALL,
  parseSemver,
  resolveExecutablePath,
  semverAtLeast,
} from "./gog.ts";
import type { PathBoundary } from "./gog.ts";

const IMSG_MIN_VERSION = "0.21.1";

export type ImsgReadiness = {
  readonly status:
    | "ready"
    | "unsupported-os"
    | "missing"
    | "outdated"
    | "fda-denied";
  readonly version: string | null;
  readonly executable: string | null;
  readonly owningAppHint: string | null;
  readonly detail: string;
};

export type ImsgRuntimeConfig = {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly imsgBinOverride?: string | undefined;
  readonly timeoutMilliseconds: number;
  readonly shutdownMilliseconds: number;
};

function owningAppHintFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const bundleId = env.__CFBundleIdentifier;
  if (bundleId !== undefined && bundleId.trim().length > 0) {
    return bundleId.trim();
  }
  const term = env.TERM_PROGRAM;
  if (term !== undefined && term.trim().length > 0) {
    return term.trim();
  }
  return "your terminal or agent host application";
}

export async function probeImsgReadiness(
  programs: ProgramsCapability,
  boundary: PathBoundary,
  config: ImsgRuntimeConfig,
): Promise<{
  readonly readiness: ImsgReadiness;
  readonly parsedPath: ParsedPath | null;
}> {
  if (config.platform !== "darwin") {
    return {
      readiness: {
        status: "unsupported-os",
        version: null,
        executable: null,
        owningAppHint: null,
        detail: `imsg requires macOS (current platform: ${config.platform}).`,
      },
      parsedPath: null,
    };
  }
  const resolved = resolveExecutablePath(
    config.imsgBinOverride ?? config.env.GOOGLE_CONTACTS_IMSG_BIN,
    config.env.PATH,
    "imsg",
    boundary,
  );
  if (!resolved.ok) {
    return {
      readiness: {
        status: "missing",
        version: null,
        executable: null,
        owningAppHint: null,
        detail: resolved.reason,
      },
      parsedPath: null,
    };
  }
  const verRes = await programs.inspect({
    executable: resolved.path,
    args: ["--version"],
    timeoutMilliseconds: config.timeoutMilliseconds,
    outputLimitBytes: OUTPUT_LIMIT_SMALL,
    shutdownMilliseconds: config.shutdownMilliseconds,
  });
  const verText = `${verRes.stdout} ${verRes.stderr}`.trim();
  const parsedVer = parseSemver(verText);
  const minVer = parseSemver(IMSG_MIN_VERSION);
  if (
    verRes.exitCode !== 0 ||
    parsedVer === null ||
    minVer === null ||
    !semverAtLeast(parsedVer, minVer)
  ) {
    return {
      readiness: {
        status: "outdated",
        version:
          parsedVer !== null
            ? `${String(parsedVer[0])}.${String(parsedVer[1])}.${String(parsedVer[2])}`
            : null,
        executable: resolved.path,
        owningAppHint: null,
        detail: `imsg >= ${IMSG_MIN_VERSION} required (found: ${verText || "unknown"}).`,
      },
      parsedPath: null,
    };
  }
  const versionStr = `${String(parsedVer[0])}.${String(parsedVer[1])}.${String(parsedVer[2])}`;
  const fdaRes = await programs.inspect({
    executable: resolved.path,
    args: ["chats", "--limit", "1", "--no-contacts", "--json"],
    timeoutMilliseconds: config.timeoutMilliseconds,
    outputLimitBytes: OUTPUT_LIMIT_SMALL,
    shutdownMilliseconds: config.shutdownMilliseconds,
  });
  const details = programDetails(fdaRes);
  if (
    fdaRes.exitCode !== 0 ||
    details === undefined ||
    details.timedOut ||
    details.stdoutTruncated
  ) {
    const hint = owningAppHintFromEnv(config.env);
    return {
      readiness: {
        status: "fda-denied",
        version: versionStr,
        executable: resolved.path,
        owningAppHint: hint,
        detail: `macOS Full Disk Access denied for imsg. Grant Full Disk Access to ${hint} in System Settings.`,
      },
      parsedPath: null,
    };
  }
  return {
    readiness: {
      status: "ready",
      version: versionStr,
      executable: resolved.path,
      owningAppHint: null,
      detail: `imsg ${versionStr} is ready with Full Disk Access.`,
    },
    parsedPath: resolved.path,
  };
}

export type ImsgChatRow = {
  readonly id: string;
  readonly identifier: string;
};

export type ImsgMessageRow = {
  readonly id: string;
  readonly text: string;
  readonly date: string | null;
};

function parseImsgJsonList(text: string): readonly unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    const obj = asObject(parsed);
    if (obj === null) return [];
    return ownArray(obj, "chats") ?? ownArray(obj, "messages") ?? [];
  } catch {
    return [];
  }
}

async function runImsgJsonList(
  programs: ProgramsCapability,
  executable: ParsedPath,
  args: readonly string[],
  outputLimitBytes: number,
  config: ImsgRuntimeConfig,
): Promise<readonly unknown[] | null> {
  const res = await programs.inspect({
    executable,
    args,
    timeoutMilliseconds: config.timeoutMilliseconds,
    outputLimitBytes,
    shutdownMilliseconds: config.shutdownMilliseconds,
  });
  const details = programDetails(res);
  if (res.exitCode !== 0 || details === undefined || details.stdoutTruncated) {
    return null;
  }
  return parseImsgJsonList(res.stdout);
}

function readRowId(obj: object, fallback: string | null): string | null {
  const str = ownString(obj, "id");
  if (str !== null) return str;
  const num = ownNumber(obj, "id");
  return num !== null ? String(num) : fallback;
}

export async function fetchImsgChats(
  programs: ProgramsCapability,
  executable: ParsedPath,
  maxChats: number,
  config: ImsgRuntimeConfig,
): Promise<readonly ImsgChatRow[] | null> {
  const list = await runImsgJsonList(
    programs,
    executable,
    ["chats", "--limit", String(maxChats), "--no-contacts", "--json"],
    OUTPUT_LIMIT_LARGE,
    config,
  );
  if (list === null) return null;
  const rows: ImsgChatRow[] = [];
  for (const item of list) {
    const obj = asObject(item);
    if (obj === null) continue;
    const id = readRowId(obj, null);
    const identifier =
      ownString(obj, "identifier") ??
      ownString(obj, "handle") ??
      ownString(obj, "chat_identifier");
    if (id !== null && identifier !== null) rows.push({ id, identifier });
  }
  return rows;
}

export async function fetchImsgHistory(
  programs: ProgramsCapability,
  executable: ParsedPath,
  chatId: string,
  maxMessages: number,
  config: ImsgRuntimeConfig,
): Promise<readonly ImsgMessageRow[] | null> {
  const list = await runImsgJsonList(
    programs,
    executable,
    [
      "history",
      "--chat-id",
      chatId,
      "--limit",
      String(maxMessages),
      "--no-contacts",
      "--json",
    ],
    OUTPUT_LIMIT_MEDIUM,
    config,
  );
  if (list === null) return null;
  const rows: ImsgMessageRow[] = [];
  for (const item of list) {
    const obj = asObject(item);
    if (obj === null) continue;
    const text = ownString(obj, "text") ?? ownString(obj, "body");
    if (text === null || text.trim().length === 0) continue;
    rows.push({
      id: readRowId(obj, "msg") ?? "msg",
      text,
      date: ownString(obj, "date") ?? ownString(obj, "created_at"),
    });
  }
  return rows;
}
