import { escapeRegex, normalise, termPattern } from "../search/rules.ts";

export type InlineRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly url: string };

export type CvBlockKind =
  | "Title"
  | "Subtitle"
  | "ContactDetails"
  | "Heading 1"
  | "Heading 2"
  | "RoleDetails"
  | "List Bullet"
  | "Normal";

export type CvBlock = {
  readonly kind: CvBlockKind;
  readonly rawText: string;
  readonly plainText: string;
  readonly runs: readonly InlineRun[];
};

export type CvRole = {
  readonly title: string;
  readonly dates: string | null;
};

export type CvLink = {
  readonly text: string;
  readonly url: string;
};

export type ParsedCvDocument = {
  readonly source: string;
  readonly name: string;
  readonly top: readonly string[];
  readonly sections: readonly string[];
  readonly roles: readonly CvRole[];
  readonly paragraphs: readonly string[];
  readonly links: readonly CvLink[];
  readonly blocks: readonly CvBlock[];
};

export type CvMarkdownParseResult =
  | { readonly ok: true; readonly document: ParsedCvDocument }
  | { readonly ok: false; readonly error: string };

export type NameSpacingVerdict = "spaced" | "joined" | "missing";

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RANGE_PATTERN = new RegExp(
  `^(${MONTHS}) \\d{4} to ((${MONTHS}) \\d{4}|present)$`,
);
const ROLE_DETAILS_PATTERN = /(present|\d{4}) \|/i;
const INLINE_PATTERN = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_PATTERN = /\+?\d[\d ()-]{7,}\d/g;

function stripFrontMatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function parseInlineRuns(text: string): readonly InlineRun[] {
  const runs: InlineRun[] = [];
  let pos = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index;
    if (start > pos) {
      runs.push({ kind: "text", text: text.slice(pos, start) });
    }
    const linkText = match[1];
    const linkUrl = match[2];
    const boldText = match[3];
    if (linkText !== undefined && linkUrl !== undefined) {
      runs.push({ kind: "link", text: linkText, url: linkUrl });
    } else if (boldText !== undefined) {
      runs.push({ kind: "bold", text: boldText });
    }
    pos = start + match[0].length;
  }
  if (pos < text.length) {
    runs.push({ kind: "text", text: text.slice(pos) });
  }
  return runs;
}

function plainTextFromRuns(runs: readonly InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

type ParseCursor = {
  inTop: boolean;
  topLines: number;
  afterRole: boolean;
  name: string;
  readonly top: string[];
  readonly sections: string[];
  readonly roles: { readonly title: string; dates: string | null }[];
  readonly paragraphs: string[];
  readonly links: CvLink[];
  readonly blocks: CvBlock[];
};

function pushBlock(
  cursor: ParseCursor,
  kind: CvBlockKind,
  rawText: string,
  plainText: string,
  runs: readonly InlineRun[],
): void {
  cursor.blocks.push({ kind, rawText, plainText, runs });
}

function classifyHeading(line: string, cursor: ParseCursor): string | null {
  if (line.startsWith("# ")) {
    const text = line.slice(2);
    const runs = parseInlineRuns(text);
    const plain = plainTextFromRuns(runs);
    if (cursor.name.length === 0) cursor.name = text;
    cursor.paragraphs.push(plain);
    pushBlock(cursor, "Title", text, plain, [{ kind: "text", text }]);
    return null;
  }
  if (line.startsWith("## ")) {
    const text = line.slice(3);
    const runs = parseInlineRuns(text);
    const plain = plainTextFromRuns(runs);
    cursor.inTop = false;
    cursor.afterRole = false;
    cursor.sections.push(plain);
    cursor.paragraphs.push(plain);
    pushBlock(cursor, "Heading 1", text, plain, [{ kind: "text", text }]);
    return null;
  }
  if (line.startsWith("### ")) {
    const text = line.slice(4);
    const runs = parseInlineRuns(text);
    const plain = plainTextFromRuns(runs);
    cursor.roles.push({ title: plain, dates: null });
    cursor.afterRole = true;
    cursor.paragraphs.push(plain);
    pushBlock(cursor, "Heading 2", text, plain, [{ kind: "text", text }]);
    return null;
  }
  return `unsupported heading level: ${JSON.stringify(line.slice(0, 40))}`;
}

function classifyBodyLine(line: string, cursor: ParseCursor): void {
  if (line.startsWith("- ")) {
    const raw = line.slice(2);
    const runs = parseInlineRuns(raw);
    const plain = plainTextFromRuns(runs);
    cursor.afterRole = false;
    cursor.paragraphs.push(plain);
    pushBlock(cursor, "List Bullet", raw, plain, runs);
    return;
  }
  const runs = parseInlineRuns(line);
  const plain = plainTextFromRuns(runs);
  cursor.paragraphs.push(plain);
  if (cursor.inTop) {
    cursor.topLines += 1;
    cursor.top.push(plain);
    const kind = cursor.topLines === 1 ? "Subtitle" : "ContactDetails";
    pushBlock(cursor, kind, line, plain, runs);
    return;
  }
  const currentRole = cursor.roles[cursor.roles.length - 1];
  if (
    cursor.afterRole &&
    currentRole !== undefined &&
    ROLE_DETAILS_PATTERN.test(plain)
  ) {
    currentRole.dates = plain;
    cursor.afterRole = false;
    pushBlock(cursor, "RoleDetails", line, plain, runs);
    return;
  }
  cursor.afterRole = false;
  pushBlock(cursor, "Normal", line, plain, runs);
}

export function parseCvMarkdown(rawSource: string): CvMarkdownParseResult {
  const source = stripFrontMatter(rawSource);
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const cursor: ParseCursor = {
    inTop: true,
    topLines: 0,
    afterRole: false,
    name: "",
    top: [],
    sections: [],
    roles: [],
    paragraphs: [],
    links: [],
    blocks: [],
  };

  for (const line of lines) {
    for (const run of parseInlineRuns(line)) {
      if (run.kind === "link") {
        cursor.links.push({ text: run.text, url: run.url });
      }
    }
    if (line.startsWith("#")) {
      const err = classifyHeading(line, cursor);
      if (err !== null) return { ok: false, error: err };
      continue;
    }
    classifyBodyLine(line, cursor);
  }

  return {
    ok: true,
    document: {
      source,
      name: cursor.name,
      top: cursor.top,
      sections: cursor.sections,
      roles: cursor.roles,
      paragraphs: cursor.paragraphs,
      links: cursor.links,
      blocks: cursor.blocks,
    },
  };
}

export function scanDashes(source: string): readonly string[] {
  const found: string[] = [];
  if (source.includes("\u2014")) found.push("U+2014");
  if (source.includes("\u2013")) found.push("U+2013");
  return found;
}

export function isValidDateRange(datePart: string): boolean {
  return DATE_RANGE_PATTERN.test(datePart.trim());
}

export function checkNameSpacing(
  name: string,
  rawText: string,
  normalisedText: string,
): NameSpacingVerdict {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "missing";
  const compact = trimmed.replace(/\s+/g, "");
  if (compact !== trimmed) {
    const joinedPattern = new RegExp(`^\\s*${escapeRegex(compact)}\\b`, "im");
    if (joinedPattern.test(rawText.normalize("NFKC"))) {
      return "joined";
    }
  }
  return termPattern(trimmed).test(normalisedText) ? "spaced" : "missing";
}

export function extractEmails(topText: string): readonly string[] {
  return topText.match(EMAIL_PATTERN) ?? [];
}

export function extractPhones(topText: string): readonly string[] {
  const matches = topText.match(PHONE_PATTERN) ?? [];
  return matches.filter((phone) => phone.replace(/\D/g, "").length >= 8);
}

export function phonePattern(phone: string): RegExp {
  const digits = phone.replace(/\D/g, "");
  return new RegExp(digits.split("").join("[\\s().-]*"));
}

export function findHiddenLinks(links: readonly CvLink[]): readonly CvLink[] {
  return links.filter((link) => {
    const bare = link.url.replace("https://", "").replace("mailto:", "");
    return !link.text.includes(bare);
  });
}

export function inOrder(
  normalisedText: string,
  items: readonly string[],
): { readonly found: number; readonly stray: string | null } {
  const lowerText = normalisedText.toLowerCase();
  let pos = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const needle = normalise(item).toLowerCase();
    const hit = lowerText.indexOf(needle, pos);
    if (hit < 0) {
      return { found: index, stray: item };
    }
    pos = hit + 1;
  }
  return { found: items.length, stray: null };
}
