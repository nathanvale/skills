import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { asObject, ownArray, ownString } from "./domain/rules.ts";
import type {
  ContactRecord,
  EvidenceItem,
  SerializedIdentityAnchor,
} from "./domain/rules.ts";
import {
  buildGogBaseArgs,
  OUTPUT_LIMIT_LARGE,
  OUTPUT_LIMIT_MEDIUM,
  runGogInspect,
} from "./gog.ts";
import type { GogRuntimeConfig } from "./gog.ts";

function extractThreadIds(json: unknown): readonly string[] {
  const ids: string[] = [];
  const ingest = (item: unknown): void => {
    if (typeof item === "string" && item.trim().length > 0) {
      ids.push(item.trim());
      return;
    }
    const obj = asObject(item);
    if (obj === null) return;
    const id = ownString(obj, "threadId") ?? ownString(obj, "id");
    if (id !== null && id.trim().length > 0) ids.push(id.trim());
  };
  const obj = asObject(json);
  const list = Array.isArray(json)
    ? json
    : obj === null
      ? []
      : (ownArray(obj, "threads") ??
        ownArray(obj, "ids") ??
        ownArray(obj, "messages") ??
        []);
  for (const item of list) ingest(item);
  return ids;
}

function extractThreadExcerpt(json: unknown): {
  readonly excerpt: string;
  readonly observedAt: string | null;
} {
  const obj = asObject(json);
  if (obj === null) return { excerpt: "", observedAt: null };
  const snippet = ownString(obj, "snippet") ?? ownString(obj, "subject");
  const date = ownString(obj, "date") ?? ownString(obj, "internalDate");
  if (snippet !== null && snippet.trim().length > 0) {
    return { excerpt: snippet.trim().slice(0, 400), observedAt: date };
  }
  for (const msg of ownArray(obj, "messages") ?? []) {
    const mObj = asObject(msg);
    if (mObj === null) continue;
    const text =
      ownString(mObj, "snippet") ??
      ownString(mObj, "body") ??
      ownString(mObj, "subject");
    if (text !== null && text.trim().length > 0) {
      return {
        excerpt: text.trim().slice(0, 400),
        observedAt: ownString(mObj, "date") ?? date,
      };
    }
  }
  return { excerpt: "Matched Gmail thread.", observedAt: date };
}

async function fetchSingleGmailThread(params: {
  readonly programs: ProgramsCapability;
  readonly executable: ParsedPath;
  readonly account: string;
  readonly client: string | undefined;
  readonly contactResourceName: string;
  readonly anchor: SerializedIdentityAnchor;
  readonly threadId: string;
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
}): Promise<
  | { readonly kind: "ok"; readonly item: EvidenceItem | null }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const threadRes = await runGogInspect(
    params.programs,
    params.executable,
    [
      "gmail",
      "thread",
      "get",
      params.threadId,
      "--readonly",
      "--gmail-no-send",
      "--wrap-untrusted",
      ...buildGogBaseArgs({
        enableCommand: "gmail.thread.get",
        account: params.account,
        client: params.client,
      }),
    ],
    OUTPUT_LIMIT_MEDIUM,
    params.config,
    params.aborted,
  );
  if (threadRes.kind === "empty" || threadRes.kind === "not-found") {
    return { kind: "ok", item: null };
  }
  if (threadRes.kind === "transient" || threadRes.kind === "unconfirmed") {
    return { kind: "transient", detail: threadRes.detail };
  }
  if (threadRes.kind !== "ok") {
    return { kind: "unavailable", detail: threadRes.detail };
  }
  const { excerpt, observedAt } = extractThreadExcerpt(threadRes.json);
  return {
    kind: "ok",
    item: {
      id: `gmail:${params.contactResourceName}:${params.threadId}`,
      lane: "gmail",
      contactResourceName: params.contactResourceName,
      anchor: params.anchor,
      sourceRef: `gmail:thread/${params.threadId}`,
      observedAt,
      excerpt,
      query: null,
      suggestedFields: {},
    },
  };
}

async function searchGmailAnchor(params: {
  readonly programs: ProgramsCapability;
  readonly executable: ParsedPath;
  readonly account: string;
  readonly client: string | undefined;
  readonly contact: ContactRecord;
  readonly anchor: SerializedIdentityAnchor;
  readonly remaining: number;
  readonly seenThreads: Set<string>;
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
}): Promise<
  | { readonly kind: "ok"; readonly items: readonly EvidenceItem[] }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const query =
    params.anchor.kind === "email"
      ? `from:${params.anchor.value} OR to:${params.anchor.value}`
      : `"${params.anchor.value}"`;
  const searchRes = await runGogInspect(
    params.programs,
    params.executable,
    [
      "gmail",
      "search",
      query,
      "--ids-only",
      "--max",
      "500",
      "--readonly",
      "--gmail-no-send",
      "--wrap-untrusted",
      ...buildGogBaseArgs({
        enableCommand: "gmail.search",
        account: params.account,
        client: params.client,
      }),
    ],
    OUTPUT_LIMIT_LARGE,
    params.config,
    params.aborted,
  );
  if (searchRes.kind === "empty") return { kind: "ok", items: [] };
  if (searchRes.kind === "transient" || searchRes.kind === "unconfirmed") {
    return { kind: "transient", detail: searchRes.detail };
  }
  if (searchRes.kind !== "ok") {
    return { kind: "unavailable", detail: searchRes.detail };
  }
  const items: EvidenceItem[] = [];
  for (const threadId of extractThreadIds(searchRes.json)) {
    if (params.seenThreads.has(threadId) || items.length >= params.remaining) {
      continue;
    }
    params.seenThreads.add(threadId);
    const fetched = await fetchSingleGmailThread({
      programs: params.programs,
      executable: params.executable,
      account: params.account,
      client: params.client,
      contactResourceName: params.contact.resourceName,
      anchor: params.anchor,
      threadId,
      config: params.config,
      aborted: params.aborted,
    });
    if (fetched.kind !== "ok") return fetched;
    if (fetched.item !== null) items.push(fetched.item);
  }
  return { kind: "ok", items };
}

export async function collectGmailEvidenceForContact(params: {
  readonly programs: ProgramsCapability;
  readonly executable: ParsedPath;
  readonly account: string;
  readonly client?: string | undefined;
  readonly contact: ContactRecord;
  readonly anchors: readonly SerializedIdentityAnchor[];
  readonly maxThreads: number;
  readonly config: GogRuntimeConfig;
  readonly aborted: () => boolean;
}): Promise<
  | { readonly kind: "ok"; readonly items: readonly EvidenceItem[] }
  | { readonly kind: "transient"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
> {
  const searchable = params.anchors.filter(
    (anchor) => anchor.kind === "email" || anchor.kind === "e164-phone",
  );
  const items: EvidenceItem[] = [];
  const seenThreads = new Set<string>();
  for (const anchor of searchable) {
    const remaining = params.maxThreads - items.length;
    if (remaining <= 0) break;
    const res = await searchGmailAnchor({
      programs: params.programs,
      executable: params.executable,
      account: params.account,
      client: params.client,
      contact: params.contact,
      anchor,
      remaining,
      seenThreads,
      config: params.config,
      aborted: params.aborted,
    });
    if (res.kind !== "ok") return res;
    for (const item of res.items) items.push(item);
  }
  return { kind: "ok", items };
}
