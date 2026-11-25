import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
const CONVERSATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
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
  const folder = testFolder("agy-reground-");
  createdFolders.push(folder);
  return folder;
}

function namedOracle(stateDir: string, folder: string): string {
  const step4 =
    folder === "super-coordinator"
      ? "4. Write your rules version and each unit's state in STATE.md."
      : "4. Send the Super Coordinator one message with your rules version and each unit's state.";
  return [
    `Coordinator reground: your context was just compacted. This session is registered as a coordinator (${folder}).`,
    "",
    "Do no merge, push, post or other gated act until all four steps are done:",
    `1. Reread STANDING-ORDERS.md and WORKING-INSTRUCTIONS.md in ${stateDir} in full, and state the map's version you read. Before any merge ruling or merge, read rules/merging.md.`,
    `2. Reread your own unit state in ${stateDir}/${folder}/ and the last rows of its decisions.tsv.`,
    "3. Confirm each unit against GitHub and git. The summary above is a note, not proof.",
    step4,
    "If a message arrives before step 4, say in one line that you are regrounding, finish steps 1 and 2, then act on it.",
  ].join("\n");
}

function userStep(stepIndex: number): string {
  return `${JSON.stringify({ step_index: stepIndex, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: `turn ${stepIndex}` })}\n`;
}

function checkpointStep(stepIndex: number, status: string = "DONE"): string {
  return `${JSON.stringify({ step_index: stepIndex, type: "CHECKPOINT", source: "SYSTEM", status, content: "# Resuming from a compaction" })}\n`;
}

function sha256Hex(data: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function createFixture(
  folderName: string | null = COORDINATOR_NAME,
  conversationId: string = CONVERSATION_ID,
): Fixture {
  const root = freshDir();
  const stateDir = join(root, "state");
  const transcriptFile = join(
    root,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  mkdirSync(dirname(transcriptFile), { recursive: true });
  writeFileSync(transcriptFile, userStep(0));
  if (folderName !== null) {
    const rosterDir = join(stateDir, "coordinator-roster");
    mkdirSync(rosterDir, { recursive: true });
    writeFileSync(join(rosterDir, conversationId), `${folderName}\n`);
  }
  return { stateDir, transcriptFile };
}

function agyPayload(
  transcriptPath: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    hookEventName: "PreInvocation",
    conversationId: CONVERSATION_ID,
    transcriptPath,
    invocationNum: 0,
    ...overrides,
  });
}

function agyEnv(
  stateDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    COORDINATION_STATE_DIR: stateDir,
    ANTIGRAVITY_CONVERSATION_ID: CONVERSATION_ID,
    ...extra,
  };
}

function invokeWrapper(
  stdin: string,
  env: Record<string, string>,
  args: string[] = [shellBin, wrapperPath, "--antigravity"],
  cwd: string = repoRoot,
): ProcessOutput {
  const child = Bun.spawnSync(args, {
    cwd,
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

function expectEmptyAgy(output: ProcessOutput): void {
  expect(output).toEqual({ exitCode: 0, stdout: "{}\n", stderr: "" });
}

function expectInjected(output: ProcessOutput, expectedText: string): void {
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout.endsWith("\n")).toBe(true);
  expect(JSON.parse(output.stdout)).toEqual({
    injectSteps: [{ systemMessage: { systemMessage: expectedText } }],
  });
}

function copyPluginReadOnly(): string {
  const dest = freshDir();
  const files = [
    "hooks.json",
    join("hooks", "coordinator", "compaction-reground.sh"),
    join("hooks", "coordinator", "dist", "compaction-reground.mjs"),
  ];
  for (const rel of files) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, rel), target);
    chmodSync(target, 0o644);
  }
  return dest;
}

function readPreInvocationHooks(hooksPath: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(hooksPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const entry: unknown = Reflect.get(parsed, "coordinator-compaction-reground");
  if (typeof entry !== "object" || entry === null) return undefined;
  return Reflect.get(entry, "PreInvocation");
}

describe("Antigravity root hooks.json and 0644 execution", () => {
  test("declares coordinator-compaction-reground PreInvocation command with timeout 5", () => {
    const hooksPath = join(repoRoot, "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    expect(readPreInvocationHooks(hooksPath)).toEqual([
      {
        type: "command",
        command:
          "/bin/sh ./hooks/coordinator/compaction-reground.sh --antigravity",
        timeout: 5,
      },
    ]);
  });

  test("executes declared command from a 0644 copied plugin root without executable bits", () => {
    const pluginRoot = copyPluginReadOnly();
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(4));
    const hooks = readPreInvocationHooks(join(pluginRoot, "hooks.json"));
    const first: unknown = Array.isArray(hooks) ? hooks[0] : undefined;
    const rawCommand: unknown =
      typeof first === "object" && first !== null
        ? Reflect.get(first, "command")
        : undefined;
    const command = typeof rawCommand === "string" ? rawCommand : "";
    const output = invokeWrapper(
      agyPayload(transcriptFile),
      agyEnv(stateDir, { PATH: `${bunDir}:/bin` }),
      [shellBin, "-c", command],
      pluginRoot,
    );
    expectInjected(output, namedOracle(stateDir, COORDINATOR_NAME));
  });
});

describe("Antigravity compaction detection and cursor lifecycle", () => {
  test("returns {} on a normal turn before any CHECKPOINT", () => {
    const { stateDir, transcriptFile } = createFixture();
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)));
  });

  test("fires once after DONE CHECKPOINT, writes 0600 cursor, and stays silent next turn", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(6));
    const env = agyEnv(stateDir);

    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), env),
      namedOracle(stateDir, COORDINATOR_NAME),
    );
    const cursorFile = join(stateDir, "compaction-cursors", CONVERSATION_ID);
    expect(lstatSync(cursorFile).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(transcriptFile);
    expect(JSON.parse(readFileSync(cursorFile, "utf8"))).toEqual({
      lastCheckpointStep: 6,
      lastScannedBytes: bytes.length,
      prefixSha256: sha256Hex(bytes),
    });

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    appendFileSync(transcriptFile, userStep(7));
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
  });

  test("fires again on a second CHECKPOINT and advances cursor", () => {
    const { stateDir, transcriptFile } = createFixture();
    const env = agyEnv(stateDir);

    appendFileSync(transcriptFile, checkpointStep(6));
    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), env),
      namedOracle(stateDir, COORDINATOR_NAME),
    );

    appendFileSync(transcriptFile, userStep(7) + checkpointStep(15));
    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), env),
      namedOracle(stateDir, COORDINATOR_NAME),
    );

    const cursorFile = join(stateDir, "compaction-cursors", CONVERSATION_ID);
    const bytes = readFileSync(transcriptFile);
    expect(JSON.parse(readFileSync(cursorFile, "utf8"))).toEqual({
      lastCheckpointStep: 15,
      lastScannedBytes: bytes.length,
      prefixSha256: sha256Hex(bytes),
    });
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
  });

  test.each(["RUNNING", "ERROR"])(
    "ignores non-DONE CHECKPOINT with status %s",
    (status) => {
      const { stateDir, transcriptFile } = createFixture();
      appendFileSync(transcriptFile, checkpointStep(5, status));
      expectEmptyAgy(
        invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)),
      );
    },
  );

  test("returns {} and creates no compaction-cursors folder for non-rostered conversations", () => {
    const { stateDir, transcriptFile } = createFixture(null);
    appendFileSync(transcriptFile, checkpointStep(6));
    mkdirSync(join(stateDir, "coordinator-roster"), { recursive: true });
    writeFileSync(
      join(stateDir, "coordinator-roster", OTHER_ID),
      `${COORDINATOR_NAME}\n`,
    );

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)));
    expectEmptyAgy(
      invokeWrapper(agyPayload(transcriptFile), {
        COORDINATION_STATE_DIR: stateDir,
      }),
    );
    expect(existsSync(join(stateDir, "compaction-cursors"))).toBe(false);
  });

  test("auto-detects Antigravity stdin without env var and supports super-coordinator step 4", () => {
    const { stateDir, transcriptFile } = createFixture("super-coordinator");
    appendFileSync(transcriptFile, checkpointStep(3));
    const output = invokeWrapper(
      agyPayload(transcriptFile),
      { COORDINATION_STATE_DIR: stateDir },
      [shellBin, wrapperPath],
    );
    expectInjected(output, namedOracle(stateDir, "super-coordinator"));
  });

  test("does not break Claude SessionStart when ANTIGRAVITY_CONVERSATION_ID is set in env", () => {
    const { stateDir, transcriptFile } = createFixture(
      COORDINATOR_NAME,
      CONVERSATION_ID,
    );
    const claudePayload = JSON.stringify({
      hook_event_name: "SessionStart",
      source: "compact",
      session_id: CONVERSATION_ID,
      transcript_path: transcriptFile,
    });
    const output = invokeWrapper(
      claudePayload,
      {
        COORDINATION_STATE_DIR: stateDir,
        ANTIGRAVITY_CONVERSATION_ID: OTHER_ID,
      },
      [shellBin, wrapperPath],
    );
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(JSON.parse(output.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: namedOracle(stateDir, COORDINATOR_NAME),
      },
    });
  });

  test("handles /rewind truncation without false re-fire, then fires on next CHECKPOINT", () => {
    const { stateDir, transcriptFile } = createFixture();
    const env = agyEnv(stateDir);
    const prefix = userStep(0) + checkpointStep(6) + userStep(7);
    writeFileSync(transcriptFile, prefix + userStep(8) + checkpointStep(14));
    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), env),
      namedOracle(stateDir, COORDINATOR_NAME),
    );

    writeFileSync(transcriptFile, prefix);
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));

    appendFileSync(transcriptFile, checkpointStep(10));
    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), env),
      namedOracle(stateDir, COORDINATOR_NAME),
    );
  });

  test("holds cursor before incomplete trailing line and fires once line finishes", () => {
    const { stateDir, transcriptFile } = createFixture();
    const env = agyEnv(stateDir);
    const fullLine = checkpointStep(9);
    const half = Math.floor(fullLine.length / 2);

    appendFileSync(transcriptFile, fullLine.slice(0, half));
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    appendFileSync(transcriptFile, fullLine.slice(half));
    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), env),
      namedOracle(stateDir, COORDINATOR_NAME),
    );
  });
});

describe("Antigravity security and fail-closed guards", () => {
  test("rejects /subagents/ transcript paths", () => {
    const { stateDir } = createFixture();
    const subagentFile = join(freshDir(), "subagents", "child.jsonl");
    mkdirSync(dirname(subagentFile), { recursive: true });
    writeFileSync(subagentFile, checkpointStep(2));
    expectEmptyAgy(invokeWrapper(agyPayload(subagentFile), agyEnv(stateDir)));
  });

  test("rejects symlink roster entries with and without env fast-path", () => {
    const { stateDir, transcriptFile } = createFixture(
      COORDINATOR_NAME,
      OTHER_ID,
    );
    appendFileSync(transcriptFile, checkpointStep(2));
    const rosterDir = join(stateDir, "coordinator-roster");
    symlinkSync(join(rosterDir, OTHER_ID), join(rosterDir, CONVERSATION_ID));

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)));
    expectEmptyAgy(
      invokeWrapper(agyPayload(transcriptFile), {
        COORDINATION_STATE_DIR: stateDir,
      }),
    );
  });

  test("rejects symlink transcript files", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(2));
    const linkPath = join(freshDir(), "linked.jsonl");
    symlinkSync(transcriptFile, linkPath);
    expectEmptyAgy(invokeWrapper(agyPayload(linkPath), agyEnv(stateDir)));
  });

  test("rejects symlink compaction-cursors directory without writing through it", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(2));
    const targetDir = freshDir();
    symlinkSync(targetDir, join(stateDir, "compaction-cursors"));

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)));
    expect(readdirSync(targetDir)).toEqual([]);
  });

  test("rejects symlink cursor file without touching target", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(2));
    const cursorsDir = join(stateDir, "compaction-cursors");
    mkdirSync(cursorsDir, { recursive: true });
    const outsideTarget = join(freshDir(), "victim");
    writeFileSync(outsideTarget, "untouched");
    symlinkSync(outsideTarget, join(cursorsDir, CONVERSATION_ID));

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)));
    expect(readFileSync(outsideTarget, "utf8")).toBe("untouched");
  });

  test("returns {} when bun is absent from PATH", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(2));
    expectEmptyAgy(
      invokeWrapper(
        agyPayload(transcriptFile),
        agyEnv(stateDir, { PATH: freshDir() }),
      ),
    );
  });

  test.each([
    { label: "empty stdin", raw: "" },
    { label: "malformed JSON", raw: "{broken" },
    { label: "JSON array", raw: "[]" },
    { label: "null", raw: "null" },
  ])("returns {} on $label", ({ raw }) => {
    const { stateDir } = createFixture();
    expectEmptyAgy(invokeWrapper(raw, agyEnv(stateDir)));
  });

  test.each([
    { label: "relative path", makeValue: () => "relative/state" },
    { label: "overlong path", makeValue: () => `/${"a".repeat(260)}` },
    {
      label: "newline control char",
      makeValue: () => join(freshDir(), "bad\nstate"),
    },
  ])(
    "returns {} for invalid COORDINATION_STATE_DIR ($label)",
    ({ makeValue }) => {
      const { transcriptFile } = createFixture();
      appendFileSync(transcriptFile, checkpointStep(2));
      expectEmptyAgy(
        invokeWrapper(agyPayload(transcriptFile), agyEnv(makeValue())),
      );
    },
  );
});
