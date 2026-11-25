import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  readRootedFile,
  type RootedFileResult,
} from "agent-cli-kernel/rooted-file";
import { xdgBaseFolder } from "agent-cli-kernel/xdg-base";

const STATE_FOLDER_SEGMENTS = ["my-agent-dojo", "agent-coordination"];
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const ROSTER_FOLDER_NAME = "coordinator-roster";
const CURSOR_FOLDER_NAME = "compaction-cursors";
const ROSTER_BYTE_LIMIT = 1024;
const CURSOR_HEAD_BYTES = 512;
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COORDINATOR_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PREFIX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ANTIGRAVITY_EMPTY_OUTPUT = "{}";

interface CompactionCursor {
  lastCheckpointStep: number;
  lastScannedBytes: number;
  prefixSha256: string;
}

interface ScanAccumulator {
  maxCheckpointStep: number;
  consumedBytes: number;
}

interface AntigravityRequest {
  conversationId: string;
  transcriptPath: string;
}

type RosterEntry = { folder: string | null };

const EMPTY_CURSOR: CompactionCursor = {
  lastCheckpointStep: -1,
  lastScannedBytes: 0,
  prefixSha256: "",
};

function regroundText(stateFolder: string, folder: string | null): string {
  const [registration, unitState] =
    folder === null
      ? ["", `your coordinator folder under ${stateFolder}/`]
      : [` (${folder})`, `${stateFolder}/${folder}/`];
  const step4 =
    folder === "super-coordinator"
      ? "4. Write your rules version and each unit's state in STATE.md."
      : "4. Send the Super Coordinator one message with your rules version and each unit's state.";

  return [
    `Coordinator reground: your context was just compacted. This session is registered as a coordinator${registration}.`,
    "",
    "Do no merge, push, post or other gated act until all four steps are done:",
    `1. Reread STANDING-ORDERS.md and WORKING-INSTRUCTIONS.md in ${stateFolder} in full, and state the map's version you read. Before any merge ruling or merge, read rules/merging.md.`,
    `2. Reread your own unit state in ${unitState} and the last rows of its decisions.tsv.`,
    "3. Confirm each unit against GitHub and git. The summary above is a note, not proof.",
    step4,
    "If a message arrives before step 4, say in one line that you are regrounding, finish steps 1 and 2, then act on it.",
  ].join("\n");
}

function isUsableStateFolder(path: string): boolean {
  return (
    isAbsolute(path) &&
    path.length <= 256 &&
    !CONTROL_CHARACTER_PATTERN.test(path)
  );
}

function stateFolder(): string | null {
  const chosen = process.env.COORDINATION_STATE_DIR;
  if (chosen) {
    return isUsableStateFolder(chosen) ? resolve(chosen) : null;
  }
  const base = xdgBaseFolder(process.env, "state");
  return base === undefined ? null : join(base, ...STATE_FOLDER_SEGMENTS);
}

function asJsonObject(value: unknown): object | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function regularFileSize(path: string): number | null {
  try {
    const info = lstatSync(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

function safeIntegerAtLeast(value: unknown, minimum: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function sha256Prefix(path: string, byteCount: number): string | null {
  if (byteCount === 0) {
    return "";
  }
  const fd = openSync(path, "r");
  const hasher = new Bun.CryptoHasher("sha256");
  const chunk = Buffer.alloc(Math.min(TRANSCRIPT_CHUNK_BYTES, byteCount));
  let totalRead = 0;
  try {
    while (totalRead < byteCount) {
      const toRead = Math.min(chunk.length, byteCount - totalRead);
      const bytesRead = readSync(fd, chunk, 0, toRead, totalRead);
      if (bytesRead <= 0) {
        break;
      }
      hasher.update(chunk.subarray(0, bytesRead));
      totalRead += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return totalRead === byteCount ? hasher.digest("hex") : null;
}

function readRootedOrNull(
  state: string,
  relativePath: string,
  limitBytes: number,
): RootedFileResult | null {
  try {
    return readRootedFile(state, relativePath, limitBytes);
  } catch {
    return null;
  }
}

function readRosterEntry(state: string, sessionId: string): RosterEntry | null {
  const result = readRootedOrNull(
    state,
    join(ROSTER_FOLDER_NAME, sessionId),
    ROSTER_BYTE_LIMIT,
  );
  if (result?.kind !== "read") return null;
  const head = Buffer.from(result.bytes).toString("utf8");
  const first = (head.split("\n")[0] ?? "").trim();
  return { folder: COORDINATOR_FOLDER_PATTERN.test(first) ? first : null };
}

function hasSubagentMarker(input: object): boolean {
  const agentId: unknown = Reflect.get(input, "agent_id");
  const transcriptPath: unknown = Reflect.get(input, "transcript_path");
  return (
    (agentId !== undefined && agentId !== null && agentId !== "") ||
    (typeof transcriptPath === "string" &&
      transcriptPath.includes("/subagents/"))
  );
}

function claudeSessionId(input: object): string | null {
  const sessionId: unknown = Reflect.get(input, "session_id");
  if (
    Reflect.get(input, "hook_event_name") !== "SessionStart" ||
    Reflect.get(input, "source") !== "compact" ||
    hasSubagentMarker(input) ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) {
    return null;
  }
  return sessionId;
}

function antigravityRequest(input: object): AntigravityRequest | null {
  const conversationId: unknown = Reflect.get(input, "conversationId");
  const transcriptPath: unknown = Reflect.get(input, "transcriptPath");
  if (
    Reflect.get(input, "hookEventName") !== "PreInvocation" ||
    typeof conversationId !== "string" ||
    !SESSION_ID_PATTERN.test(conversationId) ||
    typeof transcriptPath !== "string" ||
    !isAbsolute(transcriptPath) ||
    transcriptPath.includes("/subagents/")
  ) {
    return null;
  }
  return { conversationId, transcriptPath };
}

function validPrefixSha256(value: unknown, bytes: number): string {
  return bytes > 0 &&
    typeof value === "string" &&
    PREFIX_SHA256_PATTERN.test(value)
    ? value
    : "";
}

function parseCursorBytes(bytes: Uint8Array): CompactionCursor {
  try {
    const raw = Buffer.from(bytes).toString("utf8");
    const parsed = asJsonObject(JSON.parse(raw));
    if (parsed === null) return EMPTY_CURSOR;
    const step = safeIntegerAtLeast(
      Reflect.get(parsed, "lastCheckpointStep"),
      -1,
    );
    const scanned = safeIntegerAtLeast(
      Reflect.get(parsed, "lastScannedBytes"),
      0,
    );
    if (step === null || scanned === null) return EMPTY_CURSOR;
    return {
      lastCheckpointStep: step,
      lastScannedBytes: scanned,
      prefixSha256: validPrefixSha256(
        Reflect.get(parsed, "prefixSha256"),
        scanned,
      ),
    };
  } catch {
    return EMPTY_CURSOR;
  }
}

function readCursor(
  state: string,
  conversationId: string,
): CompactionCursor | null {
  const result = readRootedOrNull(
    state,
    join(CURSOR_FOLDER_NAME, conversationId),
    CURSOR_HEAD_BYTES,
  );
  if (result === null || result.kind === "refused") return null;
  return result.kind === "missing"
    ? EMPTY_CURSOR
    : parseCursorBytes(result.bytes);
}

function cleanupStaging(staging: string): void {
  try {
    unlinkSync(staging);
  } catch {
    return;
  }
}

function tightenFolderMode(folder: string): void {
  const mode = lstatSync(folder).mode & 0o777;
  if ((mode & 0o200) !== 0 && (mode & 0o077) !== 0) {
    chmodSync(folder, mode & 0o700);
  }
}

function writeCursor(
  folder: string,
  conversationId: string,
  cursor: CompactionCursor,
): boolean {
  const target = join(folder, conversationId);
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const staging = join(folder, `.${conversationId}.${nonce}.tmp`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  let createdStaging = false;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    tightenFolderMode(folder);
    const payload = Buffer.from(`${JSON.stringify(cursor)}\n`);
    const fd = openSync(staging, flags, 0o600);
    createdStaging = true;
    try {
      if (writeSync(fd, payload, 0, payload.length) !== payload.length) {
        throw new Error("Short cursor write");
      }
    } finally {
      closeSync(fd);
    }
    renameSync(staging, target);
    return true;
  } catch {
    if (createdStaging) {
      cleanupStaging(staging);
    }
    return false;
  }
}

function checkpointStepFromLine(line: string): number {
  if (!line.includes('"CHECKPOINT"')) {
    return -1;
  }
  try {
    const parsed = asJsonObject(JSON.parse(line));
    if (
      parsed === null ||
      Reflect.get(parsed, "type") !== "CHECKPOINT" ||
      Reflect.get(parsed, "status") !== "DONE"
    ) {
      return -1;
    }
    return safeIntegerAtLeast(Reflect.get(parsed, "step_index"), 0) ?? -1;
  } catch {
    return -1;
  }
}

function scanBufferLines(combined: Buffer, acc: ScanAccumulator): number {
  let lineStart = 0;
  while (lineStart < combined.length) {
    const newlineIndex = combined.indexOf(0x0a, lineStart);
    if (newlineIndex === -1) {
      break;
    }
    const line = combined.subarray(lineStart, newlineIndex).toString("utf8");
    const step = checkpointStepFromLine(line);
    if (step > acc.maxCheckpointStep) {
      acc.maxCheckpointStep = step;
    }
    acc.consumedBytes += newlineIndex - lineStart + 1;
    lineStart = newlineIndex + 1;
  }
  return lineStart;
}

function scanTranscriptFromOffset(
  path: string,
  startOffset: number,
  fileSize: number,
): ScanAccumulator {
  const descriptor = openSync(path, "r");
  const acc: ScanAccumulator = {
    maxCheckpointStep: -1,
    consumedBytes: startOffset,
  };
  let offset = startOffset;
  let remainder = Buffer.alloc(0);
  const chunk = Buffer.alloc(TRANSCRIPT_CHUNK_BYTES);
  try {
    while (offset < fileSize) {
      const toRead = Math.min(TRANSCRIPT_CHUNK_BYTES, fileSize - offset);
      const bytesRead = readSync(descriptor, chunk, 0, toRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      const slice = chunk.subarray(0, bytesRead);
      const combined =
        remainder.length > 0 ? Buffer.concat([remainder, slice]) : slice;
      const lineStart = scanBufferLines(combined, acc);
      remainder =
        lineStart < combined.length
          ? Buffer.from(combined.subarray(lineStart))
          : Buffer.alloc(0);
    }
  } finally {
    closeSync(descriptor);
  }
  return acc;
}

function isTranscriptRewound(
  path: string,
  fileSize: number,
  cursor: CompactionCursor,
): boolean {
  return (
    fileSize < cursor.lastScannedBytes ||
    (cursor.lastScannedBytes > 0 &&
      sha256Prefix(path, cursor.lastScannedBytes) !== cursor.prefixSha256)
  );
}

function cursorsEqual(a: CompactionCursor, b: CompactionCursor): boolean {
  return (
    a.lastCheckpointStep === b.lastCheckpointStep &&
    a.lastScannedBytes === b.lastScannedBytes &&
    a.prefixSha256 === b.prefixSha256
  );
}

function antigravityOutput(state: string, request: AntigravityRequest): string {
  const { conversationId, transcriptPath } = request;
  const roster = readRosterEntry(state, conversationId);
  if (roster === null) return ANTIGRAVITY_EMPTY_OUTPUT;
  const fileSize = regularFileSize(transcriptPath);
  if (fileSize === null) return ANTIGRAVITY_EMPTY_OUTPUT;
  const cursor = readCursor(state, conversationId);
  if (cursor === null) return ANTIGRAVITY_EMPTY_OUTPUT;

  const rewound = isTranscriptRewound(transcriptPath, fileSize, cursor);
  if (!rewound && fileSize === cursor.lastScannedBytes) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const startOffset = rewound ? 0 : cursor.lastScannedBytes;
  const scan = scanTranscriptFromOffset(transcriptPath, startOffset, fileSize);
  const nextPrefixSha256 = sha256Prefix(transcriptPath, scan.consumedBytes);
  if (nextPrefixSha256 === null) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const shouldFire =
    !rewound && scan.maxCheckpointStep > cursor.lastCheckpointStep;
  const systemMessage = shouldFire ? regroundText(state, roster.folder) : null;
  const nextCursor: CompactionCursor = {
    lastCheckpointStep:
      rewound || shouldFire
        ? scan.maxCheckpointStep
        : cursor.lastCheckpointStep,
    lastScannedBytes: scan.consumedBytes,
    prefixSha256: nextPrefixSha256,
  };
  const cursorFolder = join(state, CURSOR_FOLDER_NAME);
  if (
    !cursorsEqual(cursor, nextCursor) &&
    !writeCursor(cursorFolder, conversationId, nextCursor)
  ) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }
  return systemMessage === null
    ? ANTIGRAVITY_EMPTY_OUTPUT
    : JSON.stringify({
        injectSteps: [{ systemMessage: { systemMessage } }],
      });
}

function claudeOutput(state: string, sessionId: string): string | null {
  const roster = readRosterEntry(state, sessionId);
  if (roster === null) {
    return null;
  }
  const additionalContext = regroundText(state, roster.folder);
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  });
}

function regroundHookOutputLine(
  rawInput: string,
  antigravityFlag: boolean,
): string | null {
  const input = asJsonObject(JSON.parse(rawInput));
  if (input === null) {
    return antigravityFlag ? ANTIGRAVITY_EMPTY_OUTPUT : null;
  }

  const isAntigravity =
    antigravityFlag ||
    typeof Reflect.get(input, "hookEventName") === "string" ||
    typeof Reflect.get(input, "conversationId") === "string";
  const state = stateFolder();
  if (!state) {
    return isAntigravity ? ANTIGRAVITY_EMPTY_OUTPUT : null;
  }

  const agyRequest = antigravityRequest(input);
  if (agyRequest || isAntigravity) {
    return agyRequest
      ? antigravityOutput(state, agyRequest)
      : ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const sessionId = claudeSessionId(input);
  return sessionId ? claudeOutput(state, sessionId) : null;
}

const antigravityFlag = process.argv.includes("--antigravity");

try {
  const line = regroundHookOutputLine(await Bun.stdin.text(), antigravityFlag);
  if (line !== null) {
    process.stdout.write(`${line}\n`);
  }
} catch {
  if (antigravityFlag) {
    process.stdout.write(`${ANTIGRAVITY_EMPTY_OUTPUT}\n`);
  }
  process.exit(0);
}
