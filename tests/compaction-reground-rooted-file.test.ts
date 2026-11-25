import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { testFolder } from "./support/test-folder.ts";

interface ProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  stateDir: string;
  transcriptFile: string;
}

const repoRoot = join(import.meta.dir, "..");
const shellBin = "/bin/sh";
const bunDir = dirname(process.execPath);
const wrapperPath = join(
  repoRoot,
  "hooks",
  "coordinator",
  "compaction-reground.sh",
);
const CONVERSATION_ID = "cccccccc-dddd-4eee-8fff-111111111111";
const OTHER_ID = "22222222-3333-4444-8555-666666666666";
const COORDINATOR_NAME = "skills-coordinator";
const createdFolders: string[] = [];

afterEach(() => {
  while (createdFolders.length > 0) {
    const folder = createdFolders.pop();
    if (folder) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

function freshDir(): string {
  const folder = testFolder("reground-rooted-");
  createdFolders.push(folder);
  return folder;
}

function userStep(stepIndex: number): string {
  return `${JSON.stringify({ step_index: stepIndex, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: `turn ${stepIndex}` })}\n`;
}

function checkpointStep(stepIndex: number): string {
  return `${JSON.stringify({ step_index: stepIndex, type: "CHECKPOINT", source: "SYSTEM", status: "DONE", content: "# Resuming from a compaction" })}\n`;
}

function createFixture(rostered: boolean = true): Fixture {
  const root = freshDir();
  const stateDir = join(root, "state");
  const transcriptFile = join(
    root,
    "brain",
    CONVERSATION_ID,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  mkdirSync(dirname(transcriptFile), { recursive: true });
  writeFileSync(transcriptFile, userStep(0));
  if (rostered) {
    const rosterDir = join(stateDir, "coordinator-roster");
    mkdirSync(rosterDir, { recursive: true });
    writeFileSync(join(rosterDir, CONVERSATION_ID), `${COORDINATOR_NAME}\n`);
  }
  return { stateDir, transcriptFile };
}

function runWrapper(
  stdin: string,
  env: Record<string, string>,
  args: string[],
): ProcessOutput {
  const child = Bun.spawnSync(args, {
    cwd: repoRoot,
    env: { PATH: bunDir, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode ?? -1,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

function claudePayload(transcriptPath: string): string {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: CONVERSATION_ID,
    transcript_path: transcriptPath,
  });
}

function agyPayload(transcriptPath: string): string {
  return JSON.stringify({
    hookEventName: "PreInvocation",
    conversationId: CONVERSATION_ID,
    transcriptPath,
    invocationNum: 0,
  });
}

describe("compaction reground rooted-file guards", () => {
  test("treats a symbolic-link roster entry as not usable on Claude", () => {
    const { stateDir, transcriptFile } = createFixture(false);
    const rosterDir = join(stateDir, "coordinator-roster");
    mkdirSync(rosterDir, { recursive: true });
    const realEntry = join(rosterDir, OTHER_ID);
    writeFileSync(realEntry, `${COORDINATOR_NAME}\n`);
    symlinkSync(realEntry, join(rosterDir, CONVERSATION_ID));

    const result = runWrapper(
      claudePayload(transcriptFile),
      { COORDINATION_STATE_DIR: stateDir },
      [shellBin, wrapperPath],
    );
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("treats a symbolic-link coordinator-roster folder as not usable on Claude", () => {
    const { stateDir, transcriptFile } = createFixture(false);
    const externalRoster = freshDir();
    writeFileSync(
      join(externalRoster, CONVERSATION_ID),
      `${COORDINATOR_NAME}\n`,
    );
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(externalRoster, join(stateDir, "coordinator-roster"));

    const result = runWrapper(
      claudePayload(transcriptFile),
      { COORDINATION_STATE_DIR: stateDir },
      [shellBin, wrapperPath],
    );
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("treats a hard-linked roster entry as not usable on Claude", () => {
    const { stateDir, transcriptFile } = createFixture(false);
    const rosterDir = join(stateDir, "coordinator-roster");
    mkdirSync(rosterDir, { recursive: true });
    const otherFile = join(freshDir(), "shared-roster");
    writeFileSync(otherFile, `${COORDINATOR_NAME}\n`);
    linkSync(otherFile, join(rosterDir, CONVERSATION_ID));

    const result = runWrapper(
      claudePayload(transcriptFile),
      { COORDINATION_STATE_DIR: stateDir },
      [shellBin, wrapperPath],
    );
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("treats a hard-linked roster entry as not usable on Antigravity without writing a cursor", () => {
    const { stateDir, transcriptFile } = createFixture(false);
    appendFileSync(transcriptFile, checkpointStep(2));
    const rosterDir = join(stateDir, "coordinator-roster");
    mkdirSync(rosterDir, { recursive: true });
    const otherFile = join(freshDir(), "shared-roster");
    writeFileSync(otherFile, `${COORDINATOR_NAME}\n`);
    linkSync(otherFile, join(rosterDir, CONVERSATION_ID));

    const result = runWrapper(
      agyPayload(transcriptFile),
      { COORDINATION_STATE_DIR: stateDir },
      [shellBin, wrapperPath, "--antigravity"],
    );
    expect(result).toEqual({ exitCode: 0, stdout: "{}\n", stderr: "" });
    expect(existsSync(join(stateDir, "compaction-cursors"))).toBe(false);
  });

  test("treats a hard-linked cursor file as not usable on Antigravity without emitting a note or writing", () => {
    const { stateDir, transcriptFile } = createFixture(true);
    appendFileSync(transcriptFile, checkpointStep(2));
    const cursorsDir = join(stateDir, "compaction-cursors");
    mkdirSync(cursorsDir, { recursive: true });
    const outsideTarget = join(freshDir(), "cursor-original");
    const initialContent = `${JSON.stringify({ lastCheckpointStep: -1, lastScannedBytes: 0, prefixSha256: "" })}\n`;
    writeFileSync(outsideTarget, initialContent);
    const cursorPath = join(cursorsDir, CONVERSATION_ID);
    linkSync(outsideTarget, cursorPath);
    const originalIno = lstatSync(outsideTarget).ino;

    const result = runWrapper(
      agyPayload(transcriptFile),
      { COORDINATION_STATE_DIR: stateDir },
      [shellBin, wrapperPath, "--antigravity"],
    );
    expect(result).toEqual({ exitCode: 0, stdout: "{}\n", stderr: "" });
    expect(readFileSync(outsideTarget, "utf8")).toBe(initialContent);
    expect(lstatSync(cursorPath).ino).toBe(originalIno);
  });
});
