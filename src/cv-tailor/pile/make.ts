import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { changing, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import {
  cvTailorCauses,
  FILE_PATH_VALUE,
  noEffects,
  noInput,
  stationWords,
  SUCCESS_COMPLETED,
} from "../causes.ts";
import { scopeKeyForPath } from "../settings.ts";
import type { StateDirResolution } from "../settings.ts";
import { runPilePreflight } from "./make-preflight.ts";

export type PileMakeDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stateResolution: StateDirResolution;
  readonly state: ReturnType<typeof stateAddon>;
  readonly cwd: string;
};

function pileHandoff(reason: string) {
  return {
    handoff: {
      owner: "human" as const,
      reason,
      inspect: [
        {
          kind: "command" as const,
          command: "cv-tailor.pending" as const,
          args: [] as const,
        },
      ],
    },
  } as const;
}

export function createPileMakeCommand(deps: PileMakeDeps) {
  return changing({
    identity: "cv-tailor.pile-make",
    route: ["pile", "make"],
    summary:
      "Shuffle candidate page one into fictional competitor piles and write the key outside piles/.",
    input: {
      ...noInput,
      options: [
        {
          name: "--tests",
          aliases: [],
          summary: "Tests folder containing synthetic/*.txt.",
          required: true,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--new",
          aliases: [],
          summary: "Path to the tailored CV page-one text file.",
          required: true,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--old",
          aliases: [],
          summary: "Path to the baseline CV page-one text file.",
          required: true,
          repeatable: false,
          value: FILE_PATH_VALUE,
        },
        {
          name: "--runs",
          aliases: [],
          summary: "Number of piles with the new page (default 3).",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 100 },
        },
        {
          name: "--seed",
          aliases: [],
          summary: "Deterministic integer seed recorded in pile-key.txt.",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 0, maximum: 2_147_483_647 },
        },
        {
          name: "--replace",
          aliases: [],
          summary: "Replace existing files in piles/.",
          required: false,
          repeatable: false,
          value: null,
        },
      ],
    },
    capabilities: {},
    effectClass: "repository-local",
    effects: ["pile.files.write", "pile.key.write"],
    ifNoResult: deps.state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_CV_TAILOR_PILE_HELD",
    unresolvedCaseCause: "DOMAIN_CV_TAILOR_PILE_UNRESOLVED",
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: SUCCESS_COMPLETED,
        trigger: "All piles and pile-key.txt were written and confirmed.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "cv-tailor.pile-make:completed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
        trigger: "The state folder is invalid or unavailable.",
        guidance: pileHandoff("The cv-tailor state folder is unavailable."),
        repairAction:
          "Set CV_TAILOR_STATE_DIR or HOME to an absolute path pointing to a readable folder.",
        independentObservable: "cv-tailor.pile-make:state-unavailable",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_PILE_INPUT_INVALID",
        trigger:
          "synthetic/*.txt has fewer than two files or an input page is unreadable.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Place at least two .txt files under synthetic/ and verify --new and --old paths.",
          },
        },
        repairAction:
          "Ensure synthetic/*.txt has at least two files and --new/--old are readable.",
        independentObservable: "cv-tailor.pile-make:input-invalid",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_PILES_EXIST",
        trigger: "piles/ already contains files and --replace was not passed.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass --replace to overwrite the existing piles.",
          },
        },
        repairAction: "Re-run pile make with --replace.",
        independentObservable: "cv-tailor.pile-make:piles-exist",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE",
        trigger:
          "A pile output path would overwrite the configured baselineCv template.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Choose a --tests folder separate from the template file.",
          },
        },
        repairAction:
          "Pass a --tests folder that does not collide with baselineCv.",
        independentObservable: "cv-tailor.pile-make:template-overwrite",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_PILE_HELD",
        trigger: "Another pile make holds a lock on this tests folder.",
        guidance: pileHandoff(
          "Another pile make is active for this tests folder.",
        ),
        repairAction:
          "Wait for the active pile make to finish, then inspect with pending.",
        independentObservable: "cv-tailor.pile-make:held",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_PILE_UNRESOLVED",
        trigger: "An earlier pile make for this tests folder never finished.",
        guidance: pileHandoff(
          "An earlier pile make for this tests folder is unresolved.",
        ),
        repairAction:
          "Run pending to inspect the unfinished pile run and check the tests folder by hand.",
        independentObservable: "cv-tailor.pile-make:unresolved",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_PILE_UNAVAILABLE",
        trigger: "The state store could not start the transaction.",
        guidance: pileHandoff(
          "The cv-tailor state store could not start pile make.",
        ),
        repairAction:
          "Run pending and check state folder permissions before retrying.",
        independentObservable: "cv-tailor.pile-make:unavailable",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_PILE_PARTIAL",
        trigger: "Pile files confirmed but pile-key.txt never started.",
        guidance: pileHandoff(
          "pile make wrote piles but did not write pile-key.txt.",
        ),
        repairAction: "Run pending and inspect the tests folder by hand.",
        independentObservable: "cv-tailor.pile-make:partial",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pile-make",
        causeCode: "DOMAIN_CV_TAILOR_PILE_UNCONFIRMED",
        trigger:
          "A pile write or key write could not be confirmed on read-back.",
        guidance: pileHandoff("An effect in pile make could not be confirmed."),
        repairAction:
          "Run pending to inspect the unfinished pile run and check the tests folder by hand.",
        independentObservable: "cv-tailor.pile-make:unconfirmed",
      }),
    ],
    run: async (input, context) => {
      const preflight = runPilePreflight(deps, input);
      if (!preflight.ok) {
        return context.result(
          {
            commandIdentity: "cv-tailor.pile-make",
            causeCode: preflight.causeCode,
          },
          { message: preflight.message, data: null, effects: noEffects },
        );
      }

      const folderKey = scopeKeyForPath(preflight.testsDir);
      const outcome = await deps.state.transaction(
        context.state,
        {
          command: "cv-tailor.pile-make",
          scope: { resources: [{ resource: "pile-folder", key: folderKey }] },
          facts: {
            testsDir: preflight.testsDir,
            seed: String(preflight.built.seed),
            pileCount: String(preflight.built.piles.length),
          },
        },
        async (transaction) => {
          let pilesConfirmed = false;
          await transaction.record(
            "pile.files.write",
            () => {
              mkdirSync(preflight.pilesDir, { recursive: true });
              for (const existing of readdirSync(preflight.pilesDir)) {
                if (/^pile-\d+\.txt$/.test(existing)) {
                  rmSync(join(preflight.pilesDir, existing), { force: true });
                }
              }
              for (const pile of preflight.built.piles) {
                writeFileSync(
                  join(preflight.pilesDir, pile.filename),
                  pile.content,
                  "utf8",
                );
              }
              return Promise.resolve();
            },
            () => {
              pilesConfirmed = preflight.built.piles.every(
                (pile) =>
                  readFileSync(
                    join(preflight.pilesDir, pile.filename),
                    "utf8",
                  ) === pile.content,
              );
              return Promise.resolve(pilesConfirmed);
            },
          );
          if (!pilesConfirmed) return;

          await transaction.record(
            "pile.key.write",
            () => {
              writeFileSync(preflight.keyPath, preflight.built.keyText, "utf8");
              return Promise.resolve();
            },
            () =>
              Promise.resolve(
                readFileSync(preflight.keyPath, "utf8") ===
                  preflight.built.keyText,
              ),
          );
        },
      );

      if (outcome.kind === "held-lock") {
        return context.result(
          {
            commandIdentity: "cv-tailor.pile-make",
            causeCode: "DOMAIN_CV_TAILOR_PILE_HELD",
          },
          {
            message: `Another pile make (${outcome.operationId}) holds a lock on ${preflight.testsDir}.`,
            data: null,
            effects: noEffects,
          },
        );
      }
      if (outcome.kind === "unresolved-case") {
        return context.result(
          {
            commandIdentity: "cv-tailor.pile-make",
            causeCode: "DOMAIN_CV_TAILOR_PILE_UNRESOLVED",
          },
          {
            message: `Unfinished pile make (${outcome.operationId}) blocks ${preflight.testsDir}.`,
            data: null,
            effects: noEffects,
          },
        );
      }
      if (
        outcome.kind !== "ran" ||
        outcome.proof.transactionState === "unchanged"
      ) {
        return context.result(
          {
            commandIdentity: "cv-tailor.pile-make",
            causeCode: "DOMAIN_CV_TAILOR_PILE_UNAVAILABLE",
          },
          {
            message: "State store could not start the pile make transaction.",
            data: null,
            effects: noEffects,
          },
        );
      }
      if (outcome.proof.transactionState !== "completed") {
        const isPartial =
          outcome.proof.transactionState === "partially-completed";
        return context.result(
          {
            commandIdentity: "cv-tailor.pile-make",
            causeCode: isPartial
              ? "DOMAIN_CV_TAILOR_PILE_PARTIAL"
              : "DOMAIN_CV_TAILOR_PILE_UNCONFIRMED",
          },
          {
            message: isPartial
              ? "pile make wrote piles but did not start writing pile-key.txt."
              : "pile make could not confirm its output.",
            data: null,
            transaction: outcome.proof,
          },
        );
      }

      return context.result(
        {
          commandIdentity: "cv-tailor.pile-make",
          causeCode: SUCCESS_COMPLETED,
        },
        {
          message: `Wrote ${String(preflight.built.piles.length)} piles to ${preflight.pilesDir} and key to ${preflight.keyPath}.`,
          data: {
            seed: preflight.built.seed,
            pilesDir: preflight.pilesDir,
            keyFile: preflight.keyPath,
            piles: preflight.built.piles.map((pile) => ({
              filename: pile.filename,
              version: pile.version,
              targetPosition: pile.targetPosition,
              targetCandidate: `C${String(pile.targetPosition + 1)}`,
            })),
            keyLines: preflight.built.keyLines,
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
