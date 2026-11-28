import type { Prisma, PrismaClient } from "@prisma/client";
import { cachedReport } from "../book/cache.ts";
import type { Book } from "../book/load.ts";
import { loadJsonSetting } from "../settingsStore.ts";
import { buildCoverReport, type CoverReport } from "./cover.ts";
import { INSURANCE_NOTES_KEY, normalizeInsuranceNotes, type InsuranceNotes } from "./notes.ts";
import { buildInsuranceReport, type InsuranceReport, type PremiumRow } from "./report.ts";
import { refreshInsuranceDocs } from "./scan.ts";
import { docsByKind } from "./docs.ts";
import { readInsuranceDocs } from "./store.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type InsurancePage = InsuranceReport &
  CoverReport & {
    /** The last day the statements are complete through (Book.horizon): the Overview's year of premiums ends here. */
    through: string;
    notes: InsuranceNotes;
    /** Account names by id, to say which card or bank paid a premium. */
    accounts: Record<string, string>;
    /** The statements folder was found and scanned. */
    scanned: boolean;
    /** Insurance documents that couldn't be read, by file. */
    errors: { file: string; error: string }[];
  };

/**
 * The Insurance page as GET /api/insurance serves it: the folder's insurance documents
 * (read fresh: they aren't in the Book) joined to the statement rows that could be
 * premiums, taken from the cached Book.
 */
type Ledger = { today: string; through: string; rows: PremiumRow[]; accounts: Record<string, string> };
/** The statement rows that could be premiums, and account names. */
const ledgerOf = (book: Book): Ledger => ({
  today: book.today,
  through: book.horizon.cashFlow,
  // Every charge: which of them are premiums is the report's call (lib/insurance/report.ts, cover.ts).
  rows: book.rows.filter((r) => r.amountCents < 0 && !r.pending).map((r): PremiumRow => ({ id: r.id, date: r.date, amountCents: r.amountCents, payee: r.payee, accountId: r.accountId })),
  accounts: Object.fromEntries(book.accounts.map((a) => [a.id, a.name])),
});

export async function loadInsurancePage(db: Db, book?: Book, opts: { /** False: the folder as last scanned (the Dashboard never scans it). */ scan?: boolean } = {}): Promise<InsurancePage> {
  const [docs, notes, ledger] = await Promise.all([
    // No folder to scan (the demo, or before one is set): the last scan, as it was.
    opts.scan === false ? readInsuranceDocs() : refreshInsuranceDocs(db).then((d) => d ?? readInsuranceDocs()),
    loadJsonSetting(db, INSURANCE_NOTES_KEY, normalizeInsuranceNotes),
    // The sweep passes its own Book; the route reads the cached one (through JSON either way).
    (book ? Promise.resolve(JSON.stringify(ledgerOf(book))) : cachedReport(db, "insurance-rows", ledgerOf)).then((t) => JSON.parse(t) as Ledger),
  ]);
  const entries = Object.entries(docs?.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const { policies, bills, receipts, statuses, homes, autos, renewals, forms } = docsByKind(docs);
  // The same packet saved twice is one policy: the first file wins.
  const unique = policies.filter((p, i) => policies.findIndex((q) => q.policy.policyNumber === p.policy.policyNumber) === i);
  // Life matching runs first; home and auto read only rows to their own insurers, which life insurers' payees never match.
  return {
    ...buildInsuranceReport({ policies: unique, bills, receipts, statuses, rows: ledger.rows, today: ledger.today }),
    ...buildCoverReport({ homes, autos, renewals, forms, rows: ledger.rows, today: ledger.today }),
    through: ledger.through,
    notes,
    accounts: ledger.accounts,
    scanned: docs != null,
    errors: entries.flatMap(([file, e]) => (e.error ? [{ file, error: e.error }] : [])),
  };
}

