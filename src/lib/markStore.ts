import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Mark } from "./marks.ts";
export type { Mark };

/**
 * A small list of the owner's marks on things the app shows (a feed item dismissed, a
 * calendar date done), kept in a file in the data folder, never only in the database: a
 * rebuilt or restored database loses none of them, the backup copies the file with the rest
 * of the folder, and the demo keeps its own in its own folder. Every change is appended to
 * a journal beside it. No figure reads these files, so a mark never rebuilds the Book
 * (they're left out of lib/book/cache.ts's stamp).
 *
 * Each mark is keyed by the thing's id; `says` is what the thing said when it was marked,
 * so a mark holds only while the thing still says the same.
 */


type MarkFile = { version: 1; marks: Mark[] };

const MAX_MARKS = 2000;
const journalOf = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** The marks in a file: none when there is no file. A damaged one is an error, never read as none. */
export function readMarks(file: string): Mark[] {
  if (!existsSync(file)) return [];
  let parsed: Partial<MarkFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MarkFile>;
  } catch {
    throw new Error(`${path.basename(file)} is damaged (not valid JSON). Restore it from ${path.basename(journalOf(file))} or a backup.`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) throw new Error(`${path.basename(file)} was written by a newer version of the app.`);
  if (!Array.isArray(parsed.marks)) throw new Error(`${path.basename(file)} is damaged (no list of marks).`);
  return parsed.marks.filter((m): m is Mark => typeof m?.id === "string" && typeof m.says === "string");
}

function write(file: string, marks: Mark[], journal: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalOf(file), JSON.stringify({ at: new Date().toISOString(), ...journal }) + "\n");
  const text = JSON.stringify({ version: 1, marks } satisfies MarkFile, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Marks a thing (replacing any mark it had). */
export function addMark(file: string, m: { id: string; says: string; until?: string | null }, now = new Date()): Mark[] {
  if (!m.id || m.id.length > 300 || typeof m.says !== "string" || m.says.length > 2000) throw new Error("A mark needs the thing's id and what it says.");
  if (m.until != null && !isDay(m.until)) throw new Error("until must be YYYY-MM-DD.");
  const mark: Mark = { id: m.id, says: m.says, at: now.toISOString(), until: m.until ?? null };
  const marks = [...readMarks(file).filter((x) => x.id !== m.id), mark].slice(-MAX_MARKS);
  write(file, marks, { op: "add", mark });
  return marks;
}

/** Takes a thing's mark off (undo). */
export function removeMark(file: string, id: string): Mark[] {
  const marks = readMarks(file);
  if (!marks.some((x) => x.id === id)) return marks;
  const left = marks.filter((x) => x.id !== id);
  write(file, left, { op: "remove", id });
  return left;
}
