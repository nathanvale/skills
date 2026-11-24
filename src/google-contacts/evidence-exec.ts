import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  extractIdentityAnchors,
  findSwitchboardPhones,
  serializeAnchor,
} from "./anchors/rules.ts";
import type {
  ContactRecord,
  ContactSnapshotDoc,
  EvidenceDoc,
  EvidenceItem,
  EvidenceLane,
  EvidenceLaneStatus,
  SerializedIdentityAnchor,
} from "./domain/rules.ts";
import { resolveExecutablePath } from "./gog.ts";
import type { GogRuntimeConfig, PathBoundary } from "./gog.ts";
import { collectGmailEvidenceForContact } from "./gog-gmail.ts";
import {
  fetchImsgChats,
  fetchImsgHistory,
  probeImsgReadiness,
} from "./imsg.ts";
import type { ImsgChatRow, ImsgRuntimeConfig } from "./imsg.ts";
import { buildWebResearchQueue } from "./web-firewall/rules.ts";

export type EvidenceCommandDeps = {
  readonly getBoundary: () => PathBoundary;
  readonly gogConfig: GogRuntimeConfig;
  readonly imsgConfig: ImsgRuntimeConfig;
};

export function parseRequestedLanes(
  raw: readonly string[] | undefined,
): readonly EvidenceLane[] {
  if (raw === undefined || raw.length === 0) {
    return ["gmail", "imsg", "web-queue"];
  }
  const unique = new Set<EvidenceLane>();
  for (const item of raw) {
    if (item === "gmail" || item === "imsg" || item === "web-queue") {
      unique.add(item);
    }
  }
  return [...unique];
}

function matchContactAnchorsToHandle(
  handle: string,
  anchors: readonly SerializedIdentityAnchor[],
): SerializedIdentityAnchor | null {
  const lowered = handle.trim().toLowerCase();
  const digits = lowered.replace(/\D/g, "");
  for (const anchor of anchors) {
    if (anchor.kind === "email" && anchor.value === lowered) return anchor;
    if (anchor.kind === "e164-phone") {
      const aDigits = anchor.value.replace(/\D/g, "");
      if (aDigits.length >= 7 && digits === aDigits) return anchor;
    }
  }
  return null;
}

async function runGmailLane(params: {
  readonly programs: ProgramsCapability;
  readonly boundary: PathBoundary;
  readonly account: string;
  readonly client?: string | undefined;
  readonly targets: readonly ContactRecord[];
  readonly anchorMap: ReadonlyMap<string, readonly SerializedIdentityAnchor[]>;
  readonly maxThreads: number;
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
}): Promise<
  | {
      readonly kind: "ok";
      readonly items: readonly EvidenceItem[];
      readonly status: EvidenceLaneStatus;
    }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const resolved = resolveExecutablePath(
    params.config.gogBinOverride ?? params.config.env.GOOGLE_CONTACTS_GOG_BIN,
    params.config.env.PATH,
    "gog",
    params.boundary,
  );
  if (!resolved.ok) return { kind: "unavailable", detail: resolved.reason };
  const items: EvidenceItem[] = [];
  for (const contact of params.targets) {
    const anchors = params.anchorMap.get(contact.resourceName) ?? [];
    const res = await collectGmailEvidenceForContact({
      programs: params.programs,
      executable: resolved.path,
      account: params.account,
      client: params.client,
      contact,
      anchors,
      maxThreads: params.maxThreads,
      config: params.config,
      aborted: params.aborted,
    });
    if (res.kind !== "ok") return res;
    for (const item of res.items) items.push(item);
  }
  return {
    kind: "ok",
    items,
    status: {
      status: "ready",
      detail: `Collected ${String(items.length)} Gmail evidence item(s).`,
    },
  };
}

async function collectImsgForContact(params: {
  readonly programs: ProgramsCapability;
  readonly executable: ParsedPath;
  readonly contact: ContactRecord;
  readonly anchors: readonly SerializedIdentityAnchor[];
  readonly chats: readonly ImsgChatRow[];
  readonly maxMessages: number;
  readonly config: ImsgRuntimeConfig;
}): Promise<readonly EvidenceItem[]> {
  const items: EvidenceItem[] = [];
  for (const chat of params.chats) {
    const matched = matchContactAnchorsToHandle(
      chat.identifier,
      params.anchors,
    );
    if (matched === null) continue;
    const history = await fetchImsgHistory(
      params.programs,
      params.executable,
      chat.id,
      params.maxMessages,
      params.config,
    );
    if (history === null) continue;
    for (const msg of history) {
      items.push({
        id: `imsg:${params.contact.resourceName}:${chat.id}:${msg.id}`,
        lane: "imsg",
        contactResourceName: params.contact.resourceName,
        anchor: matched,
        sourceRef: `imsg:chat/${chat.id}/msg/${msg.id}`,
        observedAt: msg.date,
        excerpt: msg.text.slice(0, 400),
        query: null,
        suggestedFields: {},
      });
    }
  }
  return items;
}

async function runImsgLane(params: {
  readonly programs: ProgramsCapability;
  readonly boundary: PathBoundary;
  readonly targets: readonly ContactRecord[];
  readonly anchorMap: ReadonlyMap<string, readonly SerializedIdentityAnchor[]>;
  readonly maxChats: number;
  readonly maxMessages: number;
  readonly exclusive: boolean;
  readonly config: ImsgRuntimeConfig;
}): Promise<
  | {
      readonly kind: "ok";
      readonly items: readonly EvidenceItem[];
      readonly status: EvidenceLaneStatus;
    }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const probe = await probeImsgReadiness(
    params.programs,
    params.boundary,
    params.config,
  );
  if (probe.parsedPath === null || probe.readiness.status !== "ready") {
    if (params.exclusive) {
      return { kind: "unavailable", detail: probe.readiness.detail };
    }
    return {
      kind: "ok",
      items: [],
      status: {
        status: probe.readiness.status,
        detail: probe.readiness.detail,
      },
    };
  }
  const chats = await fetchImsgChats(
    params.programs,
    probe.parsedPath,
    params.maxChats,
    params.config,
  );
  if (chats === null) {
    const detail = "imsg chats read failed or exceeded output limit.";
    if (params.exclusive) return { kind: "unavailable", detail };
    return { kind: "ok", items: [], status: { status: "unavailable", detail } };
  }
  const items: EvidenceItem[] = [];
  for (const contact of params.targets) {
    const found = await collectImsgForContact({
      programs: params.programs,
      executable: probe.parsedPath,
      contact,
      anchors: params.anchorMap.get(contact.resourceName) ?? [],
      chats,
      maxMessages: params.maxMessages,
      config: params.config,
    });
    for (const item of found) items.push(item);
  }
  return {
    kind: "ok",
    items,
    status: {
      status: "ready",
      detail: `Scanned up to ${String(params.maxChats)} recent chats; collected ${String(items.length)} item(s).`,
    },
  };
}

export type EvidenceExecutionResult =
  | { readonly kind: "ok"; readonly doc: EvidenceDoc }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

export async function executeEvidenceCollection(params: {
  readonly snapshot: ContactSnapshotDoc;
  readonly lanesRequested: readonly EvidenceLane[];
  readonly targets: readonly ContactRecord[];
  readonly client: string | undefined;
  readonly maxChats: number;
  readonly maxThreads: number;
  readonly maxMessages: number;
  readonly programs: ProgramsCapability;
  readonly aborted: () => boolean;
  readonly deps: EvidenceCommandDeps;
}): Promise<EvidenceExecutionResult> {
  const switchboards = findSwitchboardPhones(params.snapshot.contacts, "AU");
  const anchorMap = new Map<string, readonly SerializedIdentityAnchor[]>();
  for (const contact of params.targets) {
    anchorMap.set(
      contact.resourceName,
      extractIdentityAnchors(contact, "AU", switchboards).map(serializeAnchor),
    );
  }
  const boundary = params.deps.getBoundary();
  const items: EvidenceItem[] = [];
  let gmailStatus: EvidenceLaneStatus = {
    status: "skipped",
    detail: "Gmail lane not requested.",
  };
  let imsgStatus: EvidenceLaneStatus = {
    status: "skipped",
    detail: "imsg lane not requested.",
  };
  if (params.lanesRequested.includes("gmail")) {
    const gRes = await runGmailLane({
      programs: params.programs,
      boundary,
      account: params.snapshot.account,
      client: params.client,
      targets: params.targets,
      anchorMap,
      maxThreads: params.maxThreads,
      config: params.deps.gogConfig,
      aborted: params.aborted,
    });
    if (gRes.kind !== "ok") return gRes;
    gmailStatus = gRes.status;
    for (const item of gRes.items) items.push(item);
  }
  if (params.lanesRequested.includes("imsg")) {
    const exclusive =
      params.lanesRequested.length === 1 && params.lanesRequested[0] === "imsg";
    const iRes = await runImsgLane({
      programs: params.programs,
      boundary,
      targets: params.targets,
      anchorMap,
      maxChats: params.maxChats,
      maxMessages: params.maxMessages,
      exclusive,
      config: params.deps.imsgConfig,
    });
    if (iRes.kind !== "ok") return iRes;
    imsgStatus = iRes.status;
    for (const item of iRes.items) items.push(item);
  }
  const wantWeb = params.lanesRequested.includes("web-queue");
  const webResearchQueue = wantWeb ? buildWebResearchQueue(params.targets) : [];
  const webQueueStatus: EvidenceLaneStatus = wantWeb
    ? {
        status: "ready",
        detail: `Prepared ${String(webResearchQueue.length)} redacted web research query(ies).`,
      }
    : { status: "skipped", detail: "web-queue lane not requested." };
  return {
    kind: "ok",
    doc: {
      schemaVersion: "contacts-evidence/1",
      account: params.snapshot.account,
      lanesRequested: params.lanesRequested,
      lanesStatus: {
        gmail: gmailStatus,
        imsg: imsgStatus,
        webQueue: webQueueStatus,
      },
      items,
      webResearchQueue,
    },
  };
}
