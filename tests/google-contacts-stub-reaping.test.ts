import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";
import {
  liveStubPids,
  reapTestProcesses,
  removeOwnedFolder,
  spawnOwnedProcess,
  waitForFile,
  waitUntil,
} from "./support/google-contacts-processes.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import { planFromContacts } from "./support/google-contacts-run.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(60_000);

const SELF_EXIT_DEADLINE_MS = 5_000;

async function holdApplyMidUpdate(dir: string) {
  const c1 = sampleContact("c1", {
    phoneNumbers: [{ value: "0491 570 801", type: "mobile" }],
  });
  const planned = await planFromContacts({
    dir,
    contacts: [c1],
    lane: "phone-normalize",
    proposals: [
      { kind: "phone-normalize", target: "people/c1", confidence: "high" },
    ],
  });
  const holdDir = join(dir, "hold");
  mkdirSync(holdDir, { recursive: true });
  const ready = join(holdDir, "lock-ready");
  const gog = createGogStub(holdDir, {
    account: "owner@example.com",
    contacts: [c1],
    behavior: {
      holdLockReadyFile: ready,
      holdLockReleaseFile: join(holdDir, "never-released"),
    },
  });
  const owner = spawnOwnedProcess(
    [
      process.execPath,
      join(repositoryRoot(), "skills/in-progress/google-contacts/dist/cli.mjs"),
      "apply",
      "--plan",
      planned.planFile,
      "--seal",
      planned.seal,
      "--json",
    ],
    {
      cwd: dir,
      env: {
        PATH: dirname(process.execPath),
        HOME: dir,
        GOOGLE_CONTACTS_LEDGER_DIR: join(dir, "ledger"),
        GOOGLE_CONTACTS_GOG_BIN: gog.binPath,
      },
    },
  );
  await waitForFile(ready, { abandonWhen: owner.exited });
  return { owner, gog };
}

test("the harness reaper stops a held gog stub it owns without inspecting the process table", async () => {
  const dir = testFolder("gc-stub-reaping-");
  try {
    const { gog } = await holdApplyMidUpdate(dir);
    expect(liveStubPids(gog.pidDir).length).toBe(1);
    reapTestProcesses();
    await waitUntil(() => liveStubPids(gog.pidDir).length === 0, {
      timeoutMs: SELF_EXIT_DEADLINE_MS,
      description: "the reaped gog stub has exited",
    });
  } finally {
    removeOwnedFolder(dir);
  }
});

test("a held gog stub exits by itself within seconds when its apply owner is killed and nothing reaps it", async () => {
  const dir = testFolder("gc-stub-orphan-");
  try {
    const { owner, gog } = await holdApplyMidUpdate(dir);
    const [stubPid] = liveStubPids(gog.pidDir);
    if (stubPid === undefined) throw new Error("No held gog stub is running.");
    process.kill(-owner.pid, "SIGKILL");
    await owner.exited;
    await waitUntil(() => liveStubPids(gog.pidDir).length === 0, {
      timeoutMs: SELF_EXIT_DEADLINE_MS,
      description: `orphaned gog stub ${String(stubPid)} has exited by itself`,
    });
  } finally {
    removeOwnedFolder(dir);
  }
});

test("a held gog stub exits by itself within seconds when its folder is removed under it", async () => {
  const dir = testFolder("gc-stub-folder-");
  try {
    const { gog } = await holdApplyMidUpdate(dir);
    const [stubPid] = liveStubPids(gog.pidDir);
    if (stubPid === undefined) throw new Error("No held gog stub is running.");
    rmSync(dirname(gog.binPath), { recursive: true, force: true });
    await waitUntil(() => liveStubPids(gog.pidDir).length === 0, {
      timeoutMs: SELF_EXIT_DEADLINE_MS,
      description: `gog stub ${String(stubPid)} has exited after its folder was removed`,
    });
  } finally {
    removeOwnedFolder(dir);
  }
});
