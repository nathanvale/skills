import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { testFolder } from "./support/test-folder.ts";

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandHook {
  type: string;
  command: string;
  timeout: number;
}

interface HookMatcherGroup {
  matcher: string;
  hooks: CommandHook[];
}

interface HooksFile {
  hooks: Record<string, HookMatcherGroup[]>;
}

interface PluginManifest {
  hooks: string;
}

const repositoryRoot = join(import.meta.dir, "..");
const launcherFolder = join(repositoryRoot, "hooks", "coordinator");
const launcherName = "compaction-reground.sh";
const launcher = join(launcherFolder, launcherName);
const logicRelativePath = join(
  "src",
  "compaction-reground",
  "compaction-reground.ts",
);
const bunDirectory = dirname(process.execPath);
const systemShellFolder = "/bin";
const systemShell = join(systemShellFolder, "sh");
const hookOutputByteLimit = 1500;

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const COORDINATOR_FOLDER = "example-coordinator";
const ROSTER_LINE = `${COORDINATOR_FOLDER}\n`;

const HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE = `Coordinator reground: your context was just compacted. This session is registered as a kernel-split coordinator (example-coordinator).

Do no merge, push, post or other gated act until all four steps are done:
1. Reread ~/.local/state/kernel-split/STANDING-ORDERS.md and ~/.local/state/kernel-split/WORKING-INSTRUCTIONS.md in full.
2. Reread your own unit state in ~/.local/state/kernel-split/example-coordinator/ and the last rows of its decisions.tsv.
3. Confirm each unit against GitHub and git. The summary above is a note, not proof.
4. Send the Super Coordinator one message with your rules version and each unit's state.`;

const HAND_WRITTEN_GENERIC_REGROUND_TEXT_ORACLE = `Coordinator reground: your context was just compacted. This session is registered as a kernel-split coordinator.

Do no merge, push, post or other gated act until all four steps are done:
1. Reread ~/.local/state/kernel-split/STANDING-ORDERS.md and ~/.local/state/kernel-split/WORKING-INSTRUCTIONS.md in full.
2. Reread your own unit state in your coordinator folder under ~/.local/state/kernel-split/ and the last rows of its decisions.tsv.
3. Confirm each unit against GitHub and git. The summary above is a note, not proof.
4. Send the Super Coordinator one message with your rules version and each unit's state.`;

const temporaryDirectories: string[] = [];
let transcriptFolder = "";

beforeAll(() => {
  transcriptFolder = testFolder("compaction-reground-transcripts-");
});

afterAll(() => {
  rmSync(transcriptFolder, { recursive: true, force: true });
});

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function makeDirectory(): string {
  const directory = testFolder("compaction-reground-");
  temporaryDirectories.push(directory);
  return directory;
}

function handWrittenDefaultRosterDirectory(home: string): string {
  return join(home, ".local", "state", "kernel-split", "coordinator-roster");
}

function writeRoster(
  directory: string,
  sessionId: string,
  content: string,
): string {
  const entry = join(directory, sessionId);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, content);
  return entry;
}

function homeWithRoster(content: string, sessionId = SESSION_ID): string {
  const home = makeDirectory();
  writeRoster(handWrittenDefaultRosterDirectory(home), sessionId, content);
  return home;
}

function finished(child: {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}): HookResult {
  return {
    exitCode: child.exitCode ?? -1,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

function runHook(
  input: string,
  env: Record<string, string>,
  cwd: string = process.cwd(),
  argv: string[] = [systemShell, launcher],
): HookResult {
  const child = Bun.spawnSync(argv, {
    cwd,
    env: { PATH: bunDirectory, ...env },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return finished(child);
}

function transcriptPath(...segments: string[]): string {
  return join(transcriptFolder, "projects", "demo", ...segments);
}

function compactInput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: SESSION_ID,
    transcript_path: transcriptPath(`${SESSION_ID}.jsonl`),
    ...overrides,
  });
}

function expectSilence(result: HookResult): void {
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}

function expectRegroundText(result: HookResult, expected: string): void {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");

  const lines = result.stdout.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  expect(Buffer.byteLength(lines[0] ?? "")).toBeLessThan(hookOutputByteLimit);
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: expected,
    },
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function declaredHooks(): HooksFile {
  const manifest = readJson(
    join(repositoryRoot, ".claude-plugin", "plugin.json"),
  );
  expect(manifest).toMatchObject({ hooks: "./hooks/claude/hooks.json" });
  const { hooks } = manifest as PluginManifest;
  return readJson(join(repositoryRoot, hooks)) as HooksFile;
}

function declaredCommand(): string {
  return declaredHooks().hooks.SessionStart?.[0]?.hooks[0]?.command ?? "";
}

function runDeclaredCommand(
  pluginRoot: string,
  env: Record<string, string>,
): HookResult {
  return runHook(
    compactInput(),
    {
      PATH: `${bunDirectory}:${systemShellFolder}`,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      ...env,
    },
    makeDirectory(),
    [systemShell, "-c", declaredCommand()],
  );
}

describe("coordinator reground hook public process", () => {
  test("regrounds a rostered coordinator by its folder name", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home }),
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE,
    );
  });

  test("uses the generic wording for an empty roster entry", () => {
    const home = homeWithRoster("");

    expectRegroundText(
      runHook(compactInput(), { HOME: home }),
      HAND_WRITTEN_GENERIC_REGROUND_TEXT_ORACLE,
    );
  });

  test("keeps the line under the byte limit for the longest folder name", () => {
    const longestFolder = `a${"b".repeat(63)}`;
    const home = homeWithRoster(`${longestFolder}\n`);

    const result = runHook(compactInput(), { HOME: home });

    expectRegroundText(
      result,
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE.replaceAll(
        COORDINATOR_FOLDER,
        longestFolder,
      ),
    );
  });

  test.each([
    { label: "a traversal", first: "../x" },
    { label: "spaces and capitals", first: "Bad Name" },
    { label: "a leading hyphen", first: "-rf" },
    { label: "a slash", first: "kernel-split/other" },
  ])("refuses a folder name with $label and never echoes it", ({ first }) => {
    const home = homeWithRoster(`${first}\n`);

    const result = runHook(compactInput(), { HOME: home });

    expectRegroundText(result, HAND_WRITTEN_GENERIC_REGROUND_TEXT_ORACLE);
    expect(result.stdout).not.toContain(first);
  });

  test("reads only the first line of a long roster entry", () => {
    const tail = "NEVER-ECHO-THIS".repeat(40);
    const home = homeWithRoster(`${COORDINATOR_FOLDER}\n${tail}\n`);

    const result = runHook(compactInput(), { HOME: home });

    expectRegroundText(result, HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE);
    expect(result.stdout).not.toContain("NEVER-ECHO-THIS");
  });

  test("works when run by bare file name from its own folder", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home }, launcherFolder, [
        systemShell,
        launcherName,
      ]),
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE,
    );
  });

  test("stays silent for a session that is not on the roster", () => {
    const home = homeWithRoster(ROSTER_LINE, "some-other-session");

    expectSilence(runHook(compactInput(), { HOME: home }));
  });

  test("stays silent when the roster folder does not exist", () => {
    expectSilence(runHook(compactInput(), { HOME: makeDirectory() }));
  });

  test.each(["startup", "resume", "clear", "fork"])(
    "stays silent for the %s session source",
    (source) => {
      const home = homeWithRoster(ROSTER_LINE);

      expectSilence(runHook(compactInput({ source }), { HOME: home }));
    },
  );

  test("stays silent for another hook event", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput({ hook_event_name: "SessionEnd" }), { HOME: home }),
    );
  });

  test("stays silent for a subagent identified by agent_id", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput({ agent_id: "agent_01abc" }), { HOME: home }),
    );
  });

  test("stays silent for a subagent identified by its transcript path", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(
        compactInput({
          transcript_path: transcriptPath("subagents", `${SESSION_ID}.jsonl`),
        }),
        { HOME: home },
      ),
    );
  });

  test.each([
    { label: "empty stdin", input: "" },
    { label: "plain text", input: "not json" },
    { label: "a JSON array", input: '[{"source":"compact"}]' },
    { label: "a JSON string", input: '"compact"' },
    { label: "null", input: "null" },
  ])("stays silent for $label", ({ input }) => {
    const home = homeWithRoster(ROSTER_LINE);

    expectSilence(runHook(input, { HOME: home }));
  });

  test.each([
    { label: "a missing session_id", sessionId: undefined },
    { label: "a non-string session_id", sessionId: 7 },
    { label: "an empty session_id", sessionId: "" },
    { label: "a traversing session_id", sessionId: "../../etc/passwd" },
    { label: "a session_id with a dot", sessionId: "session.jsonl" },
    { label: "a session_id with a slash", sessionId: "a/b" },
  ])("stays silent for $label", ({ sessionId }) => {
    const home = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput({ session_id: sessionId }), { HOME: home }),
    );
  });

  test("stays silent when the roster entry is a directory", () => {
    const home = makeDirectory();
    mkdirSync(join(handWrittenDefaultRosterDirectory(home), SESSION_ID), {
      recursive: true,
    });

    expectSilence(runHook(compactInput(), { HOME: home }));
  });

  test("stays silent when the roster entry is a symlink to a file", () => {
    const home = homeWithRoster(ROSTER_LINE, "real-entry");
    const roster = handWrittenDefaultRosterDirectory(home);
    symlinkSync(join(roster, "real-entry"), join(roster, SESSION_ID));

    expectSilence(runHook(compactInput(), { HOME: home }));
  });

  test("stays silent when HOME is unset", () => {
    expectSilence(runHook(compactInput(), {}));
  });

  test("stays silent when bun is absent from PATH", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput(), { HOME: home, PATH: makeDirectory() }),
    );
  });

  test("stays silent when the runtime exits non-zero", () => {
    const home = homeWithRoster(ROSTER_LINE);
    const fakePath = makeDirectory();
    writeFileSync(
      join(fakePath, "bun"),
      "#!/bin/sh\necho noise\necho boom >&2\nexit 1\n",
      { mode: 0o755 },
    );

    expectSilence(runHook(compactInput(), { HOME: home, PATH: fakePath }));
  });

  test("stays silent when the logic file is missing", () => {
    const home = homeWithRoster(ROSTER_LINE);
    const pluginRoot = makeDirectory();
    const copiedLauncherFolder = join(pluginRoot, "hooks", "coordinator");
    mkdirSync(copiedLauncherFolder, { recursive: true });
    copyFileSync(launcher, join(copiedLauncherFolder, launcherName));

    expectSilence(
      runHook(compactInput(), { HOME: home }, process.cwd(), [
        systemShell,
        join(copiedLauncherFolder, launcherName),
      ]),
    );
  });
});

describe("coordinator reground hook roster folder", () => {
  test("reads the roster folder named by COORDINATOR_ROSTER_DIR", () => {
    const home = makeDirectory();
    const roster = makeDirectory();
    writeRoster(roster, SESSION_ID, ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home, COORDINATOR_ROSTER_DIR: roster }),
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE,
    );
  });

  test("needs no HOME when COORDINATOR_ROSTER_DIR is absolute", () => {
    const roster = makeDirectory();
    writeRoster(roster, SESSION_ID, ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { COORDINATOR_ROSTER_DIR: roster }),
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE,
    );
  });

  test("falls back to the HOME state folder for an empty COORDINATOR_ROSTER_DIR", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home, COORDINATOR_ROSTER_DIR: "" }),
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE,
    );
  });

  test("stays silent for a relative COORDINATOR_ROSTER_DIR", () => {
    const base = makeDirectory();
    writeRoster(join(base, "roster"), SESSION_ID, ROSTER_LINE);

    expectSilence(
      runHook(
        compactInput(),
        { HOME: base, COORDINATOR_ROSTER_DIR: "roster" },
        base,
      ),
    );
  });
});

describe("coordinator reground hook plugin declaration", () => {
  test("declares one compact SessionStart command hook with a five second timeout", () => {
    const declared = declaredHooks();

    expect(Object.keys(declared.hooks)).toEqual(["SessionStart"]);
    expect(declared.hooks.SessionStart).toHaveLength(1);
    expect(declared.hooks.SessionStart?.[0]?.matcher).toBe("compact");
    expect(declared.hooks.SessionStart?.[0]?.hooks).toHaveLength(1);
    expect(declared.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      timeout: 5,
    });
    expect(declaredCommand()).toStartWith("sh ");
    expect(declaredCommand()).toContain(
      `\${CLAUDE_PLUGIN_ROOT}/hooks/coordinator/${launcherName}`,
    );
  });

  test("the declared command regrounds from the repository root", () => {
    const home = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runDeclaredCommand(repositoryRoot, { HOME: home }),
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE,
    );
  });

  test("the declared command regrounds from a copied plugin with no executable bits", () => {
    const home = homeWithRoster(ROSTER_LINE);
    const pluginRoot = makeDirectory();
    for (const relative of [
      join("hooks", "coordinator", launcherName),
      logicRelativePath,
    ]) {
      const copy = join(pluginRoot, relative);
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(join(repositoryRoot, relative), copy);
      chmodSync(copy, 0o644);
    }

    expectRegroundText(
      runDeclaredCommand(pluginRoot, { HOME: home }),
      HAND_WRITTEN_NAMED_REGROUND_TEXT_ORACLE,
    );
  });
});
