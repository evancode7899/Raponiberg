import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The one way the app writes its own JSON files in the data folder (decisions, rules,
 * reviews, document indexes, the sweep's verdicts). Each store keeps its own path and format;
 * this only does the writing, the same way everywhere:
 *
 * - written whole to a temporary file beside it, then renamed over it, so a crash never
 *   leaves half a file;
 * - when the rename is refused (OneDrive can lock a file for a moment while it syncs: EPERM),
 *   it is written in place instead and the temporary file removed;
 * - a store with a journal appends what changed to `<name>.journal.jsonl` first, so the file
 *   can be rebuilt from it.
 */

export type JsonFormat = {
  /** Spaces per level: 2 for files people read, 1 for large indexes, 0 for one line. */
  indent?: number;
  /** End the file with a newline. */
  newline?: boolean;
};

/** The text a store writes, in its own format. */
export function jsonText(data: unknown, { indent = 2, newline = true }: JsonFormat = {}): string {
  return (indent ? JSON.stringify(data, null, indent) : JSON.stringify(data)) + (newline ? "\n" : "");
}

/** Writes `text` to `file` whole or not at all (see above). `tmp` names the temporary file when two processes may write at once. */
export function writeTextAtomic(file: string, text: string, { tmp = `${file}.tmp`, mkdir = true, fallback = true }: { tmp?: string; mkdir?: boolean; fallback?: boolean } = {}): void {
  if (mkdir) mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch (e) {
    if (!fallback) {
      rmSync(tmp, { force: true });
      throw e;
    }
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}

/** Writes `data` as JSON to `file`, in the store's format, whole or not at all. */
export function writeJsonAtomic(file: string, data: unknown, format: JsonFormat & { tmp?: string; mkdir?: boolean } = {}): void {
  writeTextAtomic(file, jsonText(data, format), { tmp: format.tmp, mkdir: format.mkdir });
}

/** The journal beside a store: decisions.json → decisions.journal.jsonl. */
export function journalPathOf(file: string): string {
  return file.replace(/\.json$/, "") + ".journal.jsonl";
}

/** Appends one change to a journal, stamped with when it happened. */
export function appendJournal(journalFile: string, entry: Record<string, unknown>, at: string = new Date().toISOString()): void {
  mkdirSync(path.dirname(journalFile), { recursive: true });
  appendFileSync(journalFile, JSON.stringify({ at, ...entry }) + "\n");
}

/**
 * Reads a store's JSON: `empty()` when there is no file. A damaged file is an error, never
 * read as empty: writing "empty" back over it would lose everything in it.
 */
export function readJsonStore<T>(file: string, empty: () => T, { journal }: { journal?: string } = {}): T {
  if (!existsSync(file)) return empty();
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    const from = journal ? `${path.basename(journal)} or a backup` : "a backup";
    throw new Error(`${path.basename(file)} is damaged (not valid JSON). Restore it from ${from}.`);
  }
}
