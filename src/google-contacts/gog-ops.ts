import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import type { ContactRecord } from "./domain/rules.ts";
import {
  buildGogBaseArgs,
  GOG_MIN_VERSION,
  OUTPUT_LIMIT_LARGE,
  OUTPUT_LIMIT_SMALL,
  parseGogAuthList,
  decodeGogBatchGetOutput,
  parseGogContactsListPage,
  parseSemver,
  resolveExecutablePath,
  runGogInspect,
  semverAtLeast,
} from "./gog.ts";
import type {
  GogAccountAuthStatus,
  GogCallOutcome,
  GogRuntimeConfig,
  PathBoundary,
} from "./gog.ts";

export type GogDoctorProbe = {
  readonly executable: string | null;
  readonly parsedPath: ParsedPath | null;
  readonly version: string | null;
  readonly versionOk: boolean;
  readonly schemaOk: boolean;
  readonly authOk: boolean;
  readonly accounts: readonly GogAccountAuthStatus[];
  readonly detail: string;
  readonly transient: boolean;
};

function failedProbe(
  partial: Partial<GogDoctorProbe> & { readonly detail: string },
): GogDoctorProbe {
  return {
    executable: partial.executable ?? null,
    parsedPath: partial.parsedPath ?? null,
    version: partial.version ?? null,
    versionOk: partial.versionOk ?? false,
    schemaOk: partial.schemaOk ?? false,
    authOk: partial.authOk ?? false,
    accounts: partial.accounts ?? [],
    detail: partial.detail,
    transient: partial.transient ?? false,
  };
}

async function probeGogVersion(
  programs: ProgramsCapability,
  executable: ParsedPath,
  config: GogRuntimeConfig,
): Promise<{
  readonly versionStr: string | null;
  readonly versionOk: boolean;
  readonly rawText: string;
}> {
  const verRaw = await programs.inspect({
    executable,
    args: ["--version"],
    timeoutMilliseconds: config.timeoutMilliseconds,
    outputLimitBytes: OUTPUT_LIMIT_SMALL,
    shutdownMilliseconds: config.shutdownMilliseconds,
  });
  const rawText = `${verRaw.stdout} ${verRaw.stderr}`.trim();
  const parsed = parseSemver(rawText);
  const minVer = parseSemver(GOG_MIN_VERSION);
  const versionStr =
    parsed !== null
      ? `${String(parsed[0])}.${String(parsed[1])}.${String(parsed[2])}`
      : null;
  const versionOk =
    verRaw.exitCode === 0 &&
    parsed !== null &&
    minVer !== null &&
    semverAtLeast(parsed, minVer);
  return { versionStr, versionOk, rawText };
}

function summarizeAuthProbe(
  accounts: readonly GogAccountAuthStatus[],
  schemaOk: boolean,
  versionStr: string | null,
  account: string | undefined,
): { readonly authOk: boolean; readonly detail: string } {
  const target = account?.trim().toLowerCase();
  const matched =
    target !== undefined
      ? accounts.filter((entry) => entry.account === target)
      : accounts;
  const authOk = matched.some(
    (entry) => entry.valid && entry.hasContactsWriteScope,
  );
  if (!schemaOk) {
    return { authOk, detail: "gog schema contacts probe failed." };
  }
  if (authOk) {
    return {
      authOk: true,
      detail: `gog ${versionStr ?? ""} ready with contacts write scope.`,
    };
  }
  return {
    authOk: false,
    detail:
      target !== undefined
        ? `Account ${target} is not authenticated with contacts write scope.`
        : "No gog account holds valid tokens with contacts write scope.",
  };
}

export async function probeGogReadiness(params: {
  readonly programs: ProgramsCapability;
  readonly boundary: PathBoundary;
  readonly config: GogRuntimeConfig;
  readonly account?: string | undefined;
  readonly client?: string | undefined;
  readonly aborted: () => boolean;
}): Promise<GogDoctorProbe> {
  const resolved = resolveExecutablePath(
    params.config.gogBinOverride ?? params.config.env.GOOGLE_CONTACTS_GOG_BIN,
    params.config.env.PATH,
    "gog",
    params.boundary,
  );
  if (!resolved.ok) return failedProbe({ detail: resolved.reason });
  const ver = await probeGogVersion(
    params.programs,
    resolved.path,
    params.config,
  );
  if (!ver.versionOk) {
    return failedProbe({
      executable: resolved.path,
      parsedPath: resolved.path,
      version: ver.versionStr,
      detail: `gog >= ${GOG_MIN_VERSION} required (found: ${ver.rawText || "unknown"}).`,
    });
  }
  const schemaRes = await runGogInspect(
    params.programs,
    resolved.path,
    ["schema", "contacts", ...buildGogBaseArgs({ enableCommand: "schema" })],
    OUTPUT_LIMIT_SMALL,
    params.config,
    params.aborted,
  );
  if (schemaRes.kind === "transient") {
    return failedProbe({
      executable: resolved.path,
      parsedPath: resolved.path,
      version: ver.versionStr,
      versionOk: true,
      detail: schemaRes.detail,
      transient: true,
    });
  }
  const schemaOk = schemaRes.kind === "ok";
  const authRes = await runGogInspect(
    params.programs,
    resolved.path,
    [
      "auth",
      "list",
      "--check",
      ...buildGogBaseArgs({
        enableCommand: "auth.list",
        client: params.client,
      }),
    ],
    OUTPUT_LIMIT_SMALL,
    params.config,
    params.aborted,
  );
  if (authRes.kind !== "ok") {
    return failedProbe({
      executable: resolved.path,
      parsedPath: resolved.path,
      version: ver.versionStr,
      versionOk: true,
      schemaOk,
      transient: authRes.kind === "transient",
      detail:
        authRes.kind === "empty"
          ? "No authenticated gog accounts found."
          : authRes.detail,
    });
  }
  const accounts = parseGogAuthList(authRes.json);
  const summary = summarizeAuthProbe(
    accounts,
    schemaOk,
    ver.versionStr,
    params.account,
  );
  return {
    executable: resolved.path,
    parsedPath: resolved.path,
    version: ver.versionStr,
    versionOk: true,
    schemaOk,
    authOk: summary.authOk,
    accounts,
    detail: summary.detail,
    transient: false,
  };
}

type BatchGetResult =
  | {
      readonly kind: "ok";
      readonly found: ReadonlyMap<string, ContactRecord>;
      readonly missing: readonly string[];
    }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "unconfirmed"; readonly detail: string };

const PERSON_NOT_FOUND_EXIT = 1;

const GOG_BATCH_READ_LIMIT = 200;

function batchGetStdoutJson(res: GogCallOutcome): unknown {
  if (res.kind === "ok") return res.json;
  if (res.kind !== "rejected" || res.exitCode !== PERSON_NOT_FOUND_EXIT) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(res.raw.stdout);
    return parsed;
  } catch {
    return undefined;
  }
}

async function batchGetChunk(params: {
  readonly programs: ProgramsCapability;
  readonly executable: ParsedPath;
  readonly account: string;
  readonly client: string | undefined;
  readonly slice: readonly string[];
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
}): Promise<BatchGetResult> {
  const args = [
    "contacts",
    "batch",
    "get",
    ...params.slice,
    "--readonly",
    ...buildGogBaseArgs({
      enableCommand: "contacts.batch.get",
      account: params.account,
      client: params.client,
    }),
  ];
  const res = await runGogInspect(
    params.programs,
    params.executable,
    args,
    OUTPUT_LIMIT_LARGE,
    params.config,
    params.aborted,
  );
  if (res.kind === "transient" || res.kind === "unconfirmed") return res;
  const exitDetail =
    "detail" in res
      ? res.detail
      : "gog contacts batch get exited without a decodable result.";
  const stdoutJson = batchGetStdoutJson(res);
  if (stdoutJson === undefined) {
    return { kind: "unavailable", detail: exitDetail };
  }
  const decoded = decodeGogBatchGetOutput(stdoutJson, params.slice);
  if (decoded.kind === "unrecognised") {
    return { kind: "unavailable", detail: decoded.detail };
  }
  if (res.kind !== "ok" && decoded.absent.length === 0) {
    return { kind: "unavailable", detail: exitDetail };
  }
  return { kind: "ok", found: decoded.found, missing: decoded.absent };
}

export async function batchGetContacts(params: {
  readonly programs: ProgramsCapability;
  readonly executable: ParsedPath;
  readonly account: string;
  readonly client?: string | undefined;
  readonly resourceNames: readonly string[];
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
}): Promise<BatchGetResult> {
  const found = new Map<string, ContactRecord>();
  const missing: string[] = [];
  for (let i = 0; i < params.resourceNames.length; i += GOG_BATCH_READ_LIMIT) {
    const chunk = await batchGetChunk({
      programs: params.programs,
      executable: params.executable,
      account: params.account,
      client: params.client,
      slice: params.resourceNames.slice(i, i + GOG_BATCH_READ_LIMIT),
      config: params.config,
      aborted: params.aborted,
    });
    if (chunk.kind !== "ok") return chunk;
    for (const [key, val] of chunk.found) found.set(key, val);
    for (const miss of chunk.missing) missing.push(miss);
  }
  return { kind: "ok", found, missing };
}

type ListParams = {
  readonly programs: ProgramsCapability;
  readonly executable: ParsedPath;
  readonly account: string;
  readonly client?: string | undefined;
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
};

type ListPageResult =
  | {
      readonly kind: "page";
      readonly resourceNames: readonly string[];
      readonly nextPageToken: string | null;
    }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

async function listContactsPage(
  params: ListParams,
  pageToken: string | null,
): Promise<ListPageResult> {
  const args = [
    "contacts",
    "list",
    "--max",
    "100",
    "--readonly",
    ...(pageToken !== null ? ["--page", pageToken] : []),
    ...buildGogBaseArgs({
      enableCommand: "contacts.list",
      account: params.account,
      client: params.client,
    }),
  ];
  const res: GogCallOutcome = await runGogInspect(
    params.programs,
    params.executable,
    args,
    OUTPUT_LIMIT_LARGE,
    params.config,
    params.aborted,
  );
  if (res.kind === "empty") {
    return { kind: "page", resourceNames: [], nextPageToken: null };
  }
  if (res.kind === "transient" || res.kind === "unconfirmed") {
    return { kind: "transient", detail: res.detail };
  }
  if (res.kind !== "ok") return { kind: "unavailable", detail: res.detail };
  const parsed = parseGogContactsListPage(res.json);
  return parsed === null
    ? {
        kind: "unavailable",
        detail:
          "gog contacts list returned a page that is not a contacts[] list of summaries with a people/ resource.",
      }
    : { kind: "page", ...parsed };
}

async function listAllResourceNames(
  params: ListParams,
): Promise<
  | { readonly kind: "ok"; readonly resourceNames: readonly string[] }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const names = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const res = await listContactsPage(params, pageToken);
    if (res.kind !== "page") return res;
    for (const name of res.resourceNames) names.add(name);
    pageToken = res.nextPageToken;
    if (pageToken === null) break;
  }
  return { kind: "ok", resourceNames: [...names] };
}

export async function listAllContacts(params: ListParams): Promise<
  | {
      readonly kind: "ok";
      readonly contacts: readonly ContactRecord[];
      readonly missing: readonly string[];
    }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const listed = await listAllResourceNames(params);
  if (listed.kind !== "ok") return listed;
  const fetched = await batchGetContacts({
    ...params,
    resourceNames: listed.resourceNames,
  });
  if (fetched.kind === "transient" || fetched.kind === "unconfirmed") {
    return { kind: "transient", detail: fetched.detail };
  }
  if (fetched.kind !== "ok") return fetched;
  const contacts: ContactRecord[] = [];
  for (const name of listed.resourceNames) {
    const record = fetched.found.get(name);
    if (record !== undefined) contacts.push(record);
  }
  return { kind: "ok", contacts, missing: fetched.missing };
}
