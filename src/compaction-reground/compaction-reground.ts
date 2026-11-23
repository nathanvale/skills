import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const ROSTER_DIRECTORY_VARIABLE = "COORDINATOR_ROSTER_DIR";
const ROSTER_HEAD_BYTES = 256;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COORDINATOR_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function regroundText(folder: string | null): string {
  return [
    `Coordinator reground: your context was just compacted. This session is registered as a kernel-split coordinator${folder === null ? "" : ` (${folder})`}.`,
    "",
    "Do no merge, push, post or other gated act until all four steps are done:",
    "1. Reread ~/.local/state/kernel-split/STANDING-ORDERS.md and ~/.local/state/kernel-split/WORKING-INSTRUCTIONS.md in full.",
    `2. Reread your own unit state in ${folder === null ? "your coordinator folder under ~/.local/state/kernel-split/" : `~/.local/state/kernel-split/${folder}/`} and the last rows of its decisions.tsv.`,
    "3. Confirm each unit against GitHub and git. The summary above is a note, not proof.",
    "4. Send the Super Coordinator one message with your rules version and each unit's state.",
  ].join("\n");
}

function rosterDirectory(): string | null {
  const override = process.env[ROSTER_DIRECTORY_VARIABLE];

  if (override) {
    return isAbsolute(override) ? override : null;
  }

  const home = process.env.HOME;

  if (!home) {
    return null;
  }

  const fallback = join(home, ".local/state/kernel-split/coordinator-roster");

  return isAbsolute(fallback) ? fallback : null;
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
  const directory = rosterDirectory();
  const sessionId = rosteredSessionId(rawInput);

  if (!directory || !sessionId) {
    return null;
  }

  const entry = join(directory, sessionId);

  if (!lstatSync(entry).isFile()) {
    return null;
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: regroundText(coordinatorFolder(entry)),
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
