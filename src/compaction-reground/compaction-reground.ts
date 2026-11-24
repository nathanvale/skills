import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const STATE_FOLDER_SEGMENTS = ["my-agent-dojo", "agent-coordination"];
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const ROSTER_FOLDER_NAME = "coordinator-roster";
const CURSOR_FOLDER_NAME = "compaction-cursors";
const ROSTER_HEAD_BYTES = 256;
const CURSOR_HEAD_BYTES = 512;
const CURSOR_TAIL_BYTES = 32;
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COORDINATOR_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAIL_HEX_PATTERN = /^[0-9a-f]{0,64}$/;
const ANTIGRAVITY_EMPTY_OUTPUT = "{}";

interface CompactionCursor {
  lastCheckpointStep: number;
  lastScannedBytes: number;
  tailHex: string;
}

interface ScanAccumulator {
  maxCheckpointStep: number;
  consumedBytes: number;
}

interface AntigravityRequest {
  conversationId: string;
  transcriptPath: string;
}

const EMPTY_CURSOR: CompactionCursor = {
  lastCheckpointStep: -1,
  lastScannedBytes: 0,
  tailHex: "",
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
    `1. Reread the standing orders and the working instructions in ${stateFolder} in full.`,
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
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome && isAbsolute(xdgStateHome)) {
    return join(xdgStateHome, ...STATE_FOLDER_SEGMENTS);
  }
  const home = process.env.HOME;
  if (home && isAbsolute(home)) {
    return join(home, ".local", "state", ...STATE_FOLDER_SEGMENTS);
  }
  return null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function regularFileSize(path: string): number | null {
  try {
    const info = lstatSync(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

function isUsableEntry(path: string, kind: "directory" | "file"): boolean {
  try {
    const info = lstatSync(path);
    return kind === "directory" ? info.isDirectory() : info.isFile();
  } catch (error: unknown) {
    return isJsonObject(error) && error.code === "ENOENT";
  }
}

function isSafeIntegerAtLeast(
  value: unknown,
  minimum: number,
): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function readSlice(path: string, offset: number, length: number): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function readTailHex(path: string, endOffset: number): string | null {
  if (endOffset <= 0) {
    return "";
  }
  const length = Math.min(CURSOR_TAIL_BYTES, endOffset);
  const slice = readSlice(path, endOffset - length, length);
  return slice.length === length ? slice.toString("hex") : null;
}

function coordinatorFolder(path: string): string | null {
  const head = readSlice(path, 0, ROSTER_HEAD_BYTES).toString("utf8");
  const first = (head.split("\n")[0] ?? "").trim();
  return COORDINATOR_FOLDER_PATTERN.test(first) ? first : null;
}

function hasSubagentMarker(input: Record<string, unknown>): boolean {
  const hasAgentId =
    input.agent_id !== undefined &&
    input.agent_id !== null &&
    input.agent_id !== "";
  return (
    hasAgentId ||
    (typeof input.transcript_path === "string" &&
      input.transcript_path.includes("/subagents/"))
  );
}

function claudeSessionId(input: Record<string, unknown>): string | null {
  if (
    input.hook_event_name !== "SessionStart" ||
    input.source !== "compact" ||
    hasSubagentMarker(input) ||
    typeof input.session_id !== "string" ||
    !SESSION_ID_PATTERN.test(input.session_id)
  ) {
    return null;
  }
  return input.session_id;
}

function antigravityRequest(
  input: Record<string, unknown>,
): AntigravityRequest | null {
  if (
    input.hookEventName !== "PreInvocation" ||
    typeof input.conversationId !== "string" ||
    !SESSION_ID_PATTERN.test(input.conversationId) ||
    typeof input.transcriptPath !== "string" ||
    !isAbsolute(input.transcriptPath) ||
    input.transcriptPath.includes("/subagents/")
  ) {
    return null;
  }
  return {
    conversationId: input.conversationId,
    transcriptPath: input.transcriptPath,
  };
}

function validTailHex(value: unknown, bytes: number): string {
  const expected = Math.min(CURSOR_TAIL_BYTES, bytes) * 2;
  return typeof value === "string" &&
    value.length === expected &&
    TAIL_HEX_PATTERN.test(value)
    ? value
    : "";
}

function readCursor(path: string): CompactionCursor {
  if (regularFileSize(path) === null) {
    return EMPTY_CURSOR;
  }
  try {
    const raw = readSlice(path, 0, CURSOR_HEAD_BYTES).toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
      return EMPTY_CURSOR;
    }
    const step = parsed.lastCheckpointStep;
    const bytes = parsed.lastScannedBytes;
    if (!isSafeIntegerAtLeast(step, -1) || !isSafeIntegerAtLeast(bytes, 0)) {
      return EMPTY_CURSOR;
    }
    return {
      lastCheckpointStep: step,
      lastScannedBytes: bytes,
      tailHex: validTailHex(parsed.tailHex, bytes),
    };
  } catch {
    return EMPTY_CURSOR;
  }
}

function cleanupStaging(staging: string): void {
  try {
    unlinkSync(staging);
  } catch {
    return;
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
  let createdStaging = false;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(staging, `${JSON.stringify(cursor)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    createdStaging = true;
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
    const parsed: unknown = JSON.parse(line);
    if (
      !isJsonObject(parsed) ||
      parsed.type !== "CHECKPOINT" ||
      parsed.status !== "DONE" ||
      !isSafeIntegerAtLeast(parsed.step_index, 0)
    ) {
      return -1;
    }
    return parsed.step_index;
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
  if (fileSize < cursor.lastScannedBytes) {
    return true;
  }
  if (cursor.lastScannedBytes === 0) {
    return false;
  }
  return readTailHex(path, cursor.lastScannedBytes) !== cursor.tailHex;
}

function cursorsEqual(a: CompactionCursor, b: CompactionCursor): boolean {
  return (
    a.lastCheckpointStep === b.lastCheckpointStep &&
    a.lastScannedBytes === b.lastScannedBytes &&
    a.tailHex === b.tailHex
  );
}

function antigravityOutput(state: string, request: AntigravityRequest): string {
  const entry = join(state, ROSTER_FOLDER_NAME, request.conversationId);
  if (regularFileSize(entry) === null) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }
  const fileSize = regularFileSize(request.transcriptPath);
  const cursorFolder = join(state, CURSOR_FOLDER_NAME);
  const cursorPath = join(cursorFolder, request.conversationId);
  if (
    fileSize === null ||
    !isUsableEntry(cursorFolder, "directory") ||
    !isUsableEntry(cursorPath, "file")
  ) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const cursor = readCursor(cursorPath);
  const rewound = isTranscriptRewound(request.transcriptPath, fileSize, cursor);
  if (!rewound && fileSize === cursor.lastScannedBytes) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const scan = scanTranscriptFromOffset(
    request.transcriptPath,
    rewound ? 0 : cursor.lastScannedBytes,
    fileSize,
  );
  const nextTailHex = readTailHex(request.transcriptPath, scan.consumedBytes);
  if (nextTailHex === null) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const shouldFire =
    !rewound && scan.maxCheckpointStep > cursor.lastCheckpointStep;
  const nextCursor: CompactionCursor = {
    lastCheckpointStep:
      rewound || shouldFire
        ? scan.maxCheckpointStep
        : cursor.lastCheckpointStep,
    lastScannedBytes: scan.consumedBytes,
    tailHex: nextTailHex,
  };
  if (
    !cursorsEqual(cursor, nextCursor) &&
    !writeCursor(cursorFolder, request.conversationId, nextCursor)
  ) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }
  if (!shouldFire) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const systemMessage = regroundText(state, coordinatorFolder(entry));
  return JSON.stringify({
    injectSteps: [{ systemMessage: { systemMessage } }],
  });
}

function claudeOutput(state: string, sessionId: string): string | null {
  const entry = join(state, ROSTER_FOLDER_NAME, sessionId);
  if (regularFileSize(entry) === null) {
    return null;
  }
  const additionalContext = regroundText(state, coordinatorFolder(entry));
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  });
}

function regroundHookOutputLine(
  rawInput: string,
  antigravityFlag: boolean,
): string | null {
  const input: unknown = JSON.parse(rawInput);
  if (!isJsonObject(input)) {
    return antigravityFlag ? ANTIGRAVITY_EMPTY_OUTPUT : null;
  }

  const isAntigravity =
    antigravityFlag ||
    typeof input.hookEventName === "string" ||
    typeof input.conversationId === "string";
  const state = stateFolder();
  if (!state) {
    return isAntigravity ? ANTIGRAVITY_EMPTY_OUTPUT : null;
  }

  const agyRequest = antigravityRequest(input);
  if (agyRequest) {
    return antigravityOutput(state, agyRequest);
  }
  if (isAntigravity) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
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
