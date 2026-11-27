import { randomInt } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compareCodeUnit, loadSettings } from "../settings.ts";
import type { StateDirResolution } from "../settings.ts";
import { buildPiles } from "./rules.ts";
import type { BuiltPilesResult, CompetitorPage } from "./rules.ts";

export type PilePreflightDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stateResolution: StateDirResolution;
  readonly cwd: string;
};

export type PilePreflightReady = {
  readonly ok: true;
  readonly testsDir: string;
  readonly pilesDir: string;
  readonly keyPath: string;
  readonly built: BuiltPilesResult;
};

export type PilePreflightFailure = {
  readonly ok: false;
  readonly causeCode:
    | "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE"
    | "DOMAIN_CV_TAILOR_PILE_INPUT_INVALID"
    | "DOMAIN_CV_TAILOR_PILES_EXIST"
    | "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE";
  readonly message: string;
};

export function runPilePreflight(
  deps: PilePreflightDeps,
  input: {
    readonly "--tests": string;
    readonly "--new": string;
    readonly "--old": string;
    readonly "--runs"?: number | undefined;
    readonly "--seed"?: number | undefined;
    readonly "--replace"?: boolean | undefined;
  },
): PilePreflightReady | PilePreflightFailure {
  if (!deps.stateResolution.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
      message: deps.stateResolution.detail,
    };
  }

  const testsDir = resolve(deps.cwd, input["--tests"]);
  const syntheticDir = join(testsDir, "synthetic");
  if (!existsSync(syntheticDir)) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_PILE_INPUT_INVALID",
      message: `Synthetic folder not found: ${syntheticDir}. Add at least two .txt competitor pages.`,
    };
  }

  const syntheticNames = readdirSync(syntheticDir)
    .filter((name) => name.endsWith(".txt"))
    .sort(compareCodeUnit);
  if (syntheticNames.length < 2) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_PILE_INPUT_INVALID",
      message: `Need at least two .txt pages in ${syntheticDir}, found ${String(syntheticNames.length)}.`,
    };
  }

  const pilesDir = join(testsDir, "piles");
  if (
    existsSync(pilesDir) &&
    readdirSync(pilesDir).length > 0 &&
    input["--replace"] !== true
  ) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_PILES_EXIST",
      message: `${pilesDir} already has files; pass --replace to overwrite them.`,
    };
  }

  let newPageText: string;
  let oldPageText: string;
  const competitors: CompetitorPage[] = [];
  try {
    newPageText = readFileSync(resolve(deps.cwd, input["--new"]), "utf8");
    oldPageText = readFileSync(resolve(deps.cwd, input["--old"]), "utf8");
    for (const fileName of syntheticNames) {
      competitors.push({
        name: basename(fileName, ".txt"),
        text: readFileSync(join(syntheticDir, fileName), "utf8"),
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_PILE_INPUT_INVALID",
      message: `Cannot read pile input file: ${detail}`,
    };
  }

  const seed = input["--seed"] ?? randomInt(1_000_000);
  const runs = input["--runs"] ?? 3;
  const built = buildPiles({
    competitors,
    newPageText,
    oldPageText,
    runs,
    seed,
  });
  const keyPath = join(testsDir, "pile-key.txt");

  const settingsRes = loadSettings(deps.env, undefined, deps.cwd);
  const baselineCv = settingsRes.ok
    ? settingsRes.values.baselineCv.value
    : null;
  if (baselineCv !== null) {
    const resolvedTemplate = resolve(baselineCv);
    const outputs = [
      keyPath,
      ...built.piles.map((pile) => join(pilesDir, pile.filename)),
    ];
    if (outputs.some((outPath) => resolve(outPath) === resolvedTemplate)) {
      return {
        ok: false,
        causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE",
        message: `Pile output would overwrite template ${baselineCv}.`,
      };
    }
  }

  return { ok: true, testsDir, pilesDir, keyPath, built };
}
