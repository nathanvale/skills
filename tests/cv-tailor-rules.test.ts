import { expect, test } from "bun:test";
import {
  checkNameSpacing,
  extractEmails,
  extractPhones,
  findHiddenLinks,
  inOrder,
  isValidDateRange,
  parseCvMarkdown,
  scanDashes,
} from "../src/cv-tailor/cv/rules.ts";
import { buildPiles } from "../src/cv-tailor/pile/rules.ts";
import {
  evaluateQuery,
  hasTerm,
  normalise,
  parseQuery,
} from "../src/cv-tailor/search/rules.ts";

test("normalise folds NFKC, quotes, NBSP, hyphenated line breaks, and whitespace", () => {
  const cases: readonly {
    readonly input: string;
    readonly expected: string;
  }[] = [
    {
      input: "  Hello\u00A0World\t\n  again  ",
      expected: "Hello World again",
    },
    {
      input: "\u201CQuoted\u201D and \u2018single\u2019",
      expected: "\"Quoted\" and 'single'",
    },
    {
      input: "end-to-\n  end delivery",
      expected: "end-to-end delivery",
    },
    {
      input: "cross-\nfunctional\r\nteams",
      expected: "cross-functional teams",
    },
    {
      input: "\uFB01le system",
      expected: "file system",
    },
  ];
  for (const row of cases) {
    expect(normalise(row.input)).toBe(row.expected);
  }
});

test("hasTerm matches whole words, hyphen-or-space equivalence, and trailing prefix", () => {
  const text = normalise(
    "Built TypeScript microservices, CI/CD pipelines, end-to-end tests, and mentored engineers.",
  );
  const cases: readonly { readonly term: string; readonly matched: boolean }[] =
    [
      { term: "typescript", matched: true },
      { term: "Type", matched: false },
      { term: "end to end", matched: true },
      { term: "end-to-end", matched: true },
      { term: "mentor*", matched: true },
      { term: "mentor", matched: false },
      { term: "CI/CD", matched: true },
      { term: "kubernetes", matched: false },
    ];
  for (const row of cases) {
    expect(hasTerm(text, row.term)).toBe(row.matched);
  }
});

test("parseQuery and evaluateQuery enforce OR > AND > NOT > atom and adjacent AND", () => {
  const text = normalise(
    "TypeScript React Node mentoring platform architecture without Java",
  );
  const cases: readonly {
    readonly query: string;
    readonly hit: boolean;
    readonly absent: readonly string[];
    readonly excludedPresent: readonly string[];
  }[] = [
    {
      query: 'TypeScript AND "platform architecture"',
      hit: true,
      absent: [],
      excludedPresent: [],
    },
    {
      query: "TypeScript React",
      hit: true,
      absent: [],
      excludedPresent: [],
    },
    {
      query: "Rust OR TypeScript AND Node",
      hit: true,
      absent: ["Rust"],
      excludedPresent: [],
    },
    {
      query: "TypeScript AND NOT Python",
      hit: true,
      absent: [],
      excludedPresent: [],
    },
    {
      query: "TypeScript AND NOT Java",
      hit: false,
      absent: [],
      excludedPresent: ["Java"],
    },
    {
      query: "(Go OR Rust) AND mentor*",
      hit: false,
      absent: ["Go", "Rust"],
      excludedPresent: [],
    },
  ];
  for (const row of cases) {
    const parsed = parseQuery(row.query);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) continue;
    expect(evaluateQuery(parsed.query, text)).toEqual({
      hit: row.hit,
      absent: row.absent,
      excludedPresent: row.excludedPresent,
    });
  }

  expect(parseQuery("TypeScript AND (React").ok).toBe(false);
  expect(parseQuery("AND TypeScript").ok).toBe(false);
  expect(parseQuery("TypeScript OR").ok).toBe(false);
});

test("checkNameSpacing table test detects spaced names, joined letter-spacing faults, and missing names", () => {
  const cases: readonly {
    readonly label: string;
    readonly name: string;
    readonly rawText: string;
    readonly expected: "spaced" | "joined" | "missing";
  }[] = [
    {
      label: "title name parses as separate words",
      name: "Alex Example",
      rawText: "Alex Example\nPrincipal Software Engineer\n",
      expected: "spaced",
    },
    {
      label: "letter-spacing fault reads title as one word",
      name: "Alex Example",
      rawText: "AlexExample\nPrincipal Software Engineer\n",
      expected: "joined",
    },
    {
      label: "letter-spacing fault still caught when running header is spaced",
      name: "Alex Example",
      rawText: "  AlexExample\nExperience\nAlex Example - Page 2\n",
      expected: "joined",
    },
    {
      label: "name absent from extracted text",
      name: "Alex Example",
      rawText: "Principal Software Engineer\nMelbourne\n",
      expected: "missing",
    },
  ];
  for (const row of cases) {
    const actual = checkNameSpacing(
      row.name,
      row.rawText,
      normalise(row.rawText),
    );
    expect({ label: row.label, actual }).toEqual({
      label: row.label,
      actual: row.expected,
    });
  }
});

test("parseCvMarkdown strips front matter, parses structure, and refuses headings deeper than ###", () => {
  const validSource = [
    "---",
    "title: Sample",
    "---",
    "# Alex Example",
    "Senior TypeScript Engineer",
    "alex@example.com | +61 400 000 000 | [GitHub](https://github.com/example)",
    "",
    "## Experience",
    "### Lead Engineer, Acme Corp",
    "January 2023 to present | Melbourne",
    "- Built **fast** tools with [docs](https://docs.example.com)",
    "Summary line",
  ].join("\n");

  const parsed = parseCvMarkdown(validSource);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.document.name).toBe("Alex Example");
    expect(parsed.document.sections).toEqual(["Experience"]);
    expect(parsed.document.roles).toEqual([
      {
        title: "Lead Engineer, Acme Corp",
        dates: "January 2023 to present | Melbourne",
      },
    ]);
    expect(extractEmails(parsed.document.top.join(" "))).toEqual([
      "alex@example.com",
    ]);
    expect(extractPhones(parsed.document.top.join(" "))).toEqual([
      "+61 400 000 000",
    ]);
    expect(findHiddenLinks(parsed.document.links)).toEqual([
      { text: "GitHub", url: "https://github.com/example" },
      { text: "docs", url: "https://docs.example.com" },
    ]);
    expect(isValidDateRange("January 2023 to present")).toBe(true);
    expect(isValidDateRange("2023 to present")).toBe(false);
    expect(scanDashes("plain to range")).toEqual([]);
    expect(scanDashes("bad \u2014 and \u2013")).toEqual(["U+2014", "U+2013"]);
    expect(
      inOrder("experience lead engineer", ["Experience", "Lead Engineer"]),
    ).toEqual({
      found: 2,
      stray: null,
    });
  }

  const deepHeading = parseCvMarkdown("# Alex\n#### Too Deep\n");
  expect(deepHeading.ok).toBe(false);
});

test("buildPiles is deterministic for a seed and gives distinct new-page positions while slots last", () => {
  const competitors = [
    { name: "s1", text: "Candidate one" },
    { name: "s2", text: "Candidate two" },
    { name: "s3", text: "Candidate three" },
    { name: "s4", text: "Candidate four" },
  ];
  const first = buildPiles({
    competitors,
    newPageText: "New target page",
    oldPageText: "Old target page",
    runs: 3,
    seed: 7,
  });
  const second = buildPiles({
    competitors,
    newPageText: "New target page",
    oldPageText: "Old target page",
    runs: 3,
    seed: 7,
  });
  expect(first).toEqual(second);
  expect(first.piles.length).toBe(4);
  const newPositions = first.piles
    .filter((pile) => pile.version === "new")
    .map((pile) => pile.targetPosition);
  expect(new Set(newPositions).size).toBe(3);
  expect(first.keyText.startsWith("seed 7\n")).toBe(true);
  expect(first.piles[0]?.content).toContain("===== CANDIDATE C1 =====");
});
