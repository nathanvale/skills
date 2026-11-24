import { afterEach } from "bun:test";
import { existsSync, readdirSync, watch } from "node:fs";
import { dirname } from "node:path";

const ownedStubs = new Set<{
  readonly binPath: string;
  readonly pidDir: string;
}>();
const ownedGroups = new Set<number>();

function stopGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    ownedGroups.delete(pid);
  }
}

function stubStillRunning(pid: number, binPath: string): boolean {
  const listed = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
    stdout: "pipe",
  });
  return listed.stdout.toString().includes(binPath);
}

function reapStub(stub: { readonly binPath: string; readonly pidDir: string }) {
  if (!existsSync(stub.pidDir)) {
    ownedStubs.delete(stub);
    return;
  }
  for (const name of readdirSync(stub.pidDir)) {
    const pid = Number(name);
    if (Number.isSafeInteger(pid) && stubStillRunning(pid, stub.binPath)) {
      stopGroup(pid);
    }
  }
}

export function registerStub(stub: {
  readonly binPath: string;
  readonly pidDir: string;
}): void {
  ownedStubs.add(stub);
}

export function reapTestProcesses(): void {
  for (const pid of ownedGroups) stopGroup(pid);
  ownedGroups.clear();
  for (const stub of ownedStubs) reapStub(stub);
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
