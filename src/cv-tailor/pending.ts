import { command, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import {
  cvTailorCauses,
  noEffects,
  noInput,
  stationWords,
  SUCCESS_UNCHANGED,
} from "./causes.ts";
import { compareCodeUnit } from "./settings.ts";
import type { StateDirResolution } from "./settings.ts";

export type PendingDeps = {
  readonly stateResolution: StateDirResolution;
  readonly state: ReturnType<typeof stateAddon>;
};

type PendingItem = {
  readonly operationId: string;
  readonly commandIdentity: string;
  readonly status: string;
  readonly effects: readonly string[];
  readonly targets: readonly string[];
};

export function createPendingCommand(deps: PendingDeps) {
  return command({
    identity: "cv-tailor.pending",
    route: ["pending"],
    summary: "List unfinished cv build or pile make runs recorded in state.",
    input: noInput,
    capabilities: {},
    stations: [
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pending",
        causeCode: SUCCESS_UNCHANGED,
        trigger: "State folder inspected and unfinished runs listed.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Check each unfinished cv build or pile make target before repeating work on that scope.",
          },
        },
        repairAction: null,
        independentObservable: "cv-tailor.pending:listed",
      }),
      station(cvTailorCauses, {
        ...stationWords,
        commandIdentity: "cv-tailor.pending",
        causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
        trigger: "The state folder is invalid, unreadable, or corrupt.",
        guidance: {
          handoff: {
            owner: "human",
            reason: "The cv-tailor state folder cannot be read.",
            inspect: [
              {
                kind: "instruction",
                text: "Verify CV_TAILOR_STATE_DIR or HOME points to an absolute, readable folder.",
              },
            ],
          },
        },
        repairAction:
          "Set CV_TAILOR_STATE_DIR or HOME to an absolute path pointing to a readable state folder.",
        independentObservable: "cv-tailor.pending:state-unavailable",
      }),
    ],
    run: async (_input, context) => {
      if (!deps.stateResolution.ok) {
        return context.result(
          {
            commandIdentity: "cv-tailor.pending",
            causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
          },
          {
            message: deps.stateResolution.detail,
            data: null,
            effects: noEffects,
          },
        );
      }
      const report = deps.state.report();
      if (!report.ok) {
        if (report.reason === "missing") {
          return context.result(
            {
              commandIdentity: "cv-tailor.pending",
              causeCode: SUCCESS_UNCHANGED,
            },
            {
              message: "0 unfinished runs.",
              data: { unfinished: [] },
              effects: noEffects,
            },
          );
        }
        return context.result(
          {
            commandIdentity: "cv-tailor.pending",
            causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
          },
          {
            message: `State folder could not be read (${report.reason}).`,
            data: null,
            effects: noEffects,
          },
        );
      }

      const unfinished: PendingItem[] = [];
      for (const entry of report.unfinished) {
        const history = await deps.state.history(entry.operationId);
        if (!history.ok) {
          return context.result(
            {
              commandIdentity: "cv-tailor.pending",
              causeCode: "DOMAIN_CV_TAILOR_STATE_UNAVAILABLE",
            },
            {
              message: `Failed to read history for ${entry.operationId} (${history.reason}).`,
              data: null,
              effects: noEffects,
            },
          );
        }
        const targets: string[] = [];
        for (const resource of history.history.scope.resources) {
          for (const key of resource.keys) {
            targets.push(key.replace(/^key:/, ""));
          }
        }
        targets.sort(compareCodeUnit);
        unfinished.push({
          operationId: history.history.operationId,
          commandIdentity: history.history.commandIdentity,
          status: history.history.status,
          effects: history.history.effects,
          targets,
        });
      }

      return context.result(
        {
          commandIdentity: "cv-tailor.pending",
          causeCode: SUCCESS_UNCHANGED,
        },
        {
          message: `${String(unfinished.length)} unfinished run(s).`,
          data: { unfinished },
          effects: noEffects,
        },
      );
    },
  });
}
