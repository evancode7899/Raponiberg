import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./dataDir.ts";

/**
 * Calculator inputs (Home budget, Mortgage) saved on disk in data/page-inputs.json rather
 * than only in the browser, so they come back with the rest of the data from a backup or
 * on another browser. The Book never reads them, so saving one doesn't rebuild it (the
 * file is left out of lib/book/cache.ts's dataStamp).
 */

export const PAGE_INPUTS_FILE_NAME = "page-inputs.json";
/** Keys a page may save: the localStorage keys the pages used before. */
export const PAGE_INPUT_KEYS = ["pf-home-budget-inputs", "pf-home-budget-funds", "pf-mortgage-v2"] as const;
export type PageInputKey = (typeof PAGE_INPUT_KEYS)[number];
export const isPageInputKey = (k: string): k is PageInputKey => (PAGE_INPUT_KEYS as readonly string[]).includes(k);

const MAX_BYTES = 64 * 1024;

type PageInputsFile = { version: 1; inputs: Partial<Record<PageInputKey, { value: Record<string, unknown>; savedAt: string }>> };

export function pageInputsFilePath(): string {
  return process.env.PAGE_INPUTS_FILE || path.join(dataDir(), PAGE_INPUTS_FILE_NAME);
}

function read(file: string): PageInputsFile {
  if (!existsSync(file)) return { version: 1, inputs: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PageInputsFile>;
    return { version: 1, inputs: parsed.inputs && typeof parsed.inputs === "object" ? parsed.inputs : {} };
  } catch {
    // Calculator inputs only: a damaged file reads as none (the pages fall back to defaults).
    return { version: 1, inputs: {} };
  }
}

export function readPageInputs(key: PageInputKey, file = pageInputsFilePath()): Record<string, unknown> | null {
  return read(file).inputs[key]?.value ?? null;
}

/** Saves one page's inputs (a plain object). Throws on anything else or on oversized input. */
export function writePageInputs(key: PageInputKey, value: unknown, file = pageInputsFilePath()): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object of inputs");
  if (JSON.stringify(value).length > MAX_BYTES) throw new Error("Inputs too large");
  const data = read(file);
  data.inputs[key] = { value: value as Record<string, unknown>, savedAt: new Date().toISOString() };
  mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}
