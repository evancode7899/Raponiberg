import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./dataDir.ts";
import { readJsonStore, writeJsonAtomic } from "./jsonStore.ts";

/**
 * The restatement log: what each figure was at the last month-end, kept as it was then.
 *
 * After every proof sweep, the figures it cleared (descriptor key → value) are written down
 * under the month of the sweep's own day. When a sweep lands in a new month, the last record of
 * the month before becomes the month-end record, and stays as it was: it is never rebuilt
 * from today's data, so a figure that moved since (a statement imported late, a row filed
 * again) shows what it was and what it is now. The log starts the day this ships; there is
 * no record from before, by design.
 *
 * Kept in data/restatements.json (lib/appFiles.ts: no figure reads it, so writing it never
 * rebuilds the Book). Keys are shortened to a hash to keep the file small.
 */
export type Value = { cents: number } | { ratio: number } | { text: string };
export type MonthRecord = { month: string; takenAt: string; today: string; values: Record<string, Value> };
export type Restatements = { version: 1; current: MonthRecord | null; monthEnd: MonthRecord | null };

export const RESTATEMENTS_FILE = "restatements.json";
export const restatementsPath = (dir = dataDir()) => path.join(dir, RESTATEMENTS_FILE);
const EMPTY: Restatements = { version: 1, current: null, monthEnd: null };

/** A figure's key as the log keeps it. */
export const shortKey = (descriptorKey: string) => createHash("sha256").update(descriptorKey).digest("hex").slice(0, 16);

/** The log after a sweep of `today` cleared `cleared`: the month's record replaced, or the month before closed into the month-end record. */
export function rollForward(prev: Restatements, sweep: { today: string; cleared: Record<string, Value> }, takenAt: string): Restatements {
  const month = sweep.today.slice(0, 7);
  const values: Record<string, Value> = {};
  for (const [k, v] of Object.entries(sweep.cleared)) values[shortKey(k)] = v;
  const record: MonthRecord = { month, takenAt, today: sweep.today, values };
  const cur = prev.current;
  if (cur && cur.month < month) return { version: 1, current: record, monthEnd: cur };
  return { version: 1, current: record, monthEnd: prev.monthEnd && prev.monthEnd.month < month ? prev.monthEnd : null };
}

export function readRestatements(file = restatementsPath()): Restatements {
  try {
    const r = readJsonStore<Restatements>(file, () => EMPTY);
    return r && r.version === 1 ? r : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Writes the sweep into the log. Never fails the sweep. */
export function recordSweep(body: string, file = restatementsPath(), now = new Date()): void {
  try {
    const r = JSON.parse(body) as { today?: string; cleared?: Record<string, Value> };
    if (typeof r.today !== "string" || !r.cleared) return;
    writeJsonAtomic(file, rollForward(readRestatements(file), { today: r.today, cleared: r.cleared }, now.toISOString()), { indent: 0 });
    cache = null;
  } catch {
    /* the next sweep writes it */
  }
}

// The month-end record, read once per change to the file.
let cache: { file: string; mtime: number; r: Restatements } | null = null;
function cached(file = restatementsPath()): Restatements {
  const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (cache?.file !== file || cache.mtime !== mtime) cache = { file, mtime, r: mtime ? readRestatements(file) : EMPTY };
  return cache.r;
}

export function sameValue(a: Value, b: Value): boolean {
  if ("cents" in a && "cents" in b) return Math.round(a.cents) === Math.round(b.cents);
  if ("ratio" in a && "ratio" in b) return Math.abs(a.ratio - b.ratio) < 1e-9;
  if ("text" in a && "text" in b) return a.text === b.text;
  return false;
}

export type AtMonthEnd = { month: string; takenAt: string; was: Value | null; moved: boolean };

/** What a figure was at the last month-end, if the log has a month-end yet. `was` null: it wasn't a cleared figure then. */
export function atMonthEnd(descriptorKey: string, now: Value, file = restatementsPath()): AtMonthEnd | null {
  const end = cached(file).monthEnd;
  if (!end) return null;
  const was = end.values[shortKey(descriptorKey)] ?? null;
  return { month: end.month, takenAt: end.takenAt, was, moved: !was || !sameValue(was, now) };
}

export type Moved = { key: string; was: Value; now: Value };

/** Every figure cleared now whose value differs from the month-end record, largest move first. Figures new since, or gone, aren't moves. */
export function movedSince(cleared: Record<string, Value>, file = restatementsPath()): { month: string; takenAt: string; moved: Moved[]; compared: number } | null {
  const end = cached(file).monthEnd;
  if (!end) return null;
  const moved: Moved[] = [];
  let compared = 0;
  for (const [key, now] of Object.entries(cleared)) {
    const was = end.values[shortKey(key)];
    if (!was) continue;
    compared++;
    if (!sameValue(was, now)) moved.push({ key, was, now });
  }
  const size = (m: Moved) => ("cents" in m.was && "cents" in m.now ? Math.abs(m.now.cents - m.was.cents) : 0);
  moved.sort((a, b) => size(b) - size(a));
  return { month: end.month, takenAt: end.takenAt, moved, compared };
}
