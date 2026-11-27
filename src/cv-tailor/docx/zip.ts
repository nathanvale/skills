import { crc32, inflateRawSync } from "node:zlib";

export type ZipEntry = {
  readonly name: string;
  readonly data: Uint8Array;
  readonly externalAttributes: number;
};

export type ReadZipResult =
  | { readonly ok: true; readonly entries: readonly ZipEntry[] }
  | { readonly ok: false; readonly error: string };

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;
const VERSION_MADE_BY_UNIX = 0x0314;
const VERSION_NEEDED_STORE = 20;
const DEFAULT_FILE_ATTRIBUTES = 0o100644 << 16;

function findEocdOffset(bytes: Uint8Array, view: DataView): number {
  const minOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIG) {
      return offset;
    }
  }
  return -1;
}

function readEntryData(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  compressionMethod: number,
  compressedSize: number,
  name: string,
):
  | { readonly ok: true; readonly data: Uint8Array }
  | { readonly ok: false; readonly error: string } {
  if (localOffset + 30 > bytes.length) {
    return { ok: false, error: `truncated local header for ${name}` };
  }
  if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIG) {
    return { ok: false, error: `invalid local header signature for ${name}` };
  }
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > bytes.length) {
    return { ok: false, error: `truncated entry data for ${name}` };
  }
  const rawSlice = bytes.subarray(dataStart, dataEnd);
  if (compressionMethod === 0) {
    return { ok: true, data: new Uint8Array(rawSlice) };
  }
  if (compressionMethod === 8) {
    try {
      const inflated = inflateRawSync(rawSlice);
      return { ok: true, data: new Uint8Array(inflated) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `failed to inflate ${name}: ${detail}` };
    }
  }
  return {
    ok: false,
    error: `unsupported zip compression method ${String(compressionMethod)} for ${name}`,
  };
}

export function readZip(bytes: Uint8Array): ReadZipResult {
  if (bytes.length < 22) {
    return { ok: false, error: "file is too small to be a zip archive" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocdOffset(bytes, view);
  if (eocdOffset < 0) {
    return {
      ok: false,
      error: "zip end-of-central-directory record not found",
    };
  }
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length) {
      return { ok: false, error: "truncated zip central directory header" };
    }
    if (view.getUint32(cursor, true) !== CENTRAL_DIR_HEADER_SIG) {
      return { ok: false, error: "invalid zip central directory signature" };
    }
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > bytes.length) {
      return { ok: false, error: "truncated zip entry filename" };
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, nameEnd));
    const entryData = readEntryData(
      bytes,
      view,
      localOffset,
      compressionMethod,
      compressedSize,
      name,
    );
    if (!entryData.ok) return entryData;
    entries.push({
      name,
      data: entryData.data,
      externalAttributes,
    });
    cursor = nameEnd + extraLength + commentLength;
  }

  return { ok: true, entries };
}

export function writeStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(entry.data) >>> 0;
    const externalAttributes =
      entry.externalAttributes !== 0
        ? entry.externalAttributes
        : DEFAULT_FILE_ATTRIBUTES;
    return {
      nameBytes,
      data: entry.data,
      checksum,
      externalAttributes,
    };
  });

  let localTotal = 0;
  let cdTotal = 0;
  for (const item of prepared) {
    localTotal += 30 + item.nameBytes.length + item.data.length;
    cdTotal += 46 + item.nameBytes.length;
  }

  const output = new Uint8Array(localTotal + cdTotal + 22);
  const view = new DataView(output.buffer);
  const localOffsets: number[] = [];
  let offset = 0;

  for (const item of prepared) {
    localOffsets.push(offset);
    view.setUint32(offset, LOCAL_FILE_HEADER_SIG, true);
    view.setUint16(offset + 4, VERSION_NEEDED_STORE, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, FIXED_DOS_TIME, true);
    view.setUint16(offset + 12, FIXED_DOS_DATE, true);
    view.setUint32(offset + 14, item.checksum, true);
    view.setUint32(offset + 18, item.data.length, true);
    view.setUint32(offset + 22, item.data.length, true);
    view.setUint16(offset + 26, item.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    output.set(item.nameBytes, offset + 30);
    offset += 30 + item.nameBytes.length;
    output.set(item.data, offset);
    offset += item.data.length;
  }

  const cdStart = offset;
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index];
    const localOffset = localOffsets[index];
    if (item === undefined || localOffset === undefined) continue;
    view.setUint32(offset, CENTRAL_DIR_HEADER_SIG, true);
    view.setUint16(offset + 4, VERSION_MADE_BY_UNIX, true);
    view.setUint16(offset + 6, VERSION_NEEDED_STORE, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, FIXED_DOS_TIME, true);
    view.setUint16(offset + 14, FIXED_DOS_DATE, true);
    view.setUint32(offset + 16, item.checksum, true);
    view.setUint32(offset + 20, item.data.length, true);
    view.setUint32(offset + 24, item.data.length, true);
    view.setUint16(offset + 28, item.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, item.externalAttributes, true);
    view.setUint32(offset + 42, localOffset, true);
    output.set(item.nameBytes, offset + 46);
    offset += 46 + item.nameBytes.length;
  }

  view.setUint32(offset, EOCD_SIG, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, cdTotal, true);
  view.setUint32(offset + 16, cdStart, true);
  view.setUint16(offset + 20, 0, true);

  return output;
}
