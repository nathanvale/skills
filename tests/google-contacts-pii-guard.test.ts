import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../src/skills-catalog/skills-catalog.ts";

const RFC2606_DOMAIN_RE = /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i;
const EMAIL_LITERAL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_LITERAL_RE =
  /(?:\+61[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{3}|\+1[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{4}|\b04\d{2}[\s-]?\d{3}[\s-]?\d{3}\b)/g;

function collectFilesRecursive(dirPath: string, out: string[]): void {
  if (!existsSync(dirPath)) return;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function collectPrefixedFiles(
  dirPath: string,
  prefix: string,
  out: string[],
): void {
  if (!existsSync(dirPath)) return;
  for (const name of readdirSync(dirPath)) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dirPath, name);
    if (statSync(full).isFile()) out.push(full);
  }
}

function collectGoogleContactsFiles(root: string): readonly string[] {
  const files: string[] = [];
  collectFilesRecursive(join(root, "src", "google-contacts"), files);
  collectFilesRecursive(
    join(root, "skills", "in-progress", "google-contacts"),
    files,
  );
  collectFilesRecursive(join(root, "verify"), files);
  collectPrefixedFiles(join(root, "tests"), "google-contacts", files);
  collectPrefixedFiles(
    join(root, "tests", "support"),
    "google-contacts",
    files,
  );
  return files;
}

function isAllowedFictionalPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("61491570") && digits.length === 11) {
    const suffix = Number(digits.slice(8));
    return suffix >= 0 && suffix <= 999;
  }
  if (digits.startsWith("0491570") && digits.length === 10) {
    const suffix = Number(digits.slice(7));
    return suffix >= 0 && suffix <= 999;
  }
  if (digits.startsWith("120255501") && digits.length === 11) {
    const suffix = Number(digits.slice(9));
    return suffix >= 0 && suffix <= 99;
  }
  return false;
}

test("all google-contacts source, skill docs, tests, stubs, and verify scenarios contain zero real PII", () => {
  const root = repositoryRoot();
  const files = collectGoogleContactsFiles(root);
  expect(files.length).toBeGreaterThan(10);
  const badEmails: string[] = [];
  const badPhones: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(EMAIL_LITERAL_RE)) {
      const email = match[0];
      const domain = email.slice(email.lastIndexOf("@") + 1);
      if (!RFC2606_DOMAIN_RE.test(domain)) {
        badEmails.push(`${file}: ${email}`);
      }
    }
    for (const match of text.matchAll(PHONE_LITERAL_RE)) {
      const phone = match[0];
      if (!isAllowedFictionalPhone(phone)) {
        badPhones.push(`${file}: ${phone}`);
      }
    }
  }
  expect(badEmails).toEqual([]);
  expect(badPhones).toEqual([]);
});
