import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import { compareCodeUnit, sha256Hex } from "./domain/rules.ts";

export type LedgerResolution =
  | {
      readonly ok: true;
      readonly root: string;
      readonly source: "GOOGLE_CONTACTS_LEDGER_DIR" | "XDG_STATE_HOME" | "HOME";
    }
  | {
      readonly ok: false;
      readonly reason: "relative-ledger-dir" | "invalid-home";
      readonly path: string;
      readonly detail: string;
    };

export function resolveLedgerRoot(
  env: Readonly<Record<string, string | undefined>>,
): LedgerResolution {
  const explicit = env.GOOGLE_CONTACTS_LEDGER_DIR;
  if (explicit !== undefined && explicit.trim().length > 0) {
    if (!isAbsolute(explicit)) {
      return {
        ok: false,
        reason: "relative-ledger-dir",
        path: explicit,
        detail: "GOOGLE_CONTACTS_LEDGER_DIR must be an absolute path.",
      };
    }
    return {
      ok: true,
      root: explicit,
      source: "GOOGLE_CONTACTS_LEDGER_DIR",
    };
  }
  const xdgState = env.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState.length > 0 && isAbsolute(xdgState)) {
    return {
      ok: true,
      root: join(xdgState, "nathanvale-skills", "google-contacts", "ledger"),
      source: "XDG_STATE_HOME",
    };
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0 || !isAbsolute(home)) {
    return {
      ok: false,
      reason: "invalid-home",
      path: home ?? "",
      detail:
        "HOME must be set to an absolute path when GOOGLE_CONTACTS_LEDGER_DIR and XDG_STATE_HOME are unset or relative.",
    };
  }
  return {
    ok: true,
    root: join(
      home,
      ".local",
      "state",
      "nathanvale-skills",
      "google-contacts",
      "ledger",
    ),
    source: "HOME",
  };
}

const SCOPE_KEY_PATTERN = /^[\p{L}\p{N}._:/@+-]{1,256}$/u;

export function contactScopeKey(account: string, resourceName: string): string {
  const lowered = account.trim().toLowerCase();
  const direct = `${lowered}:${resourceName}`;
  if (direct.length <= 256 && SCOPE_KEY_PATTERN.test(direct)) {
    return direct;
  }
  const hashed = `acct-${sha256Hex(lowered).slice(0, 16)}:${resourceName}`;
  return hashed.slice(0, 256);
}

export type LedgerHealthSummary = {
  readonly ready: boolean;
  readonly status:
    | "ok"
    | "missing-will-create-on-apply"
    | "invalid-path"
    | "unreadable"
    | "corrupt";
  readonly root: string;
  readonly source: string;
  readonly existsOnDisk: boolean;
  readonly unfinishedCount: number;
  readonly detail: string;
};

export function inspectLedgerReadOnly(
  resolution: LedgerResolution,
  state: ReturnType<typeof stateAddon>,
): LedgerHealthSummary {
  if (!resolution.ok) {
    return {
      ready: false,
      status: "invalid-path",
      root: resolution.path,
      source: resolution.reason,
      existsOnDisk: false,
      unfinishedCount: 0,
      detail: resolution.detail,
    };
  }
  const existsOnDisk = existsSync(resolution.root);
  const report = state.report();
  if (report.ok) {
    return {
      ready: true,
      status: "ok",
      root: resolution.root,
      source: resolution.source,
      existsOnDisk,
      unfinishedCount: report.unfinished.length,
      detail:
        report.unfinished.length === 0
          ? "Contact ledger is healthy with zero unfinished mutations."
          : `Contact ledger has ${String(report.unfinished.length)} unfinished mutation(s).`,
    };
  }
  if (report.reason === "missing") {
    return {
      ready: true,
      status: "missing-will-create-on-apply",
      root: resolution.root,
      source: resolution.source,
      existsOnDisk,
      unfinishedCount: 0,
      detail:
        "Contact ledger does not exist yet and will be created with mode 0700 on first apply.",
    };
  }
  return {
    ready: false,
    status: report.reason,
    root: resolution.root,
    source: resolution.source,
    existsOnDisk,
    unfinishedCount: 0,
    detail: `Contact ledger is ${report.reason}.`,
  };
}

export type PendingMutationItem = {
  readonly operationId: string;
  readonly commandIdentity: string;
  readonly status: string;
  readonly effects: readonly string[];
  readonly targets: readonly string[];
  readonly revisions: Readonly<Record<string, string>>;
};

export async function readPendingMutations(
  resolution: LedgerResolution,
  state: ReturnType<typeof stateAddon>,
): Promise<
  | { readonly ok: true; readonly items: readonly PendingMutationItem[] }
  | { readonly ok: false; readonly detail: string }
> {
  if (!resolution.ok) {
    return { ok: false, detail: resolution.detail };
  }
  const report = state.report();
  if (!report.ok) {
    if (report.reason === "missing") {
      return { ok: true, items: [] };
    }
    return {
      ok: false,
      detail: `Contact ledger could not be read (${report.reason}).`,
    };
  }
  const items: PendingMutationItem[] = [];
  for (const entry of report.unfinished) {
    const history = await state.history(entry.operationId);
    if (!history.ok) {
      return {
        ok: false,
        detail: `Failed to read history for ${entry.operationId} (${history.reason}).`,
      };
    }
    const targetKeys: string[] = [];
    for (const resource of history.history.scope.resources) {
      for (const key of resource.keys) {
        targetKeys.push(key.replace(/^key:/, ""));
      }
    }
    targetKeys.sort(compareCodeUnit);
    items.push({
      operationId: history.history.operationId,
      commandIdentity: history.history.commandIdentity,
      status: history.history.status,
      effects: history.history.effects,
      targets: targetKeys,
      revisions: history.history.revisions,
    });
  }
  return { ok: true, items };
}
