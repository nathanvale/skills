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
  existsSync,
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

interface RosteredHome {
  home: string;
  stateFolder: string;
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
const trustedPath = `${bunDirectory}:${systemShellFolder}`;
const hookOutputByteLimit = 1500;
const stateFolderLengthLimit = 256;
const defaultStateFolderSegments = ["my-agent-dojo", "agent-coordination"];

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const COORDINATOR_FOLDER = "example-coordinator";
const ROSTER_LINE = `${COORDINATOR_FOLDER}\n`;

function handWrittenNamedRegroundTextOracle(
  stateFolder: string,
  folder: string = COORDINATOR_FOLDER,
): string {
  return `Coordinator reground: your context was just compacted. This session is registered as a coordinator (${folder}).

Do no merge, push, post or other gated act until all four steps are done:
1. Reread the standing orders and the working instructions in ${stateFolder} in full.
2. Reread your own unit state in ${stateFolder}/${folder}/ and the last rows of its decisions.tsv.
3. Confirm each unit against GitHub and git. The summary above is a note, not proof.
4. Send the Super Coordinator one message with your rules version and each unit's state.
If a message arrives before step 4, say in one line that you are regrounding, finish steps 1 and 2, then act on it.`;
}

function handWrittenGenericRegroundTextOracle(stateFolder: string): string {
  return `Coordinator reground: your context was just compacted. This session is registered as a coordinator.

Do no merge, push, post or other gated act until all four steps are done:
1. Reread the standing orders and the working instructions in ${stateFolder} in full.
2. Reread your own unit state in your coordinator folder under ${stateFolder}/ and the last rows of its decisions.tsv.
3. Confirm each unit against GitHub and git. The summary above is a note, not proof.
4. Send the Super Coordinator one message with your rules version and each unit's state.
If a message arrives before step 4, say in one line that you are regrounding, finish steps 1 and 2, then act on it.`;
}

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

function handWrittenDefaultStateFolder(home: string): string {
  return join(home, ".local", "state", ...defaultStateFolderSegments);
}

function rosterFolderIn(stateFolder: string): string {
  return join(stateFolder, "coordinator-roster");
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

function writeStateRoster(
  stateFolder: string,
  content: string = ROSTER_LINE,
  sessionId: string = SESSION_ID,
): string {
  return writeRoster(rosterFolderIn(stateFolder), sessionId, content);
}

function homeWithRoster(
  content: string,
  sessionId: string = SESSION_ID,
): RosteredHome {
  const home = makeDirectory();
  const stateFolder = handWrittenDefaultStateFolder(home);
  writeStateRoster(stateFolder, content, sessionId);
  return { home, stateFolder };
}

function stateFolderOfLength(length: number): string {
  let folder = makeDirectory();
  while (length - folder.length > 201) {
    folder = join(folder, "s".repeat(100));
  }
  folder = join(folder, "s".repeat(length - folder.length - 1));
  mkdirSync(folder, { recursive: true });
  return folder;
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
  project: string = makeDirectory(),
): HookResult {
  return runHook(
    compactInput(),
    {
      PATH: trustedPath,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      ...env,
    },
    project,
    [systemShell, "-c", declaredCommand()],
  );
}

function copiedPluginLauncher(): { pluginRoot: string; copied: string } {
  const pluginRoot = makeDirectory();
  copyPluginWithoutExecutableBits(pluginRoot);
  return {
    pluginRoot,
    copied: join(pluginRoot, "hooks", "coordinator", launcherName),
  };
}

describe("coordinator reground hook public process", () => {
  test("regrounds a rostered coordinator by its folder name", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("uses the generic wording for an empty roster entry", () => {
    const { home, stateFolder } = homeWithRoster("");

    expectRegroundText(
      runHook(compactInput(), { HOME: home }),
      handWrittenGenericRegroundTextOracle(stateFolder),
    );
  });

  test("keeps the line under the byte limit for the longest folder name", () => {
    const longestFolder = `a${"b".repeat(63)}`;
    const { home, stateFolder } = homeWithRoster(`${longestFolder}\n`);

    expectRegroundText(
      runHook(compactInput(), { HOME: home }),
      handWrittenNamedRegroundTextOracle(stateFolder, longestFolder),
    );
  });

  test.each([
    { label: "a traversal", first: "../x" },
    { label: "spaces and capitals", first: "Bad Name" },
    { label: "a leading hyphen", first: "-rf" },
    { label: "a slash", first: "example-state/other" },
  ])("refuses a folder name with $label and never echoes it", ({ first }) => {
    const { home, stateFolder } = homeWithRoster(`${first}\n`);

    const result = runHook(compactInput(), { HOME: home });

    expectRegroundText(
      result,
      handWrittenGenericRegroundTextOracle(stateFolder),
    );
    expect(result.stdout).not.toContain(first);
  });

  test("reads only the first line of a long roster entry", () => {
    const tail = "NEVER-ECHO-THIS".repeat(40);
    const { home, stateFolder } = homeWithRoster(
      `${COORDINATOR_FOLDER}\n${tail}\n`,
    );

    const result = runHook(compactInput(), { HOME: home });

    expectRegroundText(result, handWrittenNamedRegroundTextOracle(stateFolder));
    expect(result.stdout).not.toContain("NEVER-ECHO-THIS");
  });

  test("works when run by bare file name from its own folder", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home }, launcherFolder, [
        systemShell,
        launcherName,
      ]),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("stays silent for a session that is not on the roster", () => {
    const { home } = homeWithRoster(ROSTER_LINE, "some-other-session");

    expectSilence(runHook(compactInput(), { HOME: home }));
  });

  test("stays silent when the roster folder does not exist", () => {
    expectSilence(runHook(compactInput(), { HOME: makeDirectory() }));
  });

  test.each(["startup", "resume", "clear", "fork"])(
    "stays silent for the %s session source",
    (source) => {
      const { home } = homeWithRoster(ROSTER_LINE);

      expectSilence(runHook(compactInput({ source }), { HOME: home }));
    },
  );

  test("stays silent for another hook event", () => {
    const { home } = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput({ hook_event_name: "SessionEnd" }), { HOME: home }),
    );
  });

  test("stays silent for a subagent identified by agent_id", () => {
    const { home } = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput({ agent_id: "agent_01abc" }), { HOME: home }),
    );
  });

  test("stays silent for a subagent identified by its transcript path", () => {
    const { home } = homeWithRoster(ROSTER_LINE);

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
    const { home } = homeWithRoster(ROSTER_LINE);

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
    const { home } = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput({ session_id: sessionId }), { HOME: home }),
    );
  });

  test("stays silent when the roster entry is a directory", () => {
    const home = makeDirectory();
    mkdirSync(
      join(rosterFolderIn(handWrittenDefaultStateFolder(home)), SESSION_ID),
      { recursive: true },
    );

    expectSilence(runHook(compactInput(), { HOME: home }));
  });

  test("stays silent when the roster entry is a symlink to a file", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE, "real-entry");
    const roster = rosterFolderIn(stateFolder);
    symlinkSync(join(roster, "real-entry"), join(roster, SESSION_ID));

    expectSilence(runHook(compactInput(), { HOME: home }));
  });

  test("stays silent when HOME is unset", () => {
    expectSilence(runHook(compactInput(), {}));
  });

  test("stays silent when bun is absent from PATH", () => {
    const { home } = homeWithRoster(ROSTER_LINE);

    expectSilence(
      runHook(compactInput(), { HOME: home, PATH: makeDirectory() }),
    );
  });

  test("stays silent when the runtime exits non-zero", () => {
    const { home } = homeWithRoster(ROSTER_LINE);
    const fakePath = makeDirectory();
    writeFileSync(
      join(fakePath, "bun"),
      "#!/bin/sh\necho noise\necho boom >&2\nexit 1\n",
      { mode: 0o755 },
    );

    expectSilence(runHook(compactInput(), { HOME: home, PATH: fakePath }));
  });

  test("stays silent when the logic file is missing", () => {
    const { home } = homeWithRoster(ROSTER_LINE);
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

describe("coordinator reground hook state folder", () => {
  test("defaults to my-agent-dojo/agent-coordination under the HOME state folder", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);

    expect(stateFolder).toBe(
      join(home, ".local", "state", "my-agent-dojo", "agent-coordination"),
    );
    expectRegroundText(
      runHook(compactInput(), { HOME: home }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("uses my-agent-dojo/agent-coordination under an absolute XDG_STATE_HOME before HOME", () => {
    const { home } = homeWithRoster(ROSTER_LINE);
    const xdgStateHome = makeDirectory();
    const stateFolder = join(xdgStateHome, ...defaultStateFolderSegments);
    writeStateRoster(stateFolder);

    expectRegroundText(
      runHook(compactInput(), { HOME: home, XDG_STATE_HOME: xdgStateHome }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("stays silent for a roster entry in the HOME state folder without my-agent-dojo", () => {
    const home = makeDirectory();
    writeStateRoster(
      join(home, ".local", "state", ...defaultStateFolderSegments.slice(1)),
    );

    expectSilence(runHook(compactInput(), { HOME: home }));
  });

  test("falls back to HOME for a relative XDG_STATE_HOME", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);
    const { pluginRoot, copied } = copiedPluginLauncher();
    const project = makeDirectory();
    for (const base of [join(pluginRoot, "hooks", "coordinator"), project]) {
      writeStateRoster(
        join(base, "relative-state", ...defaultStateFolderSegments),
      );
    }

    expectRegroundText(
      runHook(
        compactInput(),
        { HOME: home, XDG_STATE_HOME: "relative-state" },
        project,
        [systemShell, copied],
      ),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("reads the state folder named by COORDINATION_STATE_DIR before XDG_STATE_HOME and HOME", () => {
    const { home } = homeWithRoster(ROSTER_LINE);
    const xdgStateHome = makeDirectory();
    writeStateRoster(join(xdgStateHome, ...defaultStateFolderSegments));
    const stateFolder = makeDirectory();
    writeStateRoster(stateFolder);

    expectRegroundText(
      runHook(compactInput(), {
        HOME: home,
        XDG_STATE_HOME: xdgStateHome,
        COORDINATION_STATE_DIR: stateFolder,
      }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("needs no HOME when COORDINATION_STATE_DIR is absolute", () => {
    const stateFolder = makeDirectory();
    writeStateRoster(stateFolder);

    expectRegroundText(
      runHook(compactInput(), { COORDINATION_STATE_DIR: stateFolder }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("prints COORDINATION_STATE_DIR without its trailing slash", () => {
    const stateFolder = makeDirectory();
    writeStateRoster(stateFolder);

    expectRegroundText(
      runHook(compactInput(), { COORDINATION_STATE_DIR: `${stateFolder}/` }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("falls back to the HOME state folder for an empty COORDINATION_STATE_DIR", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home, COORDINATION_STATE_DIR: "" }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("stays silent for a relative COORDINATION_STATE_DIR", () => {
    const { home } = homeWithRoster(ROSTER_LINE);
    const { pluginRoot, copied } = copiedPluginLauncher();
    const project = makeDirectory();
    for (const base of [join(pluginRoot, "hooks", "coordinator"), project]) {
      writeStateRoster(join(base, "relative-state"));
    }

    expectSilence(
      runHook(
        compactInput(),
        { HOME: home, COORDINATION_STATE_DIR: "relative-state" },
        project,
        [systemShell, copied],
      ),
    );
  });

  test("stays silent for a COORDINATION_STATE_DIR longer than 256 characters", () => {
    const { home } = homeWithRoster(ROSTER_LINE);
    const stateFolder = stateFolderOfLength(stateFolderLengthLimit + 1);
    writeStateRoster(stateFolder);

    expect(stateFolder).toHaveLength(stateFolderLengthLimit + 1);
    expectSilence(
      runHook(compactInput(), {
        HOME: home,
        COORDINATION_STATE_DIR: stateFolder,
      }),
    );
  });

  test("stays silent for a COORDINATION_STATE_DIR holding a newline", () => {
    const { home } = homeWithRoster(ROSTER_LINE);
    const stateFolder = join(makeDirectory(), "two\nlines");
    writeStateRoster(stateFolder);

    expectSilence(
      runHook(compactInput(), {
        HOME: home,
        COORDINATION_STATE_DIR: stateFolder,
      }),
    );
  });

  test("keeps the line under the byte limit for a 256-character state folder and the longest folder name", () => {
    const longestFolder = `a${"b".repeat(63)}`;
    const stateFolder = stateFolderOfLength(stateFolderLengthLimit);
    writeStateRoster(stateFolder, `${longestFolder}\n`);

    expect(stateFolder).toHaveLength(stateFolderLengthLimit);
    expectRegroundText(
      runHook(compactInput(), { COORDINATION_STATE_DIR: stateFolder }),
      handWrittenNamedRegroundTextOracle(stateFolder, longestFolder),
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
    expect(declaredCommand()).toStartWith(`${systemShell} `);
    expect(declaredCommand()).toContain(
      `\${CLAUDE_PLUGIN_ROOT}/hooks/coordinator/${launcherName}`,
    );
  });

  test("the declared command regrounds from the repository root", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runDeclaredCommand(repositoryRoot, { HOME: home }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("the declared command regrounds from a copied plugin with no executable bits", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);
    const pluginRoot = makeDirectory();
    copyPluginWithoutExecutableBits(pluginRoot);

    expectRegroundText(
      runDeclaredCommand(pluginRoot, { HOME: home }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("the declared command regrounds from a plugin root with a space in its path", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);
    const pluginRoot = join(makeDirectory(), "plugin root");
    copyPluginWithoutExecutableBits(pluginRoot);

    expectRegroundText(
      runDeclaredCommand(pluginRoot, { HOME: home }),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });
});

function copyPluginWithoutExecutableBits(pluginRoot: string): void {
  for (const relative of [
    join("hooks", "coordinator", launcherName),
    logicRelativePath,
  ]) {
    const copy = join(pluginRoot, relative);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(join(repositoryRoot, relative), copy);
    chmodSync(copy, 0o644);
  }
}

function projectWithStdoutPreload(): { project: string; marker: string } {
  const project = makeDirectory();
  const marker = join(project, "preload-ran");
  writeFileSync(
    join(project, "inject.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      'process.stdout.write("PROJECT PRELOAD STDOUT\\n");',
      'process.stderr.write("PROJECT PRELOAD STDERR\\n");',
      `writeFileSync(${JSON.stringify(marker)}, "ran");`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./inject.ts"]\n');
  return { project, marker };
}

function projectWithEnvFile(): { project: string; envStateFolder: string } {
  const project = makeDirectory();
  const envStateFolder = makeDirectory();
  const envHome = makeDirectory();
  writeFileSync(
    join(project, ".env"),
    `COORDINATION_STATE_DIR=${envStateFolder}\nHOME=${envHome}\n`,
  );
  return { project, envStateFolder };
}

function projectWithPlantedExecutable(name: string): {
  project: string;
  marker: string;
} {
  const project = makeDirectory();
  const marker = join(project, `planted-${name}-ran`);
  const planted = [
    "#!/bin/sh",
    `printf ran > ${JSON.stringify(marker)}`,
    `echo PROJECT ${name.toUpperCase()} STDOUT`,
    "",
  ].join("\n");
  for (const folder of [join(project, "node_modules", ".bin"), project]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, name), planted, { mode: 0o755 });
  }
  return { project, marker };
}

describe("coordinator reground hook ignores the session's project folder", () => {
  test("works when run by a relative path", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);

    expectRegroundText(
      runHook(compactInput(), { HOME: home }, repositoryRoot, [
        systemShell,
        join("hooks", "coordinator", launcherName),
      ]),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("a project bunfig.toml preload never runs for a session not on the roster", () => {
    const { home } = homeWithRoster(ROSTER_LINE, "some-other-session");
    const { project, marker } = projectWithStdoutPreload();

    expectSilence(runHook(compactInput(), { HOME: home }, project));
    expect(existsSync(marker)).toBe(false);
  });

  test("a project bunfig.toml preload never runs for a rostered session", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);
    const { project, marker } = projectWithStdoutPreload();

    expectRegroundText(
      runHook(compactInput(), { HOME: home }, project),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("a project .env cannot silence a rostered session", () => {
    const { home, stateFolder } = homeWithRoster(ROSTER_LINE);
    const { project } = projectWithEnvFile();

    expectRegroundText(
      runHook(compactInput(), { HOME: home }, project),
      handWrittenNamedRegroundTextOracle(stateFolder),
    );
  });

  test("a project .env cannot put a session not on the roster onto it", () => {
    const home = makeDirectory();
    const { project, envStateFolder } = projectWithEnvFile();
    writeStateRoster(envStateFolder);

    expectSilence(runHook(compactInput(), { HOME: home }, project));
  });

  test.each(["node_modules/.bin", "."])(
    "a project bun reached through the relative PATH entry %s never runs for a session not on the roster",
    (relativeEntry) => {
      const { home } = homeWithRoster(ROSTER_LINE, "some-other-session");
      const { project, marker } = projectWithPlantedExecutable("bun");

      expectSilence(
        runHook(
          compactInput(),
          { HOME: home, PATH: `${relativeEntry}:${bunDirectory}` },
          project,
        ),
      );
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.each(["node_modules/.bin", "."])(
    "a project bun reached through the relative PATH entry %s never runs for a rostered session",
    (relativeEntry) => {
      const { home, stateFolder } = homeWithRoster(ROSTER_LINE);
      const { project, marker } = projectWithPlantedExecutable("bun");

      expectRegroundText(
        runHook(
          compactInput(),
          { HOME: home, PATH: `${relativeEntry}:${bunDirectory}` },
          project,
        ),
        handWrittenNamedRegroundTextOracle(stateFolder),
      );
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.each(["node_modules/.bin", "."])(
    "the declared command never runs a project sh reached through the relative PATH entry %s for a session not on the roster",
    (relativeEntry) => {
      const { home } = homeWithRoster(ROSTER_LINE, "some-other-session");
      const { project, marker } = projectWithPlantedExecutable("sh");

      expectSilence(
        runDeclaredCommand(
          repositoryRoot,
          { HOME: home, PATH: `${relativeEntry}:${trustedPath}` },
          project,
        ),
      );
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.each(["node_modules/.bin", "."])(
    "the declared command never runs a project sh reached through the relative PATH entry %s for a rostered session",
    (relativeEntry) => {
      const { home, stateFolder } = homeWithRoster(ROSTER_LINE);
      const { project, marker } = projectWithPlantedExecutable("sh");

      expectRegroundText(
        runDeclaredCommand(
          repositoryRoot,
          { HOME: home, PATH: `${relativeEntry}:${trustedPath}` },
          project,
        ),
        handWrittenNamedRegroundTextOracle(stateFolder),
      );
      expect(existsSync(marker)).toBe(false);
    },
  );
});
