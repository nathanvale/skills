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

const STATE_FOLDER_VARIABLE = "COORDINATION_STATE_DIR";
const STATE_FOLDER_SEGMENTS = ["my-agent-dojo", "agent-coordination"];
const STATE_FOLDER_MAX_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const ROSTER_FOLDER_NAME = "coordinator-roster";
const CURSOR_FOLDER_NAME = "compaction-cursors";
const ROSTER_HEAD_BYTES = 256;
const CURSOR_HEAD_BYTES = 256;
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COORDINATOR_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPER_COORDINATOR_FOLDER = "super-coordinator";
const ANTIGRAVITY_EMPTY_OUTPUT = "{}";
const CHECKPOINT_TOKEN = '"CHECKPOINT"';
const NEWLINE_BYTE = 0x0a;

interface CompactionCursor {
  lastCheckpointStep: number;
  lastScannedBytes: number;
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
};

function reportStep(folder: string | null): string {
  return folder === SUPER_COORDINATOR_FOLDER
    ? "4. Write your rules version and each unit's state in STATE.md."
    : "4. Send the Super Coordinator one message with your rules version and each unit's state.";
}

function regroundText(stateFolder: string, folder: string | null): string {
  const [registration, unitState] =
    folder === null
      ? ["", `your coordinator folder under ${stateFolder}/`]
      : [` (${folder})`, `${stateFolder}/${folder}/`];

  return [
    `Coordinator reground: your context was just compacted. This session is registered as a coordinator${registration}.`,
    "",
    "Do no merge, push, post or other gated act until all four steps are done:",
    `1. Reread the standing orders and the working instructions in ${stateFolder} in full.`,
    `2. Reread your own unit state in ${unitState} and the last rows of its decisions.tsv.`,
    "3. Confirm each unit against GitHub and git. The summary above is a note, not proof.",
    reportStep(folder),
    "If a message arrives before step 4, say in one line that you are regrounding, finish steps 1 and 2, then act on it.",
  ].join("\n");
}

function isUsableStateFolder(path: string): boolean {
  return (
    isAbsolute(path) &&
    path.length <= STATE_FOLDER_MAX_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(path)
  );
}

function stateFolder(): string | null {
  const chosen = process.env[STATE_FOLDER_VARIABLE];

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

function isNotFoundError(error: unknown): boolean {
  return isJsonObject(error) && error.code === "ENOENT";
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
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
    const matches = kind === "directory" ? info.isDirectory() : info.isFile();
    return matches && !info.isSymbolicLink();
  } catch (error: unknown) {
    return isNotFoundError(error);
  }
}

function isSafeIntegerAtLeast(
  value: unknown,
  minimum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= minimum
  );
}

function readHead(path: string, limit: number): string {
  const descriptor = openSync(path, "r");
  try {
    const head = Buffer.alloc(limit);
    const length = readSync(descriptor, head, 0, limit, 0);
    return head.toString("utf8", 0, length);
  } finally {
    closeSync(descriptor);
  }
}

function coordinatorFolder(path: string): string | null {
  const first = (readHead(path, ROSTER_HEAD_BYTES).split("\n")[0] ?? "").trim();

  return COORDINATOR_FOLDER_PATTERN.test(first) ? first : null;
}

function hasSubagentMarker(input: Record<string, unknown>): boolean {
  const hasAgentId =
    input.agent_id !== undefined &&
    input.agent_id !== null &&
    input.agent_id !== "";
  const hasSubagentPath =
    typeof input.transcript_path === "string" &&
    input.transcript_path.includes("/subagents/");

  return hasAgentId || hasSubagentPath;
}

function claudeSessionId(input: Record<string, unknown>): string | null {
  if (input.hook_event_name !== "SessionStart" || input.source !== "compact") {
    return null;
  }
  if (hasSubagentMarker(input)) {
    return null;
  }
  if (
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
  if (input.hookEventName !== "PreInvocation") {
    return null;
  }
  if (
    typeof input.conversationId !== "string" ||
    !SESSION_ID_PATTERN.test(input.conversationId)
  ) {
    return null;
  }
  if (
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

function readCursor(path: string): CompactionCursor {
  if (!isRegularFile(path)) {
    return EMPTY_CURSOR;
  }
  try {
    const parsed: unknown = JSON.parse(readHead(path, CURSOR_HEAD_BYTES));
    if (!isJsonObject(parsed)) {
      return EMPTY_CURSOR;
    }
    const step = parsed.lastCheckpointStep;
    const bytes = parsed.lastScannedBytes;
    if (!isSafeIntegerAtLeast(step, -1) || !isSafeIntegerAtLeast(bytes, 0)) {
      return EMPTY_CURSOR;
    }
    return { lastCheckpointStep: step, lastScannedBytes: bytes };
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
): void {
  const target = join(folder, conversationId);
  mkdirSync(folder, { recursive: true });
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const staging = join(folder, `.${conversationId}.${nonce}.tmp`);
  try {
    writeFileSync(staging, `${JSON.stringify(cursor)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(staging, target);
  } catch {
    cleanupStaging(staging);
  }
}

function checkpointStepFromLine(line: string): number {
  if (!line.includes(CHECKPOINT_TOKEN)) {
    return -1;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed)) {
      return -1;
    }
    if (
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
    const newlineIndex = combined.indexOf(NEWLINE_BYTE, lineStart);
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

function resolveNextCheckpointStep(
  rewound: boolean,
  shouldFire: boolean,
  scannedStep: number,
  currentStep: number,
): number {
  if (rewound || shouldFire) {
    return scannedStep;
  }
  return currentStep;
}

function antigravityOutput(state: string, request: AntigravityRequest): string {
  const entry = join(state, ROSTER_FOLDER_NAME, request.conversationId);
  if (!isRegularFile(entry)) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }
  const fileSize = regularFileSize(request.transcriptPath);
  if (fileSize === null) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }
  const cursorFolder = join(state, CURSOR_FOLDER_NAME);
  const cursorPath = join(cursorFolder, request.conversationId);
  if (
    !isUsableEntry(cursorFolder, "directory") ||
    !isUsableEntry(cursorPath, "file")
  ) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const cursor = readCursor(cursorPath);
  if (fileSize === cursor.lastScannedBytes) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  const rewound = fileSize < cursor.lastScannedBytes;
  const startOffset = rewound ? 0 : cursor.lastScannedBytes;
  const scan = scanTranscriptFromOffset(
    request.transcriptPath,
    startOffset,
    fileSize,
  );

  const shouldFire = scan.maxCheckpointStep > cursor.lastCheckpointStep;
  const nextCheckpointStep = resolveNextCheckpointStep(
    rewound,
    shouldFire,
    scan.maxCheckpointStep,
    cursor.lastCheckpointStep,
  );

  if (
    nextCheckpointStep !== cursor.lastCheckpointStep ||
    scan.consumedBytes !== cursor.lastScannedBytes
  ) {
    writeCursor(cursorFolder, request.conversationId, {
      lastCheckpointStep: nextCheckpointStep,
      lastScannedBytes: scan.consumedBytes,
    });
  }

  if (!shouldFire) {
    return ANTIGRAVITY_EMPTY_OUTPUT;
  }

  return JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: regroundText(state, coordinatorFolder(entry)),
        },
      },
    ],
  });
}

function claudeOutput(state: string, sessionId: string): string | null {
  const entry = join(state, ROSTER_FOLDER_NAME, sessionId);
  if (!isRegularFile(entry)) {
    return null;
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: regroundText(state, coordinatorFolder(entry)),
    },
  });
}

function isAntigravityPayload(input: Record<string, unknown>): boolean {
  return (
    typeof input.hookEventName === "string" ||
    typeof input.conversationId === "string"
  );
}

function regroundHookOutputLine(
  rawInput: string,
  antigravityFlag: boolean,
): string | null {
  const input: unknown = JSON.parse(rawInput);

  if (!isJsonObject(input)) {
    return antigravityFlag ? ANTIGRAVITY_EMPTY_OUTPUT : null;
  }

  const isAntigravity = antigravityFlag || isAntigravityPayload(input);
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
  if (!sessionId) {
    return null;
  }

  return claudeOutput(state, sessionId);
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
