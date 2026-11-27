import { expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCvMarkdown } from "../src/cv-tailor/cv/rules.ts";
import { buildDocxFromTemplate } from "../src/cv-tailor/docx/template.ts";
import { readZip, writeStoredZip } from "../src/cv-tailor/docx/zip.ts";
import { createCvTailorRunner } from "./support/cv-tailor-run.ts";
import { testFolder } from "./support/test-folder.ts";

const fixtureDir = resolve(import.meta.dir, "fixtures", "cv-tailor");
const sofficeStub = resolve(
  import.meta.dir,
  "support",
  "cv-tailor-soffice-stub.sh",
);

function createRunner(scratch: string, cwd: string = fixtureDir) {
  return createCvTailorRunner({
    env: {
      ...process.env,
      CV_TAILOR_STATE_DIR: join(scratch, "state"),
      CV_TAILOR_SETTINGS_FILE: join(scratch, "settings.json"),
      CV_TAILOR_SOFFICE: sofficeStub,
    },
    cwd,
  });
}

test("cv build run twice into two scratch folders gives byte-identical docx files matching expected/cv.docx", async () => {
  const scratchA = testFolder("cv-tailor-build-a-");
  const scratchB = testFolder("cv-tailor-build-b-");
  try {
    const runA = createRunner(scratchA);
    const runB = createRunner(scratchB);
    const outA = join(scratchA, "out");
    const outB = join(scratchB, "out");

    const resA = await runA([
      "cv",
      "build",
      "cv.md",
      "--template",
      "template.docx",
      "--out",
      outA,
    ]);
    const resB = await runB([
      "cv",
      "build",
      "cv.md",
      "--template",
      "template.docx",
      "--out",
      outB,
    ]);

    expect(resA.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      data: {
        docx: join(outA, "cv.docx"),
        pdf: join(outA, "cv.pdf"),
        pages: 2,
      },
    });
    expect(resB.result).toMatchObject({
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      data: {
        docx: join(outB, "cv.docx"),
        pdf: join(outB, "cv.pdf"),
        pages: 2,
      },
    });

    const bytesA = readFileSync(join(outA, "cv.docx"));
    const bytesB = readFileSync(join(outB, "cv.docx"));
    const expectedBytes = readFileSync(join(fixtureDir, "expected", "cv.docx"));

    expect(Buffer.compare(bytesA, bytesB)).toBe(0);
    expect(Buffer.compare(bytesA, expectedBytes)).toBe(0);
  } finally {
    rmSync(scratchA, { recursive: true, force: true });
    rmSync(scratchB, { recursive: true, force: true });
  }
});

test("cv build refuses to overwrite the template and refuses headings deeper than ###", async () => {
  const scratch = testFolder("cv-tailor-build-refuse-");
  try {
    const copiedTemplate = join(scratch, "cv.docx");
    cpSync(join(fixtureDir, "template.docx"), copiedTemplate);
    const badMd = join(scratch, "bad.md");
    writeFileSync(badMd, "# Alex Example\n#### Too Deep\n", "utf8");

    const run = createRunner(scratch, scratch);
    const overwrite = await run([
      "cv",
      "build",
      join(fixtureDir, "cv.md"),
      "--template",
      copiedTemplate,
      "--out",
      scratch,
    ]);
    expect(overwrite.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_TEMPLATE_OVERWRITE",
      transactionState: "unchanged",
    });

    const deepHeading = await run([
      "cv",
      "build",
      badMd,
      "--template",
      copiedTemplate,
      "--out",
      join(scratch, "out"),
    ]);
    expect(deepHeading.result).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_CV_TAILOR_SOURCE_INVALID",
      transactionState: "unchanged",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function buildTemplateBytes(stylesXml: string): Uint8Array {
  const encoder = new TextEncoder();
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sectPr/></w:body></w:document>';
  return writeStoredZip([
    {
      name: "word/styles.xml",
      data: encoder.encode(stylesXml),
      externalAttributes: 0,
    },
    {
      name: "word/document.xml",
      data: encoder.encode(documentXml),
      externalAttributes: 0,
    },
  ]);
}

function extractParagraphStyleIds(docxBytes: Uint8Array): readonly string[] {
  const archive = readZip(docxBytes);
  if (!archive.ok) throw new Error(archive.error);
  const docEntry = archive.entries.find(
    (entry) => entry.name === "word/document.xml",
  );
  if (docEntry === undefined) throw new Error("missing word/document.xml");
  const xml = new TextDecoder().decode(docEntry.data);
  const styleIds: string[] = [];
  for (const match of xml.matchAll(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/g)) {
    const styleId = match[1];
    if (styleId !== undefined) styleIds.push(styleId);
  }
  return styleIds;
}

test("style resolver matches Word lowercase built-in names and custom styles by styleId while keeping template styleIds", () => {
  const parsed = parseCvMarkdown(
    [
      "# Alex Example",
      "Principal Engineer",
      "alex@example.com | Melbourne",
      "",
      "## Experience",
      "### Lead Engineer, Acme Corp",
      "January 2023 to present | Melbourne",
      "- Built fast tools",
      "Summary paragraph",
    ].join("\n"),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  const cases: readonly {
    readonly label: string;
    readonly stylesXml: string;
    readonly expectedOk: boolean;
    readonly expectedStyleIds?: readonly string[];
    readonly expectedErrorSubstring?: string;
  }[] = [
    {
      label:
        "Word stored built-in lowercase names and custom Contact Details / Role Details",
      stylesXml: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="ContactDetails"><w:name w:val="Contact Details"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="RoleDetails"><w:name w:val="Role Details"/></w:style>',
        "</w:styles>",
      ].join("\n"),
      expectedOk: true,
      expectedStyleIds: [
        "Title",
        "Subtitle",
        "ContactDetails",
        "Heading1",
        "Heading2",
        "RoleDetails",
        "ListBullet",
      ],
    },
    {
      label:
        "lowercase built-ins with custom styleIds and Contact Details / Role Details matched by styleId",
      stylesXml: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '  <w:style w:type="paragraph" w:styleId="CustomH1"><w:name w:val="heading 1"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="CustomH2"><w:name w:val="heading 2"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="CustomTitle"><w:name w:val="title"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="CustomSubtitle"><w:name w:val="subtitle"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="CustomBullet"><w:name w:val="list bullet"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="ContactDetails"><w:name w:val="Contact Details"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="RoleDetails"><w:name w:val="Role Details"/></w:style>',
        "</w:styles>",
      ].join("\n"),
      expectedOk: true,
      expectedStyleIds: [
        "CustomTitle",
        "CustomSubtitle",
        "ContactDetails",
        "CustomH1",
        "CustomH2",
        "RoleDetails",
        "CustomBullet",
      ],
    },
    {
      label: "missing required style reports missing style name",
      stylesXml: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="ContactDetails"><w:name w:val="Contact Details"/></w:style>',
        '  <w:style w:type="paragraph" w:styleId="RoleDetails"><w:name w:val="Role Details"/></w:style>',
        "</w:styles>",
      ].join("\n"),
      expectedOk: false,
      expectedErrorSubstring: "Heading 2",
    },
  ];

  for (const row of cases) {
    const built = buildDocxFromTemplate(
      buildTemplateBytes(row.stylesXml),
      parsed.document,
    );
    expect({ label: row.label, ok: built.ok }).toEqual({
      label: row.label,
      ok: row.expectedOk,
    });
    if (built.ok && row.expectedStyleIds !== undefined) {
      expect({
        label: row.label,
        styleIds: extractParagraphStyleIds(built.bytes),
      }).toEqual({
        label: row.label,
        styleIds: row.expectedStyleIds,
      });
    }
    if (!built.ok && row.expectedErrorSubstring !== undefined) {
      expect(built.error).toContain(row.expectedErrorSubstring);
    }
  }
});
