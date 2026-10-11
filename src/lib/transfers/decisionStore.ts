import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";

/**
 * The owner's transfer decisions: pairings they confirmed by hand (e.g. a rollover that
 * lost a fee in transit) and pairings they rejected. Like the permanent exceptions, they
 * live in a file next to the database, not only in it: re-importing a statement (a parser
 * upgrade, a replaced PDF) or rebuilding the database recreates its rows with new ids,
 * and a decision tied to the old ids would silently vanish.
 *
 * Each leg is recorded by what identifies it across imports: its account (institution and
 * every identifier the account goes by), date and amount. Every matching run re-applies
 * the decisions to whatever rows carry those facts today. A leg that matches no row, or
 * more than one, is left alone (a wrong pair is worse than no pair) and its decision
 * waits until the rows are unambiguous again.
 *
 * Every change is also appended to a journal beside the file.
 */

export type LegFingerprint = { institution: string; identifiers: string[]; date: string; amountCents: number };

export type ConfirmedDecision = { legs: LegFingerprint[]; differenceCents: number; note: string | null; confirmedAt: string };
export type RejectedDecision = { legs: LegFingerprint[]; rejectedAt: string };
export type DecisionsFile = { version: 1; confirmed: ConfirmedDecision[]; rejected: RejectedDecision[] };

export function decisionsFilePath(): string {
  return process.env.TRANSFER_DECISIONS_FILE || path.join(dataDir(), "transfer-decisions.json");
}

const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** Reads the decisions. A missing file is none; a damaged one is an error, never none. */
export function readDecisions(file = decisionsFilePath()): DecisionsFile {
  if (!existsSync(file)) return { version: 1, confirmed: [], rejected: [] };
  let parsed: Partial<DecisionsFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DecisionsFile>;
  } catch {
    throw new Error(`The transfer decisions file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} before continuing.`);
  }
  // A newer app wrote it: reading it as version 1 could silently drop what it added.
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The transfer decisions file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.confirmed) || !Array.isArray(parsed.rejected)) {
    throw new Error(`The transfer decisions file ${file} is damaged (missing its lists). Restore it from ${journalPath(file)} before continuing.`);
  }
  return { version: 1, confirmed: parsed.confirmed, rejected: parsed.rejected };
}

function write(file: string, data: DecisionsFile, journal: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), ...journal }) + "\n");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/** The same leg: same institution, a shared account identifier, same date and amount. */
export const sameLeg = (a: LegFingerprint, b: LegFingerprint) =>
  a.date === b.date && a.amountCents === b.amountCents && a.institution === b.institution && a.identifiers.some((i) => b.identifiers.includes(i));

/** Same set of legs, in any order. */
export const sameLegs = (a: LegFingerprint[], b: LegFingerprint[]) =>
  a.length === b.length && a.every((l) => b.some((m) => sameLeg(l, m))) && b.every((l) => a.some((m) => sameLeg(l, m)));

/** Records a confirmed pairing (replacing an earlier rejection of the same legs). */
export function recordConfirmed(entry: Omit<ConfirmedDecision, "confirmedAt">, file = decisionsFilePath()): DecisionsFile {
  const data = readDecisions(file);
  if (data.confirmed.some((c) => sameLegs(c.legs, entry.legs))) return data;
  const decision = { ...entry, confirmedAt: new Date().toISOString() };
  data.confirmed.push(decision);
  data.rejected = data.rejected.filter((r) => !sameLegs(r.legs, entry.legs));
  write(file, data, { op: "confirm", decision });
  return data;
}

/** Records a rejected pairing (undoing an earlier confirmation of the same legs). */
export function recordRejected(legs: LegFingerprint[], file = decisionsFilePath()): DecisionsFile {
  const data = readDecisions(file);
  const wasConfirmed = data.confirmed.some((c) => sameLegs(c.legs, legs));
  if (!wasConfirmed && data.rejected.some((r) => sameLegs(r.legs, legs))) return data;
  data.confirmed = data.confirmed.filter((c) => !sameLegs(c.legs, legs));
  if (!data.rejected.some((r) => sameLegs(r.legs, legs))) data.rejected.push({ legs, rejectedAt: new Date().toISOString() });
  write(file, data, { op: "reject", legs, wasConfirmed });
  return data;
}

/**
 * The row ids a decision's legs point at today, or null when any leg matches no row or
 * more than one, or two legs land on the same row.
 */
export function resolveLegs<R extends { id: string } & LegFingerprint>(legs: LegFingerprint[], rows: R[]): string[] | null {
  const ids: string[] = [];
  for (const leg of legs) {
    const hits = rows.filter((r) => sameLeg(leg, r));
    if (hits.length !== 1 || ids.includes(hits[0]!.id)) return null;
    ids.push(hits[0]!.id);
  }
  return ids;
}
