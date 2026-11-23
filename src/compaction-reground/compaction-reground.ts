import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const STATE_FOLDER_VARIABLE = "COORDINATION_STATE_DIR";
const STATE_FOLDER_SEGMENTS = ["my-agent-dojo", "agent-coordination"];
const STATE_FOLDER_MAX_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const ROSTER_FOLDER_NAME = "coordinator-roster";
const ROSTER_HEAD_BYTES = 256;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COORDINATOR_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPER_COORDINATOR_FOLDER = "super-coordinator";

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

function rosteredSessionId(raw: string): string | null {
  const input: unknown = JSON.parse(raw);

  if (!isJsonObject(input)) {
    return null;
  }
  if (input.hook_event_name !== "SessionStart" || input.source !== "compact") {
    return null;
  }
  if (
    input.agent_id !== undefined &&
    input.agent_id !== null &&
    input.agent_id !== ""
  ) {
    return null;
  }
  if (
    typeof input.transcript_path === "string" &&
    input.transcript_path.includes("/subagents/")
  ) {
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

function readRosterHead(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const head = Buffer.alloc(ROSTER_HEAD_BYTES);
    const length = readSync(descriptor, head, 0, ROSTER_HEAD_BYTES, 0);
    return head.toString("utf8", 0, length);
  } finally {
    closeSync(descriptor);
  }
}

function coordinatorFolder(path: string): string | null {
  const first = (readRosterHead(path).split("\n")[0] ?? "").trim();

  return COORDINATOR_FOLDER_PATTERN.test(first) ? first : null;
}

function regroundHookOutputLine(rawInput: string): string | null {
  const state = stateFolder();
  const sessionId = rosteredSessionId(rawInput);

  if (!state || !sessionId) {
    return null;
  }

  const entry = join(state, ROSTER_FOLDER_NAME, sessionId);

  if (!lstatSync(entry).isFile()) {
    return null;
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: regroundText(state, coordinatorFolder(entry)),
    },
  });
}

try {
  const line = regroundHookOutputLine(await Bun.stdin.text());

  if (line !== null) {
    process.stdout.write(`${line}\n`);
  }
} catch {
  process.exit(0);
}
