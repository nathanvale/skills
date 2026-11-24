import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";
import {
  reapTestProcesses,
  spawnOwnedProcess,
  waitForFile,
} from "./support/google-contacts-processes.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import { planFromContacts } from "./support/google-contacts-run.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(60_000);

function liveProcessesRunning(binPath: string): readonly number[] {
  const listed = Bun.spawnSync(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
  });
  return listed.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(binPath))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

test("killing a held apply owner mid-hold leaves no gog stub running after the harness tears down", async () => {
  const dir = testFolder("gc-stub-reaping-");
  try {
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
        join(
          repositoryRoot(),
          "skills/in-progress/google-contacts/dist/cli.mjs",
        ),
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
    expect(liveProcessesRunning(gog.binPath).length).toBe(1);
    process.kill(-owner.pid, "SIGKILL");
    await owner.exited;
    expect(liveProcessesRunning(gog.binPath).length).toBe(1);
    reapTestProcesses();
    expect(liveProcessesRunning(gog.binPath)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
