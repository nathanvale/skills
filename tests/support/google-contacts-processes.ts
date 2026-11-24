import { afterEach } from "bun:test";
import { existsSync, readdirSync, rmSync, watch } from "node:fs";
import { dirname } from "node:path";

type OwnedStub = {
  readonly pidDir: string;
  readonly pids: Set<number>;
};

const ownedStubs = new Set<OwnedStub>();
const ownedGroups = new Set<number>();

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    ownedGroups.delete(pid);
  }
}

function recordStubPids(stub: OwnedStub): void {
  if (!existsSync(stub.pidDir)) return;
  const present = new Set<number>();
  for (const name of readdirSync(stub.pidDir)) {
    const pid = Number(name);
    if (Number.isSafeInteger(pid) && pid > 1) present.add(pid);
  }
  stub.pids.clear();
  for (const pid of present) stub.pids.add(pid);
}

function reapStub(stub: OwnedStub): void {
  recordStubPids(stub);
  for (const pid of stub.pids) {
    if (groupAlive(pid)) stopGroup(pid);
    if (!groupAlive(pid)) stub.pids.delete(pid);
  }
}

export function registerStub(pidDir: string): void {
  ownedStubs.add({ pidDir, pids: new Set<number>() });
}

export function liveStubPids(pidDir: string): readonly number[] {
  const live: number[] = [];
  for (const stub of ownedStubs) {
    if (stub.pidDir !== pidDir) continue;
    recordStubPids(stub);
    for (const pid of stub.pids) if (groupAlive(pid)) live.push(pid);
  }
  return live;
}

export function reapTestProcesses(): void {
  for (const pid of ownedGroups) stopGroup(pid);
  ownedGroups.clear();
  for (const stub of ownedStubs) {
    reapStub(stub);
    if (stub.pids.size === 0 && !existsSync(stub.pidDir)) {
      ownedStubs.delete(stub);
    }
  }
}

export function spawnOwnedProcess(
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
): ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  ownedGroups.add(child.pid);
  return child;
}

const RUNNING_UNDER_BUN_TEST = process.env.NODE_ENV === "test";
if (RUNNING_UNDER_BUN_TEST) afterEach(reapTestProcesses);
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    reapTestProcesses();
    process.exit(code);
  });
}

export function waitUntil(
  condition: () => boolean,
  options: { readonly timeoutMs: number; readonly description: string },
): Promise<void> {
  if (condition()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const recheck = setInterval(() => {
      if (!condition()) return;
      clearInterval(recheck);
      clearTimeout(timer);
      resolve();
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(recheck);
      if (condition()) resolve();
      else reject(new Error(`Timed out waiting until ${options.description}.`));
    }, options.timeoutMs);
  });
}

export function waitForFile(
  filePath: string,
  options: {
    readonly timeoutMs?: number;
    readonly abandonWhen?: Promise<unknown>;
  } = {},
): Promise<void> {
  if (existsSync(filePath)) return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(recheck);
      watcher.close();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const resolveIfPresent = (): boolean => {
      if (existsSync(filePath)) finish();
      return settled;
    };
    const watcher = watch(dirname(filePath), () => {
      resolveIfPresent();
    });
    const recheck = setInterval(resolveIfPresent, 100);
    const timer = setTimeout(() => {
      if (!resolveIfPresent()) {
        finish(new Error(`Timed out waiting for file ${filePath}.`));
      }
    }, timeoutMs);
    void options.abandonWhen?.then(
      () => {
        if (!resolveIfPresent()) {
          finish(new Error(`Process exited before ${filePath} appeared.`));
        }
      },
      () => undefined,
    );
    resolveIfPresent();
  });
}

export function removeOwnedFolder(folder: string): void {
  reapTestProcesses();
  rmSync(folder, { recursive: true, force: true });
}
