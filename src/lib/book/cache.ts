import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { localToday } from "../dates/isoDate.ts";
import { deepFreeze } from "./freeze.ts";
import { loadBook, type Book } from "./load.ts";

type Db = Parameters<typeof loadBook>[0];

/**
 * The Book, kept in memory between requests. Building it reads the whole ledger and runs
 * every integrity check (about a second), and every page needs it, so it's built once
 * per change to the data rather than once per request.
 *
 * "A change to the data" is read off the files themselves (dataStamp): the database and
 * its write-ahead log, and every JSON file the figures read (exceptions, transfer
 * decisions, bonus letters and reviews, merchant rules, row decisions). Any write moves
 * the stamp — from a page, an import script or a hand edit — and the next request builds
 * a fresh Book. A stamp that moves with no real change (a WAL checkpoint) only costs a
 * rebuild; figures are never served from data older than the files.
 *
 * The cached Book is shared by every request, so it is deep-frozen: a report that tries
 * to change it throws instead of quietly changing what the next page sees.
 */

type Entry = { stamp: string; book: Promise<Book> };
type Store = { entry: Entry | null; reports: Map<string, Promise<string>>; watching: boolean };

// On globalThis: each route is bundled separately, and they must share one cache.
const g = globalThis as unknown as { __pfBookCache?: Store };
const state = (): Store => (g.__pfBookCache ??= { entry: null, reports: new Map(), watching: false });

const REPORT_LIMIT = 50;
const today = () => localToday();

function databaseFile(): string | null {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) return null;
  const p = url.slice("file:".length).split("?")[0]!;
  // Prisma resolves a relative SQLite path against the schema's folder.
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), "prisma", p);
}

const ENV_FILES = ["INTEGRITY_EXCEPTIONS_FILE", "TRANSFER_DECISIONS_FILE", "BONUS_AWARDS_FILE", "BONUS_REVIEWS_FILE", "MERCHANT_RULES_FILE", "ROW_DECISIONS_FILE", "HOUSEHOLD_FILE"];

function stat(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

/** Fingerprint of everything the Book and its reports read, plus the date (the Book is built "as of today"). */
export function dataStamp(): string {
  const parts = [today()];
  const db = databaseFile();
  if (db) parts.push(stat(db), stat(`${db}-wal`));
  const dir = dataDir();
  let json: string[] = [];
  try {
    // page-inputs.json holds calculator inputs and app-password.json the lock screen's
    // password; no figure reads either (lib/pageInputs.ts, lib/appPassword.ts), nor the
    // HSA receipts log (lib/hsa/store.ts: the HSA page joins it to the Book per request).
    json = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "page-inputs.json" && f !== "app-password.json" && f !== "hsa-expenses.json").sort().map((f) => path.join(dir, f));
  } catch {
    /* no data folder */
  }
  for (const k of ENV_FILES) if (process.env[k]) json.push(process.env[k]!);
  for (const f of json) parts.push(`${path.basename(f)}=${stat(f)}`);
  return parts.join("|");
}

export { deepFreeze };

/**
 * The Book for the data as it is now. Concurrent callers share one build; a failed build
 * isn't kept, so the next request tries again.
 */
export function getBook(db: Db, stamp = dataStamp()): Promise<Book> {
  const store = state();
  if (store.entry?.stamp === stamp) return store.entry.book;
  const book = loadBook(db).then((b) => deepFreeze(b));
  const entry: Entry = { stamp, book };
  store.entry = entry;
  store.reports.clear();
  book.catch(() => {
    if (store.entry === entry) store.entry = null;
  });
  return book;
}

/**
 * A report built from the Book, as JSON text, kept until the data changes. `key` names
 * the report and everything else it depends on (query parameters). Only for reads: the
 * build must not write.
 */
export function cachedReport(db: Db, key: string, build: (book: Book) => unknown): Promise<string> {
  const store = state();
  const stamp = dataStamp();
  const k = `${stamp}\n${key}`;
  const hit = store.reports.get(k);
  if (hit) {
    // Most recently used goes last, so the oldest is dropped first.
    store.reports.delete(k);
    store.reports.set(k, hit);
    return hit;
  }
  const body = getBook(db, stamp).then(async (book) => JSON.stringify(await build(book)));
  store.reports.set(k, body);
  body.catch(() => store.reports.delete(k));
  while (store.reports.size > REPORT_LIMIT) store.reports.delete(store.reports.keys().next().value!);
  return body;
}

/** A short tag for the data as it is (dataStamp): pages and proofs carry it, so the proof drawer can tell changed data from a bug. */
export const stampTag = (stamp = dataStamp()) => createHash("sha1").update(stamp).digest("hex").slice(0, 12);

/** A JSON response from text already serialized (cachedReport), tagged with the data it was built from (x-data-stamp). */
export function jsonBody(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json", "x-data-stamp": stampTag() } });
}

/**
 * Builds the Book now and again shortly after each change to the data, then asks this
 * server for `reports` (GET paths) so their cached answers are ready too: the page opened
 * after an import or an edit finds everything built. Waits for the stamp to hold still
 * for one poll first, so a burst of edits (a review queue) costs one rebuild, not one per
 * row. Runs once per process; returns a function that stops it.
 */
export function keepBookWarm(db: Db, opts: { reports?: string[]; everyMs?: number } = {}): () => void {
  const store = state();
  if (store.watching) return () => {};
  store.watching = true;
  const { reports = [], everyMs = 2000 } = opts;
  let seen = dataStamp();
  // The Book entry whose reports were last warmed. Tracked by entry, not stamp: data can
  // change and change back (same stamp) while a request built a Book in between.
  let warmed: Entry | null = null;
  let warming = false;

  const warm = async (stamp: string) => {
    warming = true;
    try {
      await getBook(db, stamp);
      const entry = store.entry;
      // Set by `next start`/`next dev` once the server listens; until then only the Book is built.
      const origin = process.env.__NEXT_PRIVATE_ORIGIN;
      if (!origin) return;
      const headers = process.env.API_SECRET ? { "x-api-secret": process.env.API_SECRET } : undefined;
      for (const p of reports) {
        if (dataStamp() !== stamp) return;
        await fetch(origin + p, { headers }).then((r) => r.arrayBuffer()).catch(() => {});
      }
      warmed = entry;
    } catch {
      /* the next request reports the error */
    } finally {
      warming = false;
    }
  };

  void warm(seen);
  const timer = setInterval(() => {
    const now = dataStamp();
    if (now !== seen) {
      seen = now;
      return;
    }
    if (!warming && (store.entry?.stamp !== now || warmed !== store.entry)) void warm(now);
  }, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    store.watching = false;
  };
}
