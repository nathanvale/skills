import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProgramsCapability } from "agent-cli-kernel";
import { extractDocxText } from "../docx/template.ts";
import { readPdfPageCount, runPdfToText } from "../programs.ts";
import { hasTerm, normalise } from "../search/rules.ts";
import type { PathBoundary } from "../settings.ts";
import {
  checkNameSpacing,
  extractEmails,
  extractPhones,
  findHiddenLinks,
  inOrder,
  isValidDateRange,
  parseCvMarkdown,
  phonePattern,
  scanDashes,
} from "./rules.ts";
import type { ParsedCvDocument } from "./rules.ts";

type CheckStatus = "PASS" | "FAIL" | "WARN";

type CheckItem = {
  readonly scope: string;
  readonly status: CheckStatus;
  readonly check: string;
  readonly detail: string | null;
};

export type CheckReportData = {
  readonly verdict: "PASS" | "FAIL";
  readonly pdf: string;
  readonly docx: string;
  readonly source: string;
  readonly pages: number;
  readonly maxPages: number;
  readonly failures: number;
  readonly warnings: number;
  readonly checks: readonly CheckItem[];
};

export type CheckEvalResult =
  | { readonly ok: true; readonly report: CheckReportData }
  | {
      readonly ok: false;
      readonly causeCode:
        | "DOMAIN_CV_TAILOR_SOURCE_INVALID"
        | "DOMAIN_CV_TAILOR_FILE_UNREADABLE"
        | "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING"
        | "DOMAIN_CV_TAILOR_PROGRAM_FAILED";
      readonly message: string;
      readonly missing?: readonly string[];
    };

function pushCheck(
  items: CheckItem[],
  scope: string,
  ok: boolean,
  check: string,
  failDetail: string,
): void {
  items.push({
    scope,
    status: ok ? "PASS" : "FAIL",
    check,
    detail: ok ? null : failDetail,
  });
}

function checkSourceRules(items: CheckItem[], md: ParsedCvDocument): void {
  const dashes = scanDashes(md.source);
  pushCheck(
    items,
    "source",
    dashes.length === 0,
    "no em or en dashes in the source",
    `found ${dashes.join(" ")}`,
  );
  for (const role of md.roles) {
    if (role.dates === null) {
      items.push({
        scope: "source",
        status: "WARN",
        check: `role '${role.title}' date line`,
        detail: `role '${role.title}' has no date line ('<dates> | <place>')`,
      });
    } else if (!isValidDateRange(role.dates.split("|")[0] ?? "")) {
      items.push({
        scope: "source",
        status: "WARN",
        check: `role '${role.title}' date line`,
        detail: `date line '${role.dates}' is not 'Month YYYY to Month YYYY|present'`,
      });
    }
  }
  for (const link of findHiddenLinks(md.links)) {
    items.push({
      scope: "source",
      status: "WARN",
      check: `link '${link.text}'`,
      detail: `link '${link.text}' hides ${link.url}; parsers see only the text`,
    });
  }
}

function checkExtractedText(
  items: CheckItem[],
  scope: string,
  rawText: string,
  md: ParsedCvDocument,
): void {
  const flat = normalise(rawText);
  const nameVerdict = checkNameSpacing(md.name, rawText, flat);
  if (nameVerdict === "joined") {
    pushCheck(
      items,
      scope,
      false,
      "name",
      "a line reads it as one word (title letter spacing); rebuild with cv build",
    );
  } else if (nameVerdict === "spaced") {
    pushCheck(items, scope, true, `name parses as '${md.name}'`, "");
  } else {
    pushCheck(items, scope, false, "name", `'${md.name}' not found`);
  }

  const top = md.top.join(" ");
  for (const email of extractEmails(top)) {
    pushCheck(
      items,
      scope,
      flat.toLowerCase().includes(email.toLowerCase()),
      `email ${email}`,
      "missing",
    );
  }
  for (const phone of extractPhones(top)) {
    pushCheck(
      items,
      scope,
      phonePattern(phone).test(flat),
      `phone ${phone}`,
      "missing",
    );
  }

  const sectionsOrder = inOrder(flat, md.sections);
  pushCheck(
    items,
    scope,
    sectionsOrder.stray === null,
    `section headings ${String(sectionsOrder.found)} of ${String(md.sections.length)} in order`,
    `stops at '${sectionsOrder.stray ?? ""}'`,
  );

  const roleItems: string[] = [];
  for (const role of md.roles) {
    roleItems.push(role.title);
    if (role.dates !== null) roleItems.push(role.dates);
  }
  const rolesOrder = inOrder(flat, roleItems);
  pushCheck(
    items,
    scope,
    rolesOrder.stray === null,
    `role headings and date lines ${String(rolesOrder.found)} of ${String(roleItems.length)} in order`,
    `stops at '${rolesOrder.stray ?? ""}'`,
  );
}

function checkParagraphsAndTerms(
  items: CheckItem[],
  md: ParsedCvDocument,
  pdfLayoutText: string,
  wordText: string,
  terms: readonly string[],
): void {
  const wordLower = normalise(wordText).toLowerCase();
  const missingParagraphs = md.paragraphs.filter(
    (paragraph) => !wordLower.includes(normalise(paragraph).toLowerCase()),
  );
  pushCheck(
    items,
    "word",
    missingParagraphs.length === 0,
    `Markdown paragraphs in Word ${String(md.paragraphs.length - missingParagraphs.length)} of ${String(md.paragraphs.length)}`,
    missingParagraphs
      .slice(0, 5)
      .map((item) => item.slice(0, 50))
      .join("; "),
  );

  if (terms.length === 0) return;
  const targets = [
    { label: "pdf", text: pdfLayoutText },
    { label: "word", text: wordText },
  ] as const;
  for (const target of targets) {
    const flat = normalise(target.text);
    const absent = terms.filter((term) => !hasTerm(flat, term));
    pushCheck(
      items,
      "terms",
      absent.length === 0,
      `${target.label}: ${String(terms.length - absent.length)} of ${String(terms.length)} terms`,
      absent.join(", "),
    );
  }
}

function loadSourceAndDocx(
  cwd: string,
  sourceDisplay: string,
  docxDisplay: string,
):
  | {
      readonly ok: true;
      readonly md: ParsedCvDocument;
      readonly wordText: string;
    }
  | Extract<CheckEvalResult, { readonly ok: false }> {
  let sourceText: string;
  try {
    sourceText = readFileSync(resolve(cwd, sourceDisplay), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
      message: `Cannot read source ${sourceDisplay}: ${detail}`,
    };
  }
  const parsedMd = parseCvMarkdown(sourceText);
  if (!parsedMd.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
      message: `Invalid Markdown source ${sourceDisplay}: ${parsedMd.error}`,
    };
  }
  let docxBytes: Uint8Array;
  try {
    docxBytes = readFileSync(resolve(cwd, docxDisplay));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
      message: `Cannot read docx ${docxDisplay}: ${detail}`,
    };
  }
  const extracted = extractDocxText(docxBytes);
  if (!extracted.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_FILE_UNREADABLE",
      message: `Cannot extract text from ${docxDisplay}: ${extracted.error}`,
    };
  }
  return { ok: true, md: parsedMd.document, wordText: extracted.text };
}

export async function evaluateCvCheck(options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly boundary: PathBoundary;
  readonly programs: ProgramsCapability;
  readonly pdf: string;
  readonly docx: string;
  readonly source: string;
  readonly maxPages: number;
  readonly terms: readonly string[];
}): Promise<CheckEvalResult> {
  const loaded = loadSourceAndDocx(options.cwd, options.source, options.docx);
  if (!loaded.ok) return loaded;

  const pdfPath = resolve(options.cwd, options.pdf);
  const pageCountRes = await readPdfPageCount({
    programs: options.programs,
    env: options.env,
    boundary: options.boundary,
    pdfPath,
  });
  if (!pageCountRes.ok) {
    return {
      ok: false,
      causeCode: pageCountRes.missing
        ? "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING"
        : "DOMAIN_CV_TAILOR_PROGRAM_FAILED",
      message: pageCountRes.detail,
      ...(pageCountRes.missing ? { missing: ["pdfinfo"] } : {}),
    };
  }

  const layoutRes = await runPdfToText({
    programs: options.programs,
    env: options.env,
    boundary: options.boundary,
    pdfPath,
    raw: false,
  });
  if (!layoutRes.ok) {
    return {
      ok: false,
      causeCode: layoutRes.missing
        ? "DOMAIN_CV_TAILOR_PREREQUISITE_MISSING"
        : "DOMAIN_CV_TAILOR_PROGRAM_FAILED",
      message: layoutRes.detail,
      ...(layoutRes.missing ? { missing: ["pdftotext"] } : {}),
    };
  }

  const rawRes = await runPdfToText({
    programs: options.programs,
    env: options.env,
    boundary: options.boundary,
    pdfPath,
    raw: true,
  });
  if (!rawRes.ok) {
    return {
      ok: false,
      causeCode: "DOMAIN_CV_TAILOR_PROGRAM_FAILED",
      message: rawRes.detail,
    };
  }

  const items: CheckItem[] = [];
  checkSourceRules(items, loaded.md);
  pushCheck(
    items,
    "pdf",
    pageCountRes.pages <= options.maxPages,
    `${String(pageCountRes.pages)} PDF pages (limit ${String(options.maxPages)})`,
    "too long",
  );
  checkExtractedText(items, "pdf-layout", layoutRes.stdout, loaded.md);
  checkExtractedText(items, "pdf-raw", rawRes.stdout, loaded.md);
  checkExtractedText(items, "word", loaded.wordText, loaded.md);
  checkParagraphsAndTerms(
    items,
    loaded.md,
    layoutRes.stdout,
    loaded.wordText,
    options.terms,
  );

  const failures = items.filter((item) => item.status === "FAIL").length;
  const warnings = items.filter((item) => item.status === "WARN").length;
  return {
    ok: true,
    report: {
      verdict: failures === 0 ? "PASS" : "FAIL",
      pdf: options.pdf,
      docx: options.docx,
      source: options.source,
      pages: pageCountRes.pages,
      maxPages: options.maxPages,
      failures,
      warnings,
      checks: items,
    },
  };
}
