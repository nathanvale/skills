import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContactRecord,
  ContactSnapshotDoc,
} from "../../src/google-contacts/domain/rules.ts";
import { registerStub } from "./google-contacts-processes.ts";

export type GogStubBehavior = {
  readonly version?: string;
  readonly schemaExit?: number;
  readonly authExit?: number;
  readonly authWriteScope?: boolean;
  readonly authAccounts?: readonly {
    readonly account: string;
    readonly valid: boolean;
    readonly scopes: readonly string[];
  }[];
  readonly listExit?: number;
  readonly listPages?: readonly (readonly ContactRecord[])[];
  readonly listStdoutByPage?: Readonly<Record<string, string>>;
  readonly batchGetExit?: number;
  readonly batchGetExitByCall?: Readonly<Record<string, number>>;
  readonly batchGetStdoutByCall?: Readonly<Record<string, string>>;
  readonly failPersonOnCall?: {
    readonly call: number;
    readonly resourceName: string;
    readonly code: number;
    readonly httpStatusCode: number;
  };
  readonly batchUpdateExit?: number;
  readonly failOnUpdateCall?: number;
  readonly failOnUpdateExit?: number;
  readonly externalDriftOnUpdateCall?: {
    readonly call: number;
    readonly resourceName: string;
    readonly action: "drift" | "delete";
  };
  readonly batchDeleteExit?: number;
  readonly gmailSearchExit?: number;
  readonly gmailSearchTruncate?: boolean;
  readonly postReadBackExit?: number;
  readonly postReadBackTruncate?: boolean;
  readonly updateTruncate?: boolean;
  readonly updateReturnMismatch?: boolean;
  readonly addFormattedTypeOnUpdate?: boolean;
  readonly mutateOnUpdate?: boolean;
  readonly mutateOnDelete?: boolean;
  readonly driftDupBeforeDelete?: string;
  readonly driftTargetBeforeDelete?: string;
  readonly holdLockReadyFile?: string;
  readonly holdLockReleaseFile?: string;
  readonly hangOnContact?: string;
  readonly hangReadyFile?: string;
};

export type StubStateFile = {
  readonly account: string;
  readonly contacts: readonly ContactRecord[];
  readonly gmailThreads?: Readonly<
    Record<string, { readonly snippet: string; readonly date: string }>
  >;
  readonly behavior?: GogStubBehavior;
};

export function sampleContact(
  id: string,
  overrides?: Partial<ContactRecord>,
): ContactRecord {
  return {
    resourceName: `people/${id}`,
    etag: `etag-${id}-v1`,
    metadata: {
      sources: [{ type: "CONTACT", id, etag: `etag-${id}-v1` }],
    },
    names: [{ displayName: `Alex ${id}`, givenName: "Alex", familyName: id }],
    phoneNumbers: [{ value: "0491 570 101", type: "mobile" }],
    emailAddresses: [{ value: `${id}@acme.example.com`, type: "work" }],
    addresses: [],
    organizations: [
      { name: "Acme Example", title: "Engineer", domain: "acme.example.com" },
    ],
    biographies: [],
    urls: [],
    birthdays: [],
    events: [],
    relations: [],
    nonAllowlistedFields: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

export function sampleSnapshot(
  contacts: readonly ContactRecord[],
  account = "owner@example.com",
): ContactSnapshotDoc {
  return {
    schemaVersion: "contacts-snapshot/1",
    account,
    capturedAt: "2026-11-24T00:00:00.000Z",
    contacts,
    missingContacts: [],
  };
}

const STUB_GOG_BODY = `
import { existsSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const pidFile = join(pidDir, String(process.pid));
writeFileSync(pidFile, String(process.pid), "utf8");
process.on("exit", () => rmSync(pidFile, { force: true }));
const orphaned = () => !existsSync(pidDir) || process.ppid === 1;
setInterval(() => {
  if (orphaned()) process.exit(137);
}, 100).unref();
const state = JSON.parse(readFileSync(statePath, "utf8"));
const b = state.behavior ?? {};
const args = process.argv.slice(2);
if (logPath) {
  const prev = JSON.parse(readFileSync(logPath, "utf8"));
  prev.push({ args, time: Date.now() });
  writeFileSync(logPath, JSON.stringify(prev), "utf8");
}
const save = () => writeFileSync(statePath, JSON.stringify(state), "utf8");
const waitRelease = (file) => new Promise((resolve) => {
  if (existsSync(file)) return resolve();
  let w;
  let timer;
  const done = () => {
    if (!existsSync(dirname(file))) process.exit(137);
    if (!existsSync(file)) return;
    clearInterval(timer);
    w.close();
    resolve();
  };
  w = watch(dirname(file), done);
  timer = setInterval(done, 100);
  done();
});

if (args[0] === "--version") {
  process.stdout.write("gog version " + (b.version ?? "0.48.1") + "\\n");
  process.exit(0);
}
if (args[0] === "schema" && args[1] === "contacts") {
  if ((b.schemaExit ?? 0) !== 0) process.exit(b.schemaExit);
  process.stdout.write(JSON.stringify({ resource: "contacts", version: "1" }));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "list") {
  if ((b.authExit ?? 0) !== 0) process.exit(b.authExit);
  const scopes = b.authWriteScope === false
    ? ["https://www.googleapis.com/auth/contacts.readonly"]
    : ["https://www.googleapis.com/auth/contacts", "https://www.googleapis.com/auth/gmail.readonly"];
  const accounts = b.authAccounts ?? [{ account: state.account, valid: true, scopes }];
  process.stdout.write(JSON.stringify({ accounts }));
  process.exit(0);
}
if (args[0] === "contacts" && args[1] === "list") {
  if ((b.listExit ?? 0) !== 0) process.exit(b.listExit);
  const pageIdxArg = args.indexOf("--page");
  const pageIndex = pageIdxArg === -1 ? 0 : Number(args[pageIdxArg + 1] ?? "0");
  const rawPage = b.listStdoutByPage?.[String(pageIndex)];
  if (typeof rawPage === "string") {
    process.stdout.write(rawPage);
    process.exit(0);
  }
  const pages = Array.isArray(b.listPages) ? b.listPages : [state.contacts];
  const summary = (c) => ({
    resource: c.resourceName,
    ...(c.names?.[0]?.displayName ? { name: c.names[0].displayName } : {}),
    ...(c.emailAddresses?.[0]?.value ? { email: c.emailAddresses[0].value } : {}),
    ...(c.phoneNumbers?.[0]?.value ? { phone: c.phoneNumbers[0].value } : {}),
  });
  const nextToken = pageIndex + 1 < pages.length ? String(pageIndex + 1) : "";
  process.stdout.write(JSON.stringify({ contacts: (pages[pageIndex] ?? []).map(summary), nextPageToken: nextToken }));
  process.exit(0);
}
if (args[0] === "contacts" && args[1] === "batch" && args[2] === "get") {
  state.batchGetCount = (state.batchGetCount ?? 0) + 1;
  save();
  const byCall = b.batchGetExitByCall?.[String(state.batchGetCount)];
  if (typeof byCall === "number" && byCall !== 0) process.exit(byCall);
  if (state.batchGetCount > 1 && b.postReadBackTruncate === true) {
    await Bun.write(Bun.stdout, "x".repeat(4_300_000));
    process.exit(0);
  }
  if (state.batchGetCount > 1 && (b.postReadBackExit ?? 0) !== 0) {
    process.exit(b.postReadBackExit);
  }
  if ((b.batchGetExit ?? 0) !== 0) process.exit(b.batchGetExit);
  if (state.batchGetCount === 2 && b.driftTargetBeforeDelete) {
    const idx = state.contacts.findIndex((c) => c.resourceName === b.driftTargetBeforeDelete);
    if (idx !== -1) state.contacts[idx].etag = state.contacts[idx].etag + "-drifted";
    save();
  }
  const rawStdout = b.batchGetStdoutByCall?.[String(state.batchGetCount)];
  if (typeof rawStdout === "string") {
    process.stdout.write(rawStdout);
    process.exit(0);
  }
  const requested = args.slice(3).filter((x) => x.startsWith("people/"));
  const failed = b.failPersonOnCall?.call === state.batchGetCount ? b.failPersonOnCall : null;
  const responses = requested.map((rn) => {
    const person = state.contacts.find((c) => c.resourceName === rn);
    if (person && failed?.resourceName === rn) {
      return { httpStatusCode: failed.httpStatusCode, person, requestedResourceName: rn, status: { code: failed.code, message: "Internal error encountered." } };
    }
    return person
      ? { httpStatusCode: 200, person, requestedResourceName: rn }
      : { httpStatusCode: 404, requestedResourceName: rn, status: { code: 5, message: "Requested entity was not found." } };
  });
  const allFound = responses.every((item) => item.person !== undefined && item.status === undefined);
  process.stdout.write(JSON.stringify({
    operation: "get",
    requested: requested.length,
    completed: allFound ? requested.length : 0,
    batches: [{
      batch: 1,
      resource_names: requested,
      state: allFound ? "completed" : "unconfirmed",
      response: { responses },
      ...(allFound ? {} : { error: { message: "person response status 5: Requested entity was not found." } }),
    }],
  }));
  process.exit(allFound ? 0 : 1);
}
if (args[0] === "contacts" && args[1] === "batch" && args[2] === "update") {
  state.batchUpdateCount = (state.batchUpdateCount ?? 0) + 1;
  save();
  const stdinText = await Bun.stdin.text();
  if (logPath) {
    const prev = JSON.parse(readFileSync(logPath, "utf8"));
    prev[prev.length - 1].stdin = stdinText;
    writeFileSync(logPath, JSON.stringify(prev), "utf8");
  }
  const payload = JSON.parse(stdinText);
  if (b.hangOnContact && Object.hasOwn(payload, b.hangOnContact)) {
    if (b.hangReadyFile) writeFileSync(b.hangReadyFile, "ready", "utf8");
    await new Promise(() => {});
  }
  if (b.holdLockReadyFile && b.holdLockReleaseFile) {
    writeFileSync(b.holdLockReadyFile, "held", "utf8");
    await waitRelease(b.holdLockReleaseFile);
  }
  if (b.externalDriftOnUpdateCall && b.externalDriftOnUpdateCall.call === state.batchUpdateCount) {
    const targetRn = b.externalDriftOnUpdateCall.resourceName;
    if (b.externalDriftOnUpdateCall.action === "delete") {
      state.contacts = state.contacts.filter((c) => c.resourceName !== targetRn);
    } else {
      const idx = state.contacts.findIndex((c) => c.resourceName === targetRn);
      if (idx !== -1) state.contacts[idx].etag = state.contacts[idx].etag + "-ext";
    }
    save();
  }
  if (b.failOnUpdateCall === state.batchUpdateCount) {
    process.stderr.write("Simulated rejection on sub-batch " + String(state.batchUpdateCount) + "\\n");
    process.exit(b.failOnUpdateExit ?? 1);
  }
  if ((b.batchUpdateExit ?? 0) !== 0) process.exit(b.batchUpdateExit);
  if (b.updateTruncate === true) {
    await Bun.write(Bun.stdout, "y".repeat(2_200_000));
    process.exit(0);
  }
  if (b.mutateOnUpdate !== false) {
    for (const [rn, patch] of Object.entries(payload)) {
      const idx = state.contacts.findIndex((c) => c.resourceName === rn);
      if (idx === -1) process.exit(5);
      const cur = state.contacts[idx];
      if (patch.etag !== cur.etag) process.exit(1);
      if (b.updateReturnMismatch === true) {
        state.contacts[idx] = { ...cur, etag: cur.etag + "-mismatch" };
      } else {
        const appliedPatch = b.addFormattedTypeOnUpdate && Array.isArray(patch.phoneNumbers)
          ? { ...patch, phoneNumbers: patch.phoneNumbers.map((p) => ({ ...p, formattedType: "Mobile" })) }
          : patch;
        state.contacts[idx] = { ...cur, ...appliedPatch, etag: cur.etag + "-next" };
      }
    }
    if (b.driftDupBeforeDelete) {
      const dIdx = state.contacts.findIndex((c) => c.resourceName === b.driftDupBeforeDelete);
      if (dIdx !== -1) state.contacts[dIdx].etag = state.contacts[dIdx].etag + "-drifted";
    }
    save();
  }
  process.stdout.write(JSON.stringify({ updated: Object.keys(payload) }));
  process.exit(0);
}
if (args[0] === "contacts" && args[1] === "batch" && args[2] === "delete") {
  if ((b.batchDeleteExit ?? 0) !== 0) process.exit(b.batchDeleteExit);
  const targets = args.slice(3).filter((x) => x.startsWith("people/"));
  if (b.mutateOnDelete !== false) {
    state.contacts = state.contacts.filter((c) => !targets.includes(c.resourceName));
    save();
  }
  process.stdout.write(JSON.stringify({ deleted: targets }));
  process.exit(0);
}
if (args[0] === "gmail" && args[1] === "search") {
  if (b.gmailSearchTruncate === true) {
    await Bun.write(Bun.stdout, "z".repeat(4_300_000));
    process.exit(0);
  }
  if ((b.gmailSearchExit ?? 0) !== 0) process.exit(b.gmailSearchExit);
  const threads = Object.keys(state.gmailThreads ?? {});
  if (threads.length === 0) process.exit(3);
  process.stdout.write(JSON.stringify({ threads: threads.map((id) => ({ id })) }));
  process.exit(0);
}
if (args[0] === "gmail" && args[1] === "thread" && args[2] === "get") {
  const tid = args[3];
  const row = (state.gmailThreads ?? {})[tid];
  if (!row) process.exit(5);
  process.stdout.write(JSON.stringify({ id: tid, snippet: row.snippet, date: row.date }));
  process.exit(0);
}
process.exit(2);
`;

type StubLogEntry = {
  readonly args: readonly string[];
  readonly stdin?: string;
};

function parseStubLogEntry(item: unknown): StubLogEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const rawArgs: unknown = Reflect.get(item, "args");
  const rawStdin: unknown = Reflect.get(item, "stdin");
  const args: string[] = [];
  if (Array.isArray(rawArgs)) {
    for (const entry of rawArgs) {
      if (typeof entry === "string") args.push(entry);
    }
  }
  return {
    args,
    ...(typeof rawStdin === "string" ? { stdin: rawStdin } : {}),
  };
}

export function createGogStub(
  folder: string,
  initial: StubStateFile,
): {
  readonly binPath: string;
  readonly pidDir: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly readLog: () => readonly StubLogEntry[];
  readonly readState: () => StubStateFile;
} {
  const binPath = join(folder, "gog-stub");
  const statePath = join(folder, "gog-state.json");
  const logPath = join(folder, "gog-log.json");
  const pidDir = join(folder, "gog-pids");
  mkdirSync(pidDir, { recursive: true });
  registerStub(pidDir);
  writeFileSync(statePath, JSON.stringify(initial), "utf8");
  writeFileSync(logPath, "[]", "utf8");
  writeFileSync(
    binPath,
    `#!${process.execPath}\nconst statePath = ${JSON.stringify(statePath)};\nconst logPath = ${JSON.stringify(logPath)};\nconst pidDir = ${JSON.stringify(pidDir)};\n${STUB_GOG_BODY}`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  return {
    binPath,
    pidDir,
    statePath,
    logPath,
    readLog: () => {
      const parsed: unknown = JSON.parse(readFileSync(logPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      const rows: StubLogEntry[] = [];
      for (const item of parsed) {
        const entry = parseStubLogEntry(item);
        if (entry !== null) rows.push(entry);
      }
      return rows;
    },
    readState: () => {
      const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Invalid stub state JSON.");
      }
      const account: unknown = Reflect.get(parsed, "account");
      const contacts: unknown = Reflect.get(parsed, "contacts");
      return {
        account: typeof account === "string" ? account : "",
        contacts: Array.isArray(contacts) ? contacts : [],
      };
    },
  };
}

export function createImsgStub(
  folder: string,
  options: {
    readonly version?: string;
    readonly chatsExit?: number;
    readonly chats?: readonly {
      readonly id: string;
      readonly identifier: string;
    }[];
    readonly history?: readonly {
      readonly id: string;
      readonly text: string;
      readonly date: string;
    }[];
  },
): string {
  const binPath = join(folder, "imsg-stub");
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("imsg ${options.version ?? "0.21.1"}\\n");
  process.exit(0);
}
if (args[0] === "chats") {
  if (${String(options.chatsExit ?? 0)} !== 0) {
    process.stderr.write("Full Disk Access denied\\n");
    process.exit(${String(options.chatsExit ?? 0)});
  }
  process.stdout.write(${JSON.stringify(JSON.stringify(options.chats ?? []))});
  process.exit(0);
}
if (args[0] === "history") {
  process.stdout.write(${JSON.stringify(JSON.stringify(options.history ?? []))});
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}
