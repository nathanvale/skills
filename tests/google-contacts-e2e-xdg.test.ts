import { expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";
import {
  removeOwnedFolder,
  spawnOwnedProcess,
  waitForFile,
} from "./support/google-contacts-processes.ts";
import {
  createGogStub,
  sampleContact,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(90_000);

function minimalEnv(
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  return { PATH: dirname(process.execPath), ...extra };
}

function runBundle(
  bundlePath: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
) {
  const proc = Bun.spawnSync([process.execPath, bundlePath, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const stdout = proc.stdout.toString();
  const parsed: unknown = JSON.parse(stdout);
  const resObj: unknown =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "result")
      : null;
  if (typeof resObj !== "object" || resObj === null) {
    throw new Error(`Expected envelope result, got: ${stdout}`);
  }
  const data: unknown = Reflect.get(resObj, "data");
  return {
    exitCode: proc.exitCode,
    stdout,
    causeCode: String(Reflect.get(resObj, "causeCode")),
    data,
  };
}

function readSeal(data: unknown): string {
  return typeof data === "object" && data !== null
    ? String(Reflect.get(data, "seal"))
    : "";
}

test("sterile copied skill bundle runs full pipeline, concurrent APPLY_HELD, and SIGTERM narrow-scope isolation", async () => {
  const dir = testFolder("gc-sterile-e2e-");
  try {
    const skillDest = join(dir, "google-contacts");
    cpSync(
      join(repositoryRoot(), "skills", "in-progress", "google-contacts"),
      skillDest,
      { recursive: true },
    );
    const bundlePath = join(skillDest, "dist", "cli.mjs");
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const ledgerDir = join(dir, "ledger");
    const c1 = sampleContact("c1", {
      phoneNumbers: [{ value: "0491 570 601", type: "mobile" }],
    });
    const c2 = sampleContact("c2", {
      phoneNumbers: [{ value: "0491 570 602", type: "mobile" }],
    });
    const gogDir = join(dir, "gog");
    mkdirSync(gogDir, { recursive: true });
    const gog = createGogStub(gogDir, {
      account: "owner@example.com",
      contacts: [c1, c2],
      gmailThreads: { t1: { snippet: "Hi from Acme", date: "2026-11-20" } },
    });
    const env = minimalEnv({
      HOME: homeDir,
      GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir,
      GOOGLE_CONTACTS_GOG_BIN: gog.binPath,
    });

    const doc = runBundle(bundlePath, dir, env, [
      "doctor",
      "--account",
      "owner@example.com",
      "--json",
    ]);
    expect(doc.exitCode).toBe(0);
    expect(doc.data).toMatchObject({ ready: true });
    expect(existsSync(ledgerDir)).toBe(false);

    const snap = runBundle(bundlePath, dir, env, [
      "snapshot",
      "--account",
      "owner@example.com",
      "--json",
    ]);
    expect(snap.exitCode).toBe(0);
    const snapFile = join(dir, "snap.json");
    writeFileSync(snapFile, snap.stdout, "utf8");

    const audit = runBundle(bundlePath, dir, env, [
      "audit",
      "--snapshot",
      snapFile,
      "--json",
    ]);
    expect(audit.exitCode).toBe(0);
    const auditFile = join(dir, "audit.json");
    writeFileSync(auditFile, audit.stdout, "utf8");

    const ev = runBundle(bundlePath, dir, env, [
      "evidence",
      "--snapshot",
      snapFile,
      "--lane",
      "gmail",
      "--lane",
      "web-queue",
      "--json",
    ]);
    expect(ev.exitCode).toBe(0);

    const planC1 = runBundle(bundlePath, dir, env, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "phone-normalize",
      "--audit",
      auditFile,
      "--contact",
      "people/c1",
      "--json",
    ]);
    expect(planC1.exitCode).toBe(0);
    const planC1File = join(dir, "plan-c1.json");
    writeFileSync(planC1File, planC1.stdout, "utf8");
    const sealC1 = readSeal(planC1.data);

    const planC2 = runBundle(bundlePath, dir, env, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "phone-normalize",
      "--audit",
      auditFile,
      "--contact",
      "people/c2",
      "--json",
    ]);
    const planC2File = join(dir, "plan-c2.json");
    writeFileSync(planC2File, planC2.stdout, "utf8");
    const sealC2 = readSeal(planC2.data);

    const holdDir = join(dir, "hold");
    mkdirSync(holdDir, { recursive: true });
    const holdReady = join(holdDir, "lock-ready");
    const holdRelease = join(holdDir, "lock-release");
    const holdGog = createGogStub(holdDir, {
      account: "owner@example.com",
      contacts: [c1, c2],
      behavior: {
        holdLockReadyFile: holdReady,
        holdLockReleaseFile: holdRelease,
      },
    });
    const holdEnv = minimalEnv({
      HOME: homeDir,
      GOOGLE_CONTACTS_LEDGER_DIR: ledgerDir,
      GOOGLE_CONTACTS_GOG_BIN: holdGog.binPath,
    });
    const procA = spawnOwnedProcess(
      [
        process.execPath,
        bundlePath,
        "apply",
        "--plan",
        planC1File,
        "--seal",
        sealC1,
        "--json",
      ],
      { cwd: dir, env: holdEnv },
    );
    await waitForFile(holdReady, { abandonWhen: procA.exited });

    const procB = runBundle(bundlePath, dir, holdEnv, [
      "apply",
      "--plan",
      planC1File,
      "--seal",
      sealC1,
      "--json",
    ]);
    expect(procB.exitCode).toBe(3);
    expect(procB.causeCode).toBe("DOMAIN_CONTACTS_APPLY_HELD");

    writeFileSync(holdRelease, "go", "utf8");
    const exitA = await procA.exited;
    expect(exitA).toBe(0);
    expect(statSync(ledgerDir).mode & 0o777).toBe(0o700);

    const sigDir = join(dir, "sigterm");
    mkdirSync(sigDir, { recursive: true });
    const sigLedger = join(sigDir, "ledger");
    const hangReady = join(sigDir, "hang-ready");
    const hangGog = createGogStub(sigDir, {
      account: "owner@example.com",
      contacts: [c1, c2],
      behavior: { hangOnContact: "people/c1", hangReadyFile: hangReady },
    });
    const sigEnv = minimalEnv({
      HOME: homeDir,
      GOOGLE_CONTACTS_LEDGER_DIR: sigLedger,
      GOOGLE_CONTACTS_GOG_BIN: hangGog.binPath,
    });
    const victim = spawnOwnedProcess(
      [
        process.execPath,
        bundlePath,
        "apply",
        "--plan",
        planC1File,
        "--seal",
        sealC1,
        "--json",
      ],
      { cwd: dir, env: sigEnv },
    );
    await waitForFile(hangReady, { abandonWhen: victim.exited });
    victim.kill("SIGTERM");
    const victimExit = await victim.exited;
    expect(victimExit).toBe(143);

    const blockedC1 = runBundle(bundlePath, dir, sigEnv, [
      "apply",
      "--plan",
      planC1File,
      "--seal",
      sealC1,
      "--json",
    ]);
    expect(blockedC1.exitCode).toBe(3);
    expect(blockedC1.causeCode).toBe("DOMAIN_CONTACTS_APPLY_UNRESOLVED");

    const pendingRes = runBundle(bundlePath, dir, sigEnv, [
      "pending",
      "--json",
    ]);
    expect(pendingRes.exitCode).toBe(0);
    expect(pendingRes.data).toMatchObject({
      unfinished: [
        {
          commandIdentity: "google-contacts.apply",
          targets: ["owner@example.com:people/c1"],
          revisions: { "owner@example.com:people/c1": "etag-c1-v1" },
        },
      ],
    });

    const siblingC2 = runBundle(bundlePath, dir, sigEnv, [
      "apply",
      "--plan",
      planC2File,
      "--seal",
      sealC2,
      "--json",
    ]);
    expect(siblingC2.exitCode).toBe(0);
    expect(siblingC2.causeCode).toBe("SUCCESS_COMPLETED");
  } finally {
    removeOwnedFolder(dir);
  }
});
