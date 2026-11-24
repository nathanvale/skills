import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContactRecord,
  ContactSnapshotDoc,
} from "../../src/google-contacts/domain/rules.ts";

export type GogStubBehavior = {
  readonly version?: string;
  readonly schemaExit?: number;
  readonly authExit?: number;
  readonly authWriteScope?: boolean;
  readonly listExit?: number;
  readonly batchGetExit?: number;
  readonly batchUpdateExit?: number;
  readonly batchDeleteExit?: number;
  readonly gmailSearchExit?: number;
  readonly postReadBackExit?: number;
  readonly updateDelayMs?: number;
  readonly mutateOnUpdate?: boolean;
  readonly mutateOnDelete?: boolean;
  readonly driftDupBeforeDelete?: string;
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
import { readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(statePath, "utf8"));
const b = state.behavior ?? {};
const args = process.argv.slice(2);
if (logPath) {
  const prev = JSON.parse(readFileSync(logPath, "utf8"));
  prev.push({ args, time: Date.now() });
  writeFileSync(logPath, JSON.stringify(prev), "utf8");
}
const save = () => writeFileSync(statePath, JSON.stringify(state), "utf8");

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
  process.stdout.write(JSON.stringify({
    accounts: [{ account: state.account, valid: true, scopes }],
  }));
  process.exit(0);
}
if (args[0] === "contacts" && args[1] === "list") {
  if ((b.listExit ?? 0) !== 0) process.exit(b.listExit);
  process.stdout.write(JSON.stringify({ contacts: state.contacts, nextPageToken: null }));
  process.exit(0);
}
if (args[0] === "contacts" && args[1] === "batch" && args[2] === "get") {
  state.batchGetCount = (state.batchGetCount ?? 0) + 1;
  save();
  if (state.batchGetCount > 1 && (b.postReadBackExit ?? 0) !== 0) {
    process.exit(b.postReadBackExit);
  }
  if ((b.batchGetExit ?? 0) !== 0) process.exit(b.batchGetExit);
  const requested = args.slice(3).filter((x) => x.startsWith("people/"));
  const found = state.contacts.filter((c) => requested.includes(c.resourceName));
  if (found.length === 0) process.exit(5);
  process.stdout.write(JSON.stringify({ responses: found.map((person) => ({ person })) }));
  process.exit(0);
}
if (args[0] === "contacts" && args[1] === "batch" && args[2] === "update") {
  const stdinText = await Bun.stdin.text();
  if (logPath) {
    const prev = JSON.parse(readFileSync(logPath, "utf8"));
    prev[prev.length - 1].stdin = stdinText;
    writeFileSync(logPath, JSON.stringify(prev), "utf8");
  }
  if ((b.updateDelayMs ?? 0) > 0) {
    await new Promise((r) => setTimeout(r, b.updateDelayMs));
  }
  if ((b.batchUpdateExit ?? 0) !== 0) process.exit(b.batchUpdateExit);
  const payload = JSON.parse(stdinText);
  if (b.mutateOnUpdate !== false) {
    for (const [rn, patch] of Object.entries(payload)) {
      const idx = state.contacts.findIndex((c) => c.resourceName === rn);
      if (idx === -1) process.exit(5);
      const cur = state.contacts[idx];
      if (patch.etag !== cur.etag) process.exit(1);
      const next = { ...cur, ...patch, etag: cur.etag + "-next" };
      state.contacts[idx] = next;
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
  readonly statePath: string;
  readonly logPath: string;
  readonly readLog: () => readonly StubLogEntry[];
  readonly readState: () => StubStateFile;
} {
  const binPath = join(folder, "gog-stub");
  const statePath = join(folder, "gog-state.json");
  const logPath = join(folder, "gog-log.json");
  writeFileSync(statePath, JSON.stringify(initial), "utf8");
  writeFileSync(logPath, "[]", "utf8");
  writeFileSync(
    binPath,
    `#!${process.execPath}\nconst statePath = ${JSON.stringify(statePath)};\nconst logPath = ${JSON.stringify(logPath)};\n${STUB_GOG_BODY}`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  return {
    binPath,
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
