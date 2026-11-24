import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  root: string;
  stateDir: string;
  transcriptFile: string;
}

interface StoredCursor {
  lastCheckpointStep: number;
  lastScannedBytes: number;
  prefixSha256?: string;
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
const scriptPath = join(
  repoRoot,
  "src",
  "compaction-reground",
  "compaction-reground.ts",
);
const CONVERSATION_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const COORDINATOR_NAME = "skills-coordinator";
const CHUNK_BYTES = 256 * 1024;
const createdFolders: string[] = [];
const lockedFolders: string[] = [];

afterEach(() => {
  while (lockedFolders.length > 0) {
    const folder = lockedFolders.pop();
    if (folder && existsSync(folder)) {
      chmodSync(folder, 0o700);
    }
  }
  while (createdFolders.length > 0) {
    const folder = createdFolders.pop();
    if (folder) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

function freshDir(): string {
  const folder = testFolder("agy-reground-edge-");
  createdFolders.push(folder);
  return folder;
}

function namedOracle(stateDir: string, folder: string): string {
  return [
    `Coordinator reground: your context was just compacted. This session is registered as a coordinator (${folder}).`,
    "",
    "Do no merge, push, post or other gated act until all four steps are done:",
    `1. Reread the standing orders and the working instructions in ${stateDir} in full.`,
    `2. Reread your own unit state in ${stateDir}/${folder}/ and the last rows of its decisions.tsv.`,
    "3. Confirm each unit against GitHub and git. The summary above is a note, not proof.",
    "4. Send the Super Coordinator one message with your rules version and each unit's state.",
    "If a message arrives before step 4, say in one line that you are regrounding, finish steps 1 and 2, then act on it.",
  ].join("\n");
}

function userStep(
  stepIndex: number,
  content: string = `turn ${stepIndex}`,
): string {
  return `${JSON.stringify({ step_index: stepIndex, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content })}\n`;
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
  return { root, stateDir, transcriptFile };
}

function agyPayload(transcriptPath: string): string {
  return JSON.stringify({
    hookEventName: "PreInvocation",
    conversationId: CONVERSATION_ID,
    transcriptPath,
    invocationNum: 0,
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

function runCommand(
  args: string[],
  stdin: string,
  env: Record<string, string>,
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

function invokeWrapper(
  stdin: string,
  env: Record<string, string>,
): ProcessOutput {
  return runCommand([shellBin, wrapperPath, "--antigravity"], stdin, env);
}

function expectEmptyAgy(output: ProcessOutput): void {
  expect(output).toEqual({ exitCode: 0, stdout: "{}\n", stderr: "" });
}

function expectInjected(output: ProcessOutput, stateDir: string): void {
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout.endsWith("\n")).toBe(true);
  expect(JSON.parse(output.stdout)).toEqual({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: namedOracle(stateDir, COORDINATOR_NAME),
        },
      },
    ],
  });
}

function readStoredCursor(stateDir: string): StoredCursor {
  const cursorFile = join(stateDir, "compaction-cursors", CONVERSATION_ID);
  return JSON.parse(readFileSync(cursorFile, "utf8")) as StoredCursor;
}

function sha256Hex(data: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function paddingLinesToTarget(targetBytes: number): string {
  const baseLine = userStep(1, "x".repeat(1000));
  const baseLength = Buffer.byteLength(baseLine);
  const fullCount = Math.floor(targetBytes / baseLength);
  let output = baseLine.repeat(fullCount);
  const remaining = targetBytes - Buffer.byteLength(output);
  if (remaining > 0) {
    const emptyLine = userStep(2, "");
    const fill = Math.max(0, remaining - Buffer.byteLength(emptyLine));
    output += userStep(2, "y".repeat(fill));
  }
  return output;
}

describe("Antigravity cursor persistence fail-closed guards", () => {
  test("fails closed on unwritable 0555 compaction-cursors directory and recovers after chmod 0700", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(6));
    const cursorsDir = join(stateDir, "compaction-cursors");
    mkdirSync(cursorsDir, { recursive: true, mode: 0o700 });
    chmodSync(cursorsDir, 0o555);
    lockedFolders.push(cursorsDir);
    const env = agyEnv(stateDir);

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    expect(readdirSync(cursorsDir)).toEqual([]);

    chmodSync(cursorsDir, 0o700);
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    const cursorFile = join(cursorsDir, CONVERSATION_ID);
    expect(lstatSync(cursorFile).mode & 0o777).toBe(0o600);
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
  });

  test("fails closed on pre-planted staging symlink collision without unlinking symlink or touching victim", () => {
    const { root, stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(8));
    const cursorsDir = join(stateDir, "compaction-cursors");
    mkdirSync(cursorsDir, { recursive: true, mode: 0o700 });
    const victimFile = join(root, "victim.txt");
    writeFileSync(victimFile, "untouched");
    const recordFile = join(root, "staging-path.txt");
    const preloadScript = join(root, "pin-staging.ts");
    writeFileSync(
      preloadScript,
      [
        'import { symlinkSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "Date.now = () => 1700000000000;",
        "Math.random = () => 0.5;",
        "const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;",
        'const staging = join(process.env.TEST_CURSORS_DIR ?? "", `.${process.env.TEST_CONV_ID ?? ""}.${nonce}.tmp`);',
        'symlinkSync(process.env.TEST_VICTIM ?? "", staging);',
        'writeFileSync(process.env.TEST_RECORD ?? "", staging);',
      ].join("\n"),
    );

    const output = runCommand(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preloadScript,
        scriptPath,
        "--antigravity",
      ],
      agyPayload(transcriptFile),
      agyEnv(stateDir, {
        TEST_CURSORS_DIR: cursorsDir,
        TEST_CONV_ID: CONVERSATION_ID,
        TEST_VICTIM: victimFile,
        TEST_RECORD: recordFile,
      }),
    );

    expectEmptyAgy(output);
    const stagingPath = readFileSync(recordFile, "utf8");
    expect(stagingPath.startsWith(cursorsDir)).toBe(true);
    expect(lstatSync(stagingPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(victimFile, "utf8")).toBe("untouched");
    expect(existsSync(join(cursorsDir, CONVERSATION_ID))).toBe(false);
  });

  test("creates compaction-cursors directory with mode 0700", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(2));

    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)),
      stateDir,
    );
    const cursorsDir = join(stateDir, "compaction-cursors");
    expect(lstatSync(cursorsDir).mode & 0o777).toBe(0o700);
  });

  test("tightens existing 0755 compaction-cursors directory to 0700 and writes 0600 cursor", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(3));
    const cursorsDir = join(stateDir, "compaction-cursors");
    mkdirSync(cursorsDir, { recursive: true });
    chmodSync(cursorsDir, 0o755);
    expect(lstatSync(cursorsDir).mode & 0o777).toBe(0o755);

    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), agyEnv(stateDir)),
      stateDir,
    );
    expect(lstatSync(cursorsDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(cursorsDir, CONVERSATION_ID)).mode & 0o777).toBe(
      0o600,
    );
  });

  test("does not persist cursor when roster entry is 0000 and fires once after chmod 0600", () => {
    const { stateDir, transcriptFile } = createFixture();
    appendFileSync(transcriptFile, checkpointStep(6));
    const rosterFile = join(stateDir, "coordinator-roster", CONVERSATION_ID);
    const cursorFile = join(stateDir, "compaction-cursors", CONVERSATION_ID);
    const env = agyEnv(stateDir);
    chmodSync(rosterFile, 0o000);
    lockedFolders.push(rosterFile);

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    expect(existsSync(cursorFile)).toBe(false);

    chmodSync(rosterFile, 0o600);
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    const bytes = readFileSync(transcriptFile);
    expect(readStoredCursor(stateDir)).toEqual({
      lastCheckpointStep: 6,
      lastScannedBytes: bytes.length,
      prefixSha256: sha256Hex(bytes),
    });
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
  });
});

describe("Antigravity chunk boundary, rewind continuity, and wrapper fallback", () => {
  test("detects CHECKPOINT straddling 256 KB boundary from offset 0, warm cursor, and trailing partial line", () => {
    const { stateDir, transcriptFile } = createFixture();
    const env = agyEnv(stateDir);
    const firstPadding = paddingLinesToTarget(CHUNK_BYTES - 20);
    const firstCheckpoint = checkpointStep(50);
    const firstContent = firstPadding + firstCheckpoint;
    expect(Buffer.byteLength(firstPadding)).toBeLessThan(CHUNK_BYTES);
    expect(Buffer.byteLength(firstContent)).toBeGreaterThan(CHUNK_BYTES);

    writeFileSync(transcriptFile, firstContent);
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    const warmOffset = Buffer.byteLength(firstContent);
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(50);
    expect(readStoredCursor(stateDir).lastScannedBytes).toBe(warmOffset);

    const secondPadding = paddingLinesToTarget(CHUNK_BYTES - 20);
    const secondCheckpoint = checkpointStep(100);
    const thirdCheckpoint = checkpointStep(150);
    const splitAt = Math.floor(thirdCheckpoint.length / 2);
    const secondChunk = secondPadding + secondCheckpoint;
    expect(Buffer.byteLength(secondPadding)).toBeLessThan(CHUNK_BYTES);
    expect(Buffer.byteLength(secondChunk)).toBeGreaterThan(CHUNK_BYTES);

    appendFileSync(
      transcriptFile,
      secondChunk + thirdCheckpoint.slice(0, splitAt),
    );
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    const expectedBeforePartial = warmOffset + Buffer.byteLength(secondChunk);
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(100);
    expect(readStoredCursor(stateDir).lastScannedBytes).toBe(
      expectedBeforePartial,
    );

    appendFileSync(transcriptFile, thirdCheckpoint.slice(splitAt));
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(150);
    expect(readStoredCursor(stateDir).lastScannedBytes).toBe(
      Buffer.byteLength(readFileSync(transcriptFile)),
    );
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
  });

  test("detects rewind regrown past saved size without false re-fire and fires on lower next CHECKPOINT", () => {
    const { stateDir, transcriptFile } = createFixture();
    const env = agyEnv(stateDir);
    writeFileSync(transcriptFile, userStep(0) + checkpointStep(14));
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    const savedBytes = readStoredCursor(stateDir).lastScannedBytes;

    const regrown =
      userStep(0) + checkpointStep(4) + userStep(5, "r".repeat(savedBytes));
    expect(Buffer.byteLength(regrown)).toBeGreaterThan(savedBytes);
    writeFileSync(transcriptFile, regrown);

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(4);

    appendFileSync(transcriptFile, checkpointStep(10));
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(10);
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
  });

  test("detects same-size transcript rewrite without false re-fire and fires on lower next CHECKPOINT", () => {
    const { stateDir, transcriptFile } = createFixture();
    const env = agyEnv(stateDir);
    const initial = userStep(0) + checkpointStep(14);
    writeFileSync(transcriptFile, initial);
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    const savedBytes = Buffer.byteLength(initial);

    const baseRewrite = userStep(0) + userStep(1, "");
    const padLength = savedBytes - Buffer.byteLength(baseRewrite);
    const sameSizeRewrite = userStep(0) + userStep(1, "z".repeat(padLength));
    expect(Buffer.byteLength(sameSizeRewrite)).toBe(savedBytes);
    writeFileSync(transcriptFile, sameSizeRewrite);

    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(-1);

    appendFileSync(transcriptFile, checkpointStep(10));
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(10);
  });

  test("detects same-tail same-size and same-tail regrown rewrites via prefixSha256", () => {
    const { stateDir, transcriptFile } = createFixture();
    const env = agyEnv(stateDir);
    const initial = userStep(0) + checkpointStep(14);
    const initialBuf = Buffer.from(initial);
    writeFileSync(transcriptFile, initial);
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);

    const sameTailSameSize = userStep(0) + checkpointStep(10);
    const sameSizeBuf = Buffer.from(sameTailSameSize);
    expect(sameSizeBuf.length).toBe(initialBuf.length);
    expect(sameSizeBuf.subarray(-32).equals(initialBuf.subarray(-32))).toBe(
      true,
    );
    writeFileSync(transcriptFile, sameTailSameSize);
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    expect(readStoredCursor(stateDir)).toEqual({
      lastCheckpointStep: 10,
      lastScannedBytes: sameSizeBuf.length,
      prefixSha256: sha256Hex(sameSizeBuf),
    });

    appendFileSync(transcriptFile, checkpointStep(12));
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(12);

    const beforeRegrow = readFileSync(transcriptFile);
    const regrownBase = userStep(0) + checkpointStep(10) + checkpointStep(11);
    const regrown = regrownBase + userStep(13, "r".repeat(64));
    const regrownBuf = Buffer.from(regrown);
    expect(regrownBuf.length).toBeGreaterThan(beforeRegrow.length);
    expect(
      regrownBuf
        .subarray(beforeRegrow.length - 32, beforeRegrow.length)
        .equals(beforeRegrow.subarray(-32)),
    ).toBe(true);
    writeFileSync(transcriptFile, regrown);
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
    expect(readStoredCursor(stateDir)).toEqual({
      lastCheckpointStep: 11,
      lastScannedBytes: regrownBuf.length,
      prefixSha256: sha256Hex(regrownBuf),
    });

    appendFileSync(transcriptFile, checkpointStep(12));
    expectInjected(invokeWrapper(agyPayload(transcriptFile), env), stateDir);
    expect(readStoredCursor(stateDir).lastCheckpointStep).toBe(12);
    expectEmptyAgy(invokeWrapper(agyPayload(transcriptFile), env));
  });

  test("runs shipped --antigravity wrapper with ANTIGRAVITY_CONVERSATION_ID unset", () => {
    const { stateDir, transcriptFile } = createFixture(true);
    appendFileSync(transcriptFile, checkpointStep(4));

    expectInjected(
      invokeWrapper(agyPayload(transcriptFile), {
        COORDINATION_STATE_DIR: stateDir,
      }),
      stateDir,
    );
  });
});
