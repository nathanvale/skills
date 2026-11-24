import { expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";
import {
  createGogStub,
  sampleContact,
  sampleSnapshot,
} from "./support/google-contacts-stubs.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

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

test("Option 1 XDG ledger enforces 0700 lazy creation, preserves existing perms, and ignores relative/empty XDG_STATE_HOME", () => {
  const dir = testFolder("gc-xdg-option1-");
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
    const c1 = sampleContact("c1", {
      phoneNumbers: [{ value: "0491 570 701", type: "mobile" }],
    });
    const snapFile = join(dir, "snap.json");
    writeFileSync(snapFile, JSON.stringify(sampleSnapshot([c1])), "utf8");
    const baseEnv = minimalEnv({ HOME: homeDir });
    const audit = runBundle(bundlePath, dir, baseEnv, [
      "audit",
      "--snapshot",
      snapFile,
      "--json",
    ]);
    const auditFile = join(dir, "audit.json");
    writeFileSync(auditFile, audit.stdout, "utf8");
    const plan = runBundle(bundlePath, dir, baseEnv, [
      "plan",
      "--snapshot",
      snapFile,
      "--lane",
      "phone-normalize",
      "--audit",
      auditFile,
      "--json",
    ]);
    const planFile = join(dir, "plan.json");
    writeFileSync(planFile, plan.stdout, "utf8");
    const seal = readSeal(plan.data);

    const gog1Dir = join(dir, "gog1");
    mkdirSync(gog1Dir, { recursive: true });
    const gog1 = createGogStub(gog1Dir, {
      account: "owner@example.com",
      contacts: [c1],
    });
    const relLedgerEnv = minimalEnv({
      HOME: homeDir,
      GOOGLE_CONTACTS_LEDGER_DIR: "rel-ledger-never-create",
      GOOGLE_CONTACTS_GOG_BIN: gog1.binPath,
    });
    expect(
      runBundle(bundlePath, dir, relLedgerEnv, ["doctor", "--json"]).data,
    ).toMatchObject({ ready: false });
    expect(
      runBundle(bundlePath, dir, relLedgerEnv, ["pending", "--json"]).causeCode,
    ).toBe("DOMAIN_CONTACTS_LEDGER_UNREADABLE");
    expect(
      runBundle(bundlePath, dir, relLedgerEnv, [
        "apply",
        "--plan",
        planFile,
        "--seal",
        seal,
        "--json",
      ]).causeCode,
    ).toBe("DOMAIN_CONTACTS_APPLY_UNAVAILABLE");
    expect(existsSync(join(dir, "rel-ledger-never-create"))).toBe(false);

    const absXdg = join(dir, "xdg-state");
    const expectedXdgLedger = join(
      absXdg,
      "nathanvale-skills",
      "google-contacts",
      "ledger",
    );
    const xdgEnv = minimalEnv({
      HOME: homeDir,
      XDG_STATE_HOME: absXdg,
      GOOGLE_CONTACTS_GOG_BIN: gog1.binPath,
    });
    expect(
      runBundle(bundlePath, dir, xdgEnv, ["pending", "--json"]).data,
    ).toMatchObject({ ledgerRoot: expectedXdgLedger, unfinished: [] });
    expect(existsSync(expectedXdgLedger)).toBe(false);
    expect(
      runBundle(bundlePath, dir, xdgEnv, [
        "apply",
        "--plan",
        planFile,
        "--seal",
        seal,
        "--json",
      ]).causeCode,
    ).toBe("SUCCESS_COMPLETED");
    expect(existsSync(expectedXdgLedger)).toBe(true);
    expect(statSync(expectedXdgLedger).mode & 0o777).toBe(0o700);

    const gog2Dir = join(dir, "gog2");
    mkdirSync(gog2Dir, { recursive: true });
    const gog2 = createGogStub(gog2Dir, {
      account: "owner@example.com",
      contacts: [c1],
    });
    const relXdgEnv = minimalEnv({
      HOME: homeDir,
      XDG_STATE_HOME: "relative/xdg",
      GOOGLE_CONTACTS_GOG_BIN: gog2.binPath,
    });
    const homeFallbackLedger = join(
      homeDir,
      ".local",
      "state",
      "nathanvale-skills",
      "google-contacts",
      "ledger",
    );
    expect(
      runBundle(bundlePath, dir, relXdgEnv, ["pending", "--json"]).data,
    ).toMatchObject({ ledgerRoot: homeFallbackLedger, unfinished: [] });
    expect(
      runBundle(bundlePath, dir, relXdgEnv, [
        "apply",
        "--plan",
        planFile,
        "--seal",
        seal,
        "--json",
      ]).causeCode,
    ).toBe("SUCCESS_COMPLETED");
    expect(existsSync(homeFallbackLedger)).toBe(true);
    expect(statSync(homeFallbackLedger).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, "relative"))).toBe(false);

    const emptyXdgEnv = minimalEnv({
      HOME: homeDir,
      XDG_STATE_HOME: "",
      GOOGLE_CONTACTS_GOG_BIN: gog2.binPath,
    });
    expect(
      runBundle(bundlePath, dir, emptyXdgEnv, ["pending", "--json"]).data,
    ).toMatchObject({ ledgerRoot: homeFallbackLedger });

    const preExistingLedger = join(dir, "preexisting-ledger");
    mkdirSync(preExistingLedger, { recursive: true, mode: 0o750 });
    const beforeMode = statSync(preExistingLedger).mode & 0o777;
    const gog3Dir = join(dir, "gog3");
    mkdirSync(gog3Dir, { recursive: true });
    const gog3 = createGogStub(gog3Dir, {
      account: "owner@example.com",
      contacts: [c1],
    });
    const preEnv = minimalEnv({
      HOME: homeDir,
      GOOGLE_CONTACTS_LEDGER_DIR: preExistingLedger,
      GOOGLE_CONTACTS_GOG_BIN: gog3.binPath,
    });
    expect(
      runBundle(bundlePath, dir, preEnv, [
        "apply",
        "--plan",
        planFile,
        "--seal",
        seal,
        "--json",
      ]).causeCode,
    ).toBe("SUCCESS_COMPLETED");
    expect(statSync(preExistingLedger).mode & 0o777).toBe(beforeMode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
