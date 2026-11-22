import type { Prisma, PrismaClient } from "@prisma/client";
import { cachedReport } from "../book/cache.ts";
import type { Book } from "../book/load.ts";
import { hsaLedger } from "../hsa/load.ts";
import { buildHsaReport } from "../hsa/report.ts";
import { readHsaFile } from "../hsa/store.ts";
import { medicalReportOf } from "./book.ts";
import type { MedicalReport } from "./report.ts";
import { refreshMedicalDocs } from "./scan.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/** A claim's entry in the HSA receipts log, as the HSA page ties them (lib/hsa/report.ts). */
export type ClaimInLog = { expenseId: string; reimbursed: boolean; over: boolean };

export type MedicalPage = MedicalReport & {
  /** The statements folder was found and scanned. */
  scanned: boolean;
  /** EOBs that couldn't be read, by file. */
  errors: { file: string; error: string }[];
  /** Entries of data/medical-plans.json that couldn't be used. */
  planProblems: { id: string; problem: string }[];
  /** Claims the HSA receipts log has an expense for, by claim id (read per request: the log isn't the Book's). */
  inHsaLog: Record<string, ClaimInLog>;
};

/** What the page shows from the Book: the report, the unreadable EOBs and plan entries. */
export function medicalFromBook(book: Book): Omit<MedicalPage, "scanned" | "inHsaLog"> {
  return {
    ...medicalReportOf(book),
    errors: Object.entries(book.medical?.docs?.files ?? {})
      .flatMap(([file, e]) => (e.error ? [{ file, error: e.error }] : []))
      .sort((a, b) => a.file.localeCompare(b.file)),
    planProblems: book.medical?.planProblems ?? [],
  };
}

/** The HSA log's expenses joined to the claims they're for, by claim id, exactly as the HSA page joins them. */
export const claimsInHsaLog = (book: Book) => inLog(hsaLedger(book), book.today);

/**
 * The Medical page as GET /api/medical serves it. The statements folder is scanned first:
 * a scan that reads a new EOB rewrites data/medical-documents.json, which moves the Book on,
 * so the report is always the Book's (lib/medical/book.ts). The HSA log is read per request,
 * beside it, as the HSA page reads it.
 */
export async function loadMedicalPage(db: Db, book?: Book): Promise<MedicalPage> {
  const docs = await refreshMedicalDocs(db);
  if (book) return { ...medicalFromBook(book), scanned: docs != null, inHsaLog: claimsInHsaLog(book) };
  const [page, inHsaLog] = await Promise.all([
    cachedReport(db, "medical-page", (b) => medicalFromBook(b)).then((s) => JSON.parse(s) as Omit<MedicalPage, "scanned" | "inHsaLog">),
    cachedReport(db, "medical-hsa-ledger", (b) => hsaLedger(b)).then((s) => JSON.parse(s) as ReturnType<typeof hsaLedger>),
  ]).then(([p, ledger]) => [p, inLog(ledger, p.today)] as const);
  return { ...page, scanned: docs != null, inHsaLog };
}

function inLog(ledger: ReturnType<typeof hsaLedger>, today: string): Record<string, ClaimInLog> {
  const file = readHsaFile();
  if (!file.expenses.length) return {};
  const r = buildHsaReport({ file, ...ledger, today, marginalRate: null });
  const out: Record<string, ClaimInLog> = {};
  for (const e of r.expenses) for (const c of e.eob?.claims ?? []) out[c.id] = { expenseId: e.id, reimbursed: !!e.reimbursement, over: e.flags.includes("OVER_EOB") };
  return out;
}
