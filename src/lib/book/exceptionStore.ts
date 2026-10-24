import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { RetiredException, StandingException } from "./types.ts";

/**
 * The permanent exceptions list: findings the owner explained by hand. It lives in a file
 * next to the database, not in it, so wiping, rebuilding or restoring the database never
 * loses the owner's work — a rebuilt Book raises the same finding ids (findingKeys.ts)
 * and the exceptions apply again.
 *
 * Entries are only ever added. The one way out is retireException, called only when the
 * owner approves it on Statements → Issues with a reason; a retired entry moves to
 * `retired` and is kept forever. Every change is also appended to a journal beside the
 * file, so the list can be rebuilt from it if the file is ever damaged.
 */

export type ExceptionsFile = { version: 1; exceptions: StandingException[]; retired: RetiredException[] };

export function exceptionsFilePath(): string {
  return process.env.INTEGRITY_EXCEPTIONS_FILE || path.join(dataDir(), "integrity-exceptions.json");
}

const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** Reads the list. A missing file is an empty list; a damaged one is an error, never an empty list. */
export function readExceptions(file = exceptionsFilePath()): ExceptionsFile {
  if (!existsSync(file)) return { version: 1, exceptions: [], retired: [] };
  const raw = readFileSync(file, "utf8");
  let parsed: Partial<ExceptionsFile>;
  try {
    parsed = JSON.parse(raw) as Partial<ExceptionsFile>;
  } catch {
    throw new Error(`The exceptions file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} before continuing.`);
  }
  // A newer app wrote it: reading it as version 1 could silently drop what it added.
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The exceptions file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.exceptions) || !Array.isArray(parsed.retired)) {
    throw new Error(`The exceptions file ${file} is damaged (missing its lists). Restore it from ${journalPath(file)} before continuing.`);
  }
  return { version: 1, exceptions: parsed.exceptions, retired: parsed.retired };
}

function write(file: string, data: ExceptionsFile, journal: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), ...journal }) + "\n");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Adds an exception. An id already on the list is refused (retire it first to replace its note). */
export function addException(entry: StandingException, file = exceptionsFilePath()): ExceptionsFile {
  if (!entry.note.trim()) throw new Error("An exception needs a note explaining it.");
  const data = readExceptions(file);
  if (data.exceptions.some((e) => e.id === entry.id)) throw new Error("That finding is already an accepted exception.");
  data.exceptions.push(entry);
  write(file, data, { op: "add", entry });
  return data;
}

/**
 * Retires an exception: only on the owner's approval, with their reason (typically what
 * new data made it redundant). The entry moves to `retired`; nothing is deleted.
 */
export function retireException(id: string, reason: string, file = exceptionsFilePath()): ExceptionsFile {
  if (!reason.trim()) throw new Error("Retiring an exception needs a reason.");
  const data = readExceptions(file);
  const entry = data.exceptions.find((e) => e.id === id);
  if (!entry) throw new Error("No accepted exception has that id.");
  const retired: RetiredException = { ...entry, retiredAt: new Date().toISOString(), reason: reason.trim().slice(0, 1000) };
  data.exceptions = data.exceptions.filter((e) => e.id !== id);
  data.retired.push(retired);
  write(file, data, { op: "retire", id, reason: retired.reason });
  return data;
}

/**
 * Adds exceptions (and retired ones) kept somewhere else until now, in one write: those
 * whose id the list already holds, live or retired, are left as they are. Returns how many
 * were added. Used to bring the bonus letter reviews into this list (bonuses/migrateReviews.ts).
 */
export function importExceptions(entries: StandingException[], retired: RetiredException[], source: string, file = exceptionsFilePath()): number {
  const data = readExceptions(file);
  const known = new Set([...data.exceptions, ...data.retired].map((e) => e.id));
  const add = entries.filter((e) => !known.has(e.id) && e.note.trim());
  const addRetired = retired.filter((e) => !known.has(e.id));
  if (!add.length && !addRetired.length) return 0;
  data.exceptions.push(...add);
  data.retired.push(...addRetired);
  write(file, data, { op: "import", source, ids: [...add, ...addRetired].map((e) => e.id) });
  return add.length + addRetired.length;
}
