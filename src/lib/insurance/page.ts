import type { Prisma, PrismaClient } from "@prisma/client";
import { cachedReport } from "../book/cache.ts";
import type { Book } from "../book/load.ts";
import { loadJsonSetting } from "../settingsStore.ts";
import { INSURANCE_NOTES_KEY, normalizeInsuranceNotes, type InsuranceNotes } from "./notes.ts";
import { buildInsuranceReport, type InsuranceReport, type PremiumRow } from "./report.ts";
import { refreshInsuranceDocs } from "./scan.ts";
import type { BillingNotice, PaymentReceipt, PolicyStatus, TermPolicy } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type InsurancePage = InsuranceReport & {
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
/** The statement rows that could be premiums, and account names. */
const ledgerOf = (book: Book) => ({
  today: book.today,
  // Every charge: which of them are premiums is the report's call (lib/insurance/report.ts).
  rows: book.rows.filter((r) => r.amountCents < 0 && !r.pending).map((r): PremiumRow => ({ id: r.id, date: r.date, amountCents: r.amountCents, payee: r.payee, accountId: r.accountId })),
  accounts: Object.fromEntries(book.accounts.map((a) => [a.id, a.name])),
});

export async function loadInsurancePage(db: Db, book?: Book): Promise<InsurancePage> {
  const [docs, notes, ledger] = await Promise.all([
    refreshInsuranceDocs(db),
    loadJsonSetting(db, INSURANCE_NOTES_KEY, normalizeInsuranceNotes),
    // The sweep passes its own Book; the route reads the cached one (through JSON either way).
    (book ? Promise.resolve(JSON.stringify(ledgerOf(book))) : cachedReport(db, "insurance-rows", ledgerOf)).then((t) => JSON.parse(t) as { today: string; rows: PremiumRow[]; accounts: Record<string, string> }),
  ]);
  const entries = Object.entries(docs?.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const policies: { file: string; policy: TermPolicy }[] = [];
  const bills: { file: string; bill: BillingNotice }[] = [];
  const receipts: { file: string; receipt: PaymentReceipt }[] = [];
  const statuses: { file: string; status: PolicyStatus }[] = [];
  for (const [file, e] of entries) {
    if (e.doc?.kind === "TERM_LIFE") policies.push({ file, policy: e.doc });
    else if (e.doc?.kind === "BILL") bills.push({ file, bill: e.doc });
    else if (e.doc?.kind === "RECEIPT") receipts.push({ file, receipt: e.doc });
    else if (e.doc?.kind === "STATUS") statuses.push({ file, status: e.doc });
  }
  // The same packet saved twice is one policy: the first file wins.
  const unique = policies.filter((p, i) => policies.findIndex((q) => q.policy.policyNumber === p.policy.policyNumber) === i);
  return {
    ...buildInsuranceReport({ policies: unique, bills, receipts, statuses, rows: ledger.rows, today: ledger.today }),
    notes,
    accounts: ledger.accounts,
    scanned: docs != null,
    errors: entries.flatMap(([file, e]) => (e.error ? [{ file, error: e.error }] : [])),
  };
}
