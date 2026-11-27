import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createCvTailorRunner } from "./support/cv-tailor-run.ts";
import { testFolder } from "./support/test-folder.ts";

const fixtureDir = resolve(import.meta.dir, "fixtures", "cv-tailor");

function setupTestsDir(root: string): {
  readonly testsDir: string;
  readonly newPage: string;
  readonly oldPage: string;
} {
  const testsDir = join(root, "tests");
  cpSync(join(fixtureDir, "synthetic"), join(testsDir, "synthetic"), {
    recursive: true,
  });
  const newPage = join(testsDir, "new-p1.txt");
  const oldPage = join(testsDir, "old-p1.txt");
  writeFileSync(
    newPage,
    "Alex Example\nTailored Senior Platform Engineer\n",
    "utf8",
  );
  writeFileSync(oldPage, "Alex Example\nGeneric Software Engineer\n", "utf8");
  return { testsDir, newPage, oldPage };
}

function readNewTargetPositions(data: unknown): readonly number[] {
  if (typeof data !== "object" || data === null) return [];
  const piles: unknown = Reflect.get(data, "piles");
  if (!Array.isArray(piles)) return [];
  const positions: number[] = [];
  for (const item of piles) {
    if (typeof item !== "object" || item === null) continue;
    const version: unknown = Reflect.get(item, "version");
    const pos: unknown = Reflect.get(item, "targetPosition");
    if (version === "new" && typeof pos === "number") {
      positions.push(pos);
    }
  }
  return positions;
}

test("pile make --seed 7 run twice gives byte-identical piles and key outside piles/ with distinct new positions", async () => {
  const scratchA = testFolder("cv-tailor-pile-a-");
  const scratchB = testFolder("cv-tailor-pile-b-");
  try {
    const setupA = setupTestsDir(scratchA);
    const setupB = setupTestsDir(scratchB);

    const runA = createCvTailorRunner({
      env: {
        ...process.env,
        CV_TAILOR_STATE_DIR: join(scratchA, "state"),
        CV_TAILOR_SETTINGS_FILE: join(scratchA, "settings.json"),
      },
      cwd: scratchA,
    });
    const runB = createCvTailorRunner({
      env: {
        ...process.env,
        CV_TAILOR_STATE_DIR: join(scratchB, "state"),
        CV_TAILOR_SETTINGS_FILE: join(scratchB, "settings.json"),
      },
      cwd: scratchB,
    });

    const resA = await runA([
      "pile",
      "make",
      "--tests",
      setupA.testsDir,
      "--new",
      setupA.newPage,
      "--old",
      setupA.oldPage,
      "--seed",
      "7",
    ]);
    const resB = await runB([
      "pile",
      "make",
      "--tests",
      setupB.testsDir,
      "--new",
      setupB.newPage,
      "--old",
      setupB.oldPage,
      "--seed",
      "7",
    ]);

    expect(resA.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      data: { seed: 7 },
    });
    expect(resB.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      data: { seed: 7 },
    });

    expect(existsSync(join(setupA.testsDir, "pile-key.txt"))).toBe(true);
    expect(existsSync(join(setupA.testsDir, "piles", "pile-key.txt"))).toBe(
      false,
    );

    const keyA = readFileSync(join(setupA.testsDir, "pile-key.txt"), "utf8");
    const keyB = readFileSync(join(setupB.testsDir, "pile-key.txt"), "utf8");
    expect(keyA).toBe(keyB);

    for (let index = 1; index <= 4; index += 1) {
      const pileA = readFileSync(
        join(setupA.testsDir, "piles", `pile-${String(index)}.txt`),
        "utf8",
      );
      const pileB = readFileSync(
        join(setupB.testsDir, "piles", `pile-${String(index)}.txt`),
        "utf8",
      );
      expect(pileA).toBe(pileB);
    }

    const newPositions = readNewTargetPositions(resA.result.data);
    expect(newPositions.length).toBe(3);
    expect(new Set(newPositions).size).toBe(3);

    const refused = await runA([
      "pile",
      "make",
      "--tests",
      setupA.testsDir,
      "--new",
      setupA.newPage,
      "--old",
      setupA.oldPage,
      "--seed",
      "7",
    ]);
    expect(refused.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_PILES_EXIST",
      transactionState: "unchanged",
    });

    const replaced = await runA([
      "pile",
      "make",
      "--tests",
      setupA.testsDir,
      "--new",
      setupA.newPage,
      "--old",
      setupA.oldPage,
      "--seed",
      "7",
      "--replace",
    ]);
    expect(replaced.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
    });
  } finally {
    rmSync(scratchA, { recursive: true, force: true });
    rmSync(scratchB, { recursive: true, force: true });
  }
});
