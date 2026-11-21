import type { Prisma, PrismaClient } from "@prisma/client";
import { cachedReport } from "../book/cache.ts";
import type { Book } from "../book/load.ts";
import { readHealthPlans } from "./plans.ts";
import { buildMedicalReport, type MedicalReport } from "./report.ts";
import { refreshMedicalDocs } from "./scan.ts";
import type { EobStatement, PendingEob, PlanDocument } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type MedicalPage = MedicalReport & {
  /** The statements folder was found and scanned. */
  scanned: boolean;
  /** EOBs that couldn't be read, by file. */
  errors: { file: string; error: string }[];
  /** Entries of data/medical-plans.json that couldn't be used. */
  planProblems: { id: string; problem: string }[];
};

/**
 * The Medical page as GET /api/medical serves it: the folder's EOBs (read fresh: they
 * aren't in the Book) and the plans on file. Only the Book's today is read, so the
 * current year and the 12-month limits end where every other page does.
 */
export async function loadMedicalPage(db: Db, book?: Book): Promise<MedicalPage> {
  const [docs, today] = await Promise.all([
    refreshMedicalDocs(db),
    book ? Promise.resolve(book.today) : cachedReport(db, "medical-today", (b) => b.today).then((s) => JSON.parse(s) as string),
  ]);
  const { plans, problems } = readHealthPlans();
  const entries = Object.entries(docs?.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const statements: { file: string; statement: EobStatement }[] = [];
  const pending: { file: string; doc: PendingEob }[] = [];
  const planDocs: { file: string; doc: PlanDocument }[] = [];
  for (const [file, e] of entries) {
    if (e.doc?.kind === "EOB") statements.push({ file, statement: e.doc });
    else if (e.doc?.kind === "PENDING") pending.push({ file, doc: e.doc });
    else if (e.doc?.kind === "PLAN_DOC") planDocs.push({ file, doc: e.doc });
  }
  return {
    ...buildMedicalReport({ statements, pending, planDocs, plans, today }),
    scanned: docs != null,
    errors: entries.flatMap(([file, e]) => (e.error ? [{ file, error: e.error }] : [])),
    planProblems: problems,
  };
}
