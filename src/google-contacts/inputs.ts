import { readFileSync } from "node:fs";

export type JsonFileResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

export function readJsonFile(filePath: string): JsonFileResult {
  let rawText: string;
  try {
    rawText = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Cannot read file ${filePath}: ${message}` };
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    return { ok: true, value: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Malformed JSON in ${filePath}: ${message}`,
    };
  }
}
