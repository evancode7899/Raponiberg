import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { resolveSqliteDatabaseFilePath } from "../sqliteDbPath.ts";
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
/** A report's JSON text and the data stamp (dataStamp) of the Book it was built from. */
export type Built = { body: string; stamp: string };
type Store = { entry: Entry | null; reports: Map<string, Promise<Built>>; watching: boolean };

// On globalThis: each route is bundled separately, and they must share one cache.
const g = globalThis as unknown as { __pfBookCache?: Store };
const state = (): Store => (g.__pfBookCache ??= { entry: null, reports: new Map(), watching: false });

const REPORT_LIMIT = 50;
const today = () => localToday();

/** The database file, read off DATABASE_URL the way the rest of the app reads it (sqliteDbPath.ts). */
const databaseFile = resolveSqliteDatabaseFilePath;

/**
 * Every data file a figure reads that its env variable can point outside the data folder
 * (each is in the stamp wherever it lives). UNSTAMPED_ENV_FILES are the ones no figure reads
 * (read per request beside the Book); a test holds every `*_FILE` variable the code reads to
 * one list or the other.
 */
export const ENV_FILES = [
  "INTEGRITY_EXCEPTIONS_FILE",
  "TRANSFER_DECISIONS_FILE",
  "BONUS_AWARDS_FILE",
  "BONUS_REVIEWS_FILE",
  "MERCHANT_RULES_FILE",
  "ROW_DECISIONS_FILE",
  "HOUSEHOLD_FILE",
  "REIMBURSEMENT_LINKS_FILE",
  "TAX_DOCUMENTS_FILE",
  "CLOSED_ACCOUNTS_FILE",
  "FUND_DOCUMENTS_FILE",
];
export const UNSTAMPED_ENV_FILES = ["PAGE_INPUTS_FILE", "APP_PASSWORD_FILE", "HSA_EXPENSES_FILE", "HSA_RECEIPTS_FILE", "INSURANCE_DOCUMENTS_FILE", "CARD_REWARDS_FILE"];

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
  // No database file to watch would serve one Book forever: refuse instead.
  if (!db) throw new Error("DATABASE_URL isn't a SQLite file: the Book can't tell when the data changes.");
  parts.push(stat(db), stat(`${db}-wal`));
  const dir = dataDir();
  let json: string[] = [];
  try {
    // page-inputs.json holds calculator inputs and app-password.json the lock screen's
    // password; no figure reads either (lib/pageInputs.ts, lib/appPassword.ts), nor the
    // HSA receipts log (lib/hsa/store.ts: the HSA page joins it to the Book per request),
    // nor the insurance documents read from the folder (lib/insurance/store.ts, same), nor
    // the rewards read from card statements (lib/cardPerks/rewardsScan.ts, same).
    const unread = new Set(["page-inputs.json", "app-password.json", "hsa-expenses.json", "insurance-documents.json", "card-rewards.json"]);
    json = readdirSync(dir).filter((f) => f.endsWith(".json") && !unread.has(f)).sort().map((f) => path.join(dir, f));
  } catch (e) {
    // No data folder yet holds no files; any other failure would leave every file out of the stamp.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
  const book = buildSettled(db, stamp).then((b) => deepFreeze(b));
  const entry: Entry = { stamp, book };
  store.entry = entry;
  store.reports.clear();
  book.catch(() => {
    if (store.entry === entry) store.entry = null;
  });
  return book;
}

/**
 * Builds the Book, again if the data changed while it was being read (an import landing
 * mid-build): the reads aren't one snapshot, so such a Book could mix the data before and
 * after. Gives up after a few tries and keeps the last, which the next request (on the new
 * stamp) replaces anyway.
 */
async function buildSettled(db: Db, stamp: string): Promise<Book> {
  let seen = stamp;
  for (let i = 0; ; i++) {
    const book = await loadBook(db);
    const now = dataStamp();
    if (now === seen || i >= 2) return book;
    seen = now;
  }
}

/**
 * A report built from the Book, as JSON text, kept until the data changes. `key` names
 * the report and everything else it depends on (query parameters). Only for reads: the
 * build must not write.
 */
export function cachedReport(db: Db, key: string, build: (book: Book) => unknown): Promise<string> {
  return cachedBuilt(db, key, build).then((b) => b.body);
}

/**
 * cachedReport, with the stamp of the data it was built from: jsonBody tags the response
 * with that stamp, never the stamp at the moment it's sent (the data can change in between,
 * and a page must know which data the figures it shows describe).
 */
export function cachedBuilt(db: Db, key: string, build: (book: Book) => unknown): Promise<Built> {
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
  const body = getBook(db, stamp).then(async (book): Promise<Built> => ({ body: JSON.stringify(await build(book)), stamp }));
  store.reports.set(k, body);
  body.catch(() => store.reports.delete(k));
  while (store.reports.size > REPORT_LIMIT) store.reports.delete(store.reports.keys().next().value!);
  return body;
}

/** A short tag for the data as it is (dataStamp): pages and proofs carry it, so the proof drawer can tell changed data from a bug. */
export const stampTag = (stamp = dataStamp()) => createHash("sha256").update(stamp).digest("hex").slice(0, 12);

/**
 * A JSON response from a report already serialized (cachedBuilt), tagged with the data it was
 * built from (x-data-stamp). Plain text has no stamp of its own: it's tagged with `stamp` when
 * given (the sweep's), else as of now.
 */
export function jsonBody(body: Built | string, stamp?: string): Response {
  const b = typeof body === "string" ? { body, stamp: stamp ?? dataStamp() } : body;
  return new Response(b.body, { headers: { "content-type": "application/json", "x-data-stamp": stampTag(b.stamp) } });
}

/**
 * Builds the Book now and again shortly after each change to the data, then asks this
 * server for `reports` (GET paths) so their cached answers are ready too: the page opened
 * after an import or an edit finds everything built. Waits for the stamp to hold still
 * for one poll first, so a burst of edits (a review queue) costs one rebuild, not one per
 * row. `then` runs once they're ready, without being waited for (the proof sweep, which
 * works in its own process). Runs once per process; returns a function that stops it.
 */
export function keepBookWarm(db: Db, opts: { reports?: string[]; then?: () => void; everyMs?: number } = {}): () => void {
  const store = state();
  if (store.watching) return () => {};
  store.watching = true;
  const { reports = [], then, everyMs = 2000 } = opts;
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
      if (dataStamp() === stamp) then?.();
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
