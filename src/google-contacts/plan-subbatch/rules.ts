import { compareCodeUnit } from "../domain/rules.ts";
import type {
  ContactWireFields,
  PlannedContactUpdate,
  UpdateSubBatch,
} from "../plan-types/rules.ts";

export const MAX_STDIN_PAYLOAD_BYTES = 900_000;
export const DEFAULT_MAX_CONTACTS = 50;
export const HARD_MAX_CONTACTS = 100;

export function fieldMaskOf(fields: ContactWireFields): readonly string[] {
  const keys: string[] = [];
  for (const key of Object.keys(fields)) {
    const val: unknown = Reflect.get(fields, key);
    if (val !== undefined) keys.push(key);
  }
  return keys.sort(compareCodeUnit);
}

function buildWireUpdateEntry(
  update: PlannedContactUpdate,
): Readonly<Record<string, unknown>> {
  const entry: Record<string, unknown> = {
    resourceName: update.resourceName,
    etag: update.expectedRevision,
    metadata: { sources: [update.contactSource] },
  };
  for (const key of fieldMaskOf(update.fields)) {
    entry[key] = Reflect.get(update.fields, key);
  }
  return entry;
}

export function serializeSubBatchWireMap(
  updates: readonly PlannedContactUpdate[],
): { readonly json: string; readonly bytes: number } {
  const map: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const update of updates) {
    map[update.resourceName] = buildWireUpdateEntry(update);
  }
  const json = JSON.stringify(map);
  return { json, bytes: new TextEncoder().encode(json).byteLength };
}

function chunkGroupByBytes(
  mask: readonly string[],
  items: readonly PlannedContactUpdate[],
  startIndex: number,
):
  | { readonly ok: true; readonly batches: readonly UpdateSubBatch[] }
  | { readonly ok: false; readonly reason: string } {
  const batches: UpdateSubBatch[] = [];
  let current: PlannedContactUpdate[] = [];
  for (const item of items) {
    const single = serializeSubBatchWireMap([item]);
    if (single.bytes >= MAX_STDIN_PAYLOAD_BYTES) {
      return {
        ok: false,
        reason: `Single update payload for ${item.resourceName} exceeds ${String(MAX_STDIN_PAYLOAD_BYTES)} bytes.`,
      };
    }
    const candidate = [...current, item];
    const serialized = serializeSubBatchWireMap(candidate);
    if (serialized.bytes >= MAX_STDIN_PAYLOAD_BYTES && current.length > 0) {
      const flushed = serializeSubBatchWireMap(current);
      batches.push({
        index: startIndex + batches.length,
        fieldMask: mask,
        payloadBytes: flushed.bytes,
        updates: current,
      });
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    const flushed = serializeSubBatchWireMap(current);
    batches.push({
      index: startIndex + batches.length,
      fieldMask: mask,
      payloadBytes: flushed.bytes,
      updates: current,
    });
  }
  return { ok: true, batches };
}

export function partitionSubBatches(
  updates: readonly PlannedContactUpdate[],
):
  | { readonly ok: true; readonly batches: readonly UpdateSubBatch[] }
  | { readonly ok: false; readonly reason: string } {
  const groups = new Map<
    string,
    { readonly mask: readonly string[]; readonly items: PlannedContactUpdate[] }
  >();
  for (const update of updates) {
    const mask = fieldMaskOf(update.fields);
    if (mask.length === 0) {
      return {
        ok: false,
        reason: `Update for ${update.resourceName} has an empty field mask.`,
      };
    }
    const key = mask.join(",");
    const group = groups.get(key) ?? { mask, items: [] };
    group.items.push(update);
    groups.set(key, group);
  }
  const sortedKeys = [...groups.keys()].sort(compareCodeUnit);
  const batches: UpdateSubBatch[] = [];
  for (const key of sortedKeys) {
    const group = groups.get(key);
    if (group === undefined) continue;
    const chunked = chunkGroupByBytes(group.mask, group.items, batches.length);
    if (!chunked.ok) return chunked;
    for (const batch of chunked.batches) batches.push(batch);
  }
  return { ok: true, batches };
}
