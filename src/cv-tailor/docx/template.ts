import type { CvBlock, InlineRun, ParsedCvDocument } from "../cv/rules.ts";
import { readZip, writeStoredZip } from "./zip.ts";
import type { ZipEntry } from "./zip.ts";

const REQUIRED_DOCX_STYLES = [
  "Title",
  "Subtitle",
  "ContactDetails",
  "Heading 1",
  "Heading 2",
  "RoleDetails",
  "List Bullet",
] as const;

type RequiredStyleName = (typeof REQUIRED_DOCX_STYLES)[number];

const WORD_BUILTIN_UI_NAMES: ReadonlyMap<string, string> = new Map([
  ["heading 1", "Heading 1"],
  ["heading 2", "Heading 2"],
  ["heading 3", "Heading 3"],
  ["heading 4", "Heading 4"],
  ["heading 5", "Heading 5"],
  ["heading 6", "Heading 6"],
  ["heading 7", "Heading 7"],
  ["heading 8", "Heading 8"],
  ["heading 9", "Heading 9"],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["list bullet", "List Bullet"],
  ["normal", "Normal"],
]);

function mapWordStyleNameToUi(
  styleName: string | undefined,
): string | undefined {
  if (styleName === undefined) return undefined;
  return WORD_BUILTIN_UI_NAMES.get(styleName) ?? styleName;
}

export type BuildDocxResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: string };

export type ExtractDocxTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

const HYPERLINK_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function recordStyleMatches(
  styleId: string,
  styleName: string | undefined,
  found: Map<RequiredStyleName, string>,
): void {
  const uiName = mapWordStyleNameToUi(styleName);
  for (const req of REQUIRED_DOCX_STYLES) {
    if (found.has(req)) continue;
    if (req === uiName || req === styleId) {
      found.set(req, styleId);
    }
  }
}

function resolveStyleIds(
  stylesXml: string,
):
  | { readonly ok: true; readonly map: ReadonlyMap<RequiredStyleName, string> }
  | { readonly ok: false; readonly error: string } {
  const found = new Map<RequiredStyleName, string>();
  const styleBlockPattern = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;

  for (const match of stylesXml.matchAll(styleBlockPattern)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const styleId = /\bw:styleId="([^"]+)"/.exec(attrs)?.[1];
    if (styleId === undefined) continue;
    const styleName = /<w:name\b[^>]*\bw:val="([^"]+)"/.exec(inner)?.[1];
    recordStyleMatches(styleId, styleName, found);
  }

  const missing = REQUIRED_DOCX_STYLES.filter((name) => !found.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `template lacks styles: ${missing.join(", ")}`,
    };
  }
  return { ok: true, map: found };
}

function resetTitleSpacing(stylesXml: string, titleStyleId: string): string {
  const escapedId = titleStyleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleBlockPattern = new RegExp(
    `(<w:style\\b[^>]*\\bw:styleId="${escapedId}"[^>]*>)([\\s\\S]*?)(</w:style>)`,
  );
  return stylesXml.replace(
    titleBlockPattern,
    (_full, open: string, inner: string, close: string) => {
      const cleaned = inner.replace(
        /(<w:rPr\b[^>]*>)([\s\S]*?)(<\/w:rPr>)/,
        (_rprFull, rprOpen: string, rprInner: string, rprClose: string) => {
          const withoutSpacing = rprInner
            .replace(/<w:spacing\b[^>]*\/>/g, "")
            .replace(/<w:spacing\b[^>]*>[\s\S]*?<\/w:spacing>/g, "");
          return `${rprOpen}${withoutSpacing}${rprClose}`;
        },
      );
      return `${open}${cleaned}${close}`;
    },
  );
}

function highestRelNumber(relsXml: string): number {
  let highest = 0;
  for (const match of relsXml.matchAll(/\bId="rId(\d+)"/g)) {
    const parsed = Number.parseInt(match[1] ?? "0", 10);
    if (Number.isSafeInteger(parsed) && parsed > highest) {
      highest = parsed;
    }
  }
  return highest;
}

type RelAllocator = {
  nextId: number;
  readonly added: { readonly id: string; readonly url: string }[];
};

function renderRun(
  run: InlineRun,
  italic: boolean,
  rels: RelAllocator,
): string {
  if (run.kind === "link") {
    rels.nextId += 1;
    const id = `rId${String(rels.nextId)}`;
    rels.added.push({ id, url: run.url });
    return `<w:hyperlink r:id="${id}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r></w:hyperlink>`;
  }
  if (run.kind === "bold") {
    return `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
  }
  const rpr = italic ? "<w:rPr><w:i/></w:rPr>" : "";
  return `<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

function renderBlock(
  block: CvBlock,
  styleMap: ReadonlyMap<RequiredStyleName, string>,
  rels: RelAllocator,
): string {
  const italic = block.kind === "RoleDetails";
  const runsXml = block.runs
    .map((run) => renderRun(run, italic, rels))
    .join("");
  if (block.kind === "Normal") {
    return `<w:p>${runsXml}</w:p>`;
  }
  const styleId = styleMap.get(block.kind);
  const ppr =
    styleId !== undefined
      ? `<w:pPr><w:pStyle w:val="${escapeXml(styleId)}"/></w:pPr>`
      : "";
  return `<w:p>${ppr}${runsXml}</w:p>`;
}

function replaceDocumentBody(
  documentXml: string,
  renderedParagraphs: string,
):
  | { readonly ok: true; readonly xml: string }
  | { readonly ok: false; readonly error: string } {
  const openMatch = /<w:body\b[^>]*>/.exec(documentXml);
  if (openMatch === null) {
    return { ok: false, error: "word/document.xml lacks <w:body>" };
  }
  const bodyStart = openMatch.index + openMatch[0].length;
  const bodyCloseIndex = documentXml.lastIndexOf("</w:body>");
  if (bodyCloseIndex < bodyStart) {
    return { ok: false, error: "word/document.xml lacks </w:body>" };
  }
  const bodyInner = documentXml.slice(bodyStart, bodyCloseIndex);
  const sectIndex = bodyInner.lastIndexOf("<w:sectPr");
  const trailing = sectIndex >= 0 ? bodyInner.slice(sectIndex) : "";
  const updated = `${documentXml.slice(0, bodyStart)}${renderedParagraphs}${trailing}${documentXml.slice(bodyCloseIndex)}`;
  return { ok: true, xml: updated };
}

function appendRelationships(
  relsXml: string,
  added: readonly { readonly id: string; readonly url: string }[],
):
  | { readonly ok: true; readonly xml: string }
  | { readonly ok: false; readonly error: string } {
  if (added.length === 0) return { ok: true, xml: relsXml };
  const closeIndex = relsXml.lastIndexOf("</Relationships>");
  if (closeIndex < 0) {
    return {
      ok: false,
      error: "word/_rels/document.xml.rels lacks </Relationships>",
    };
  }
  const nodes = added
    .map(
      (rel) =>
        `<Relationship Id="${rel.id}" Type="${HYPERLINK_REL_TYPE}" Target="${escapeXml(rel.url)}" TargetMode="External"/>`,
    )
    .join("");
  return {
    ok: true,
    xml: `${relsXml.slice(0, closeIndex)}${nodes}${relsXml.slice(closeIndex)}`,
  };
}

export function buildDocxFromTemplate(
  templateBytes: Uint8Array,
  document: ParsedCvDocument,
): BuildDocxResult {
  const archive = readZip(templateBytes);
  if (!archive.ok) return { ok: false, error: archive.error };

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stylesEntry = archive.entries.find(
    (entry) => entry.name === "word/styles.xml",
  );
  const docEntry = archive.entries.find(
    (entry) => entry.name === "word/document.xml",
  );
  const relsEntry = archive.entries.find(
    (entry) => entry.name === "word/_rels/document.xml.rels",
  );

  if (stylesEntry === undefined) {
    return { ok: false, error: "template lacks word/styles.xml" };
  }
  if (docEntry === undefined) {
    return { ok: false, error: "template lacks word/document.xml" };
  }

  const stylesXml = decoder.decode(stylesEntry.data);
  const resolvedStyles = resolveStyleIds(stylesXml);
  if (!resolvedStyles.ok) return resolvedStyles;

  const titleStyleId = resolvedStyles.map.get("Title") ?? "Title";
  const updatedStylesXml = resetTitleSpacing(stylesXml, titleStyleId);

  const initialRelsXml =
    relsEntry !== undefined
      ? decoder.decode(relsEntry.data)
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const relsAllocator: RelAllocator = {
    nextId: highestRelNumber(initialRelsXml),
    added: [],
  };

  const renderedParagraphs = document.blocks
    .map((block) => renderBlock(block, resolvedStyles.map, relsAllocator))
    .join("");

  const updatedDoc = replaceDocumentBody(
    decoder.decode(docEntry.data),
    renderedParagraphs,
  );
  if (!updatedDoc.ok) return updatedDoc;

  const updatedRels = appendRelationships(initialRelsXml, relsAllocator.added);
  if (!updatedRels.ok) return updatedRels;

  const nextEntries: ZipEntry[] = archive.entries.map((entry) => {
    if (entry.name === "word/styles.xml") {
      return { ...entry, data: encoder.encode(updatedStylesXml) };
    }
    if (entry.name === "word/document.xml") {
      return { ...entry, data: encoder.encode(updatedDoc.xml) };
    }
    if (entry.name === "word/_rels/document.xml.rels") {
      return { ...entry, data: encoder.encode(updatedRels.xml) };
    }
    return entry;
  });

  if (relsEntry === undefined && relsAllocator.added.length > 0) {
    nextEntries.push({
      name: "word/_rels/document.xml.rels",
      data: encoder.encode(updatedRels.xml),
      externalAttributes: 0,
    });
  }

  return { ok: true, bytes: writeStoredZip(nextEntries) };
}

function extractDocumentBodyXml(
  xml: string,
):
  | { readonly ok: true; readonly bodyXml: string }
  | { readonly ok: false; readonly error: string } {
  const trimmed = xml
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)+/, "")
    .replace(/(?:\s|<!--[\s\S]*?-->)+$/, "");
  const rootOpen = /^<w:document(?:\s[^>]*)?>/.exec(trimmed);
  if (rootOpen === null || !trimmed.endsWith("</w:document>")) {
    return {
      ok: false,
      error: "word/document.xml must have a <w:document> root element",
    };
  }
  const docInner = trimmed.slice(
    rootOpen[0].length,
    trimmed.length - "</w:document>".length,
  );
  if (docInner.includes("</w:document>")) {
    return {
      ok: false,
      error: "word/document.xml must have a single <w:document> root element",
    };
  }
  const selfClosingBody = /<w:body(?:\s[^>]*)?\/>/.exec(docInner);
  if (selfClosingBody !== null) {
    return { ok: true, bodyXml: "" };
  }
  const bodyOpen = /<w:body(?:\s[^>]*)?>/.exec(docInner);
  if (bodyOpen === null) {
    return {
      ok: false,
      error: "word/document.xml <w:document> lacks a <w:body> child",
    };
  }
  const bodyStart = bodyOpen.index + bodyOpen[0].length;
  const bodyClose = docInner.lastIndexOf("</w:body>");
  if (bodyClose < bodyStart) {
    return {
      ok: false,
      error: "word/document.xml lacks a closing </w:body> tag",
    };
  }
  return { ok: true, bodyXml: docInner.slice(bodyStart, bodyClose) };
}

export function extractDocxText(docxBytes: Uint8Array): ExtractDocxTextResult {
  const archive = readZip(docxBytes);
  if (!archive.ok) return { ok: false, error: archive.error };
  const docEntry = archive.entries.find(
    (entry) => entry.name === "word/document.xml",
  );
  if (docEntry === undefined) {
    return { ok: false, error: "docx archive lacks word/document.xml" };
  }
  const xml = new TextDecoder().decode(docEntry.data);
  const body = extractDocumentBodyXml(xml);
  if (!body.ok) return body;
  const paragraphs: string[] = [];
  const paragraphPattern =
    /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  const tokenPattern =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/?>|<w:(?:br|cr)(?:\s[^>]*)?\/?>/g;

  for (const pMatch of body.bodyXml.matchAll(paragraphPattern)) {
    const inner = pMatch[1];
    if (inner === undefined) {
      paragraphs.push("");
      continue;
    }
    const parts: string[] = [];
    for (const token of inner.matchAll(tokenPattern)) {
      if (token[1] !== undefined) {
        parts.push(unescapeXml(token[1]));
      } else if (token[0].startsWith("<w:tab")) {
        parts.push("\t");
      } else {
        parts.push("\n");
      }
    }
    paragraphs.push(parts.join(""));
  }

  return { ok: true, text: `${paragraphs.join("\n")}\n` };
}
