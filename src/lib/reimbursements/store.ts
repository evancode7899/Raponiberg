import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { RowFingerprint } from "../review/rowFingerprint.ts";

/**
 * The owner's reimbursement links: "this charge was paid back by that money". A link ties
 * one spending row to what paid it back (a non-taxable reimbursement line on a pay stub,
 * or an incoming row such as a Zelle from the employer) for an amount up to the charge.
 * One payback can cover several charges (a check for three expense reports), and one
 * charge can be paid back by more than one payback, as long as neither side is used past
 * its amount.
 *
 * Like the transfer and row decisions, the links live in a file next to the database:
 * re-importing a statement or rebuilding the database recreates rows with new ids, so
 * each side is recorded by the facts that identify it across imports (book/reimbursements.ts
 * finds them again on every load). Every change is appended to a journal beside the file.
 */

/** A pay stub's reimbursement line: the employer, the pay date, the line's name and this period's amount. */
export type StubLineRef = { employerKey: string; payDate: string; line: string; cents: number };

export type ReimbursementSource = { kind: "stub"; stub: StubLineRef } | { kind: "row"; row: RowFingerprint };

export type ReimbursementLink = {
  id: string;
  /** The charge that was paid back (a spending row). */
  expense: RowFingerprint;
  source: ReimbursementSource;
  /** How much of the charge this payback covered (positive, at most the charge). */
  cents: number;
  note: string | null;
  linkedAt: string;
};

export type ReimbursementLinksFile = { version: 1; links: ReimbursementLink[] };

export function reimbursementLinksFilePath(): string {
  return process.env.REIMBURSEMENT_LINKS_FILE || path.join(dataDir(), "reimbursement-links.json");
}
const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** Reads the links. A missing file is none; a damaged one is an error, never none. */
export function readReimbursementLinks(file = reimbursementLinksFilePath()): ReimbursementLinksFile {
  if (!existsSync(file)) return { version: 1, links: [] };
  let parsed: Partial<ReimbursementLinksFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ReimbursementLinksFile>;
  } catch {
    throw new Error(`The reimbursement links file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} before continuing.`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The reimbursement links file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.links)) {
    throw new Error(`The reimbursement links file ${file} is damaged (missing its list). Restore it from ${journalPath(file)} before continuing.`);
  }
  return { version: 1, links: parsed.links };
}

function write(file: string, data: ReimbursementLinksFile, journal: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), ...journal }) + "\n");
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    // OneDrive can briefly lock the file mid-sync (EPERM on rename); write in place instead.
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}

/** Saves a new link. The caller has checked it fits (book/reimbursements.ts remainingFor). */
export function addReimbursementLink(entry: Omit<ReimbursementLink, "id" | "linkedAt">, file = reimbursementLinksFilePath()): ReimbursementLink {
  if (!Number.isInteger(entry.cents) || entry.cents <= 0) throw new Error("The amount paid back must be more than $0.");
  const data = readReimbursementLinks(file);
  const link: ReimbursementLink = { id: randomUUID(), ...entry, note: entry.note?.trim().slice(0, 200) || null, linkedAt: new Date().toISOString() };
  data.links.push(link);
  write(file, data, { op: "link", link });
  return link;
}

/** Removes a link by id. Returns whether one was removed. */
export function removeReimbursementLink(id: string, file = reimbursementLinksFilePath()): boolean {
  const data = readReimbursementLinks(file);
  const link = data.links.find((l) => l.id === id);
  if (!link) return false;
  data.links = data.links.filter((l) => l.id !== id);
  write(file, data, { op: "unlink", link });
  return true;
}
