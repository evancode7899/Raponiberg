import type { Book } from "../book/load.ts";
import { amountsFromLines } from "../ingest/payroll/index.ts";
import { ownerFiled, qualifyPayee } from "../hsa/qualify.ts";
import { withdrawalKind } from "../hsa/report.ts";
import { matchClaimPayments, premiumLines, type ClaimLite, type HsaEobIn, type PaymentRowIn } from "./links.ts";
import { buildMedicalReport, type MedicalReport } from "./report.ts";
import type { EobStatement, PendingEob, PlanDocument } from "./types.ts";

/**
 * The Medical report from the Book's one copy of the EOBs and plans (Book.medical), joined
 * to the Book's rows (what paid each claim) and pay stubs (premiums, HSA money from pay).
 * Built once per Book: the Medical page, the HSA page, Account limits and the medical.*
 * checks all read this.
 */

const memo = new WeakMap<object, MedicalReport>();

/** The rows that could have paid a provider: card and bank spending, and the HSA paying one directly. */
export function paymentRows(book: Pick<Book, "rows" | "accounts">): PaymentRowIn[] {
  const accounts = new Map(book.accounts.map((a) => [a.id, a]));
  return book.rows.flatMap((r) => {
    if (r.amountCents >= 0) return [];
    const a = accounts.get(r.accountId);
    const hsa = a?.group === "Health savings";
    if (hsa ? withdrawalKind(r) !== "DIRECT" : r.lane !== "EXPENSE") return [];
    const medical = !hsa && qualifyPayee(r.payee, r.detail, { category: r.category, byOwner: ownerFiled(r.classifiedBy) }) != null;
    return [{ id: r.id, date: r.date, amountCents: r.amountCents, payee: r.payee, account: a?.name ?? "", fromHsa: hsa, medical }];
  });
}

/** The EOBs, waiting EOBs and plan documents on file, by file. */
export function medicalDocs(book: Pick<Book, "medical">) {
  const statements: { file: string; statement: EobStatement }[] = [];
  const pending: { file: string; doc: PendingEob }[] = [];
  const planDocs: { file: string; doc: PlanDocument }[] = [];
  for (const [file, e] of Object.entries(book.medical?.docs?.files ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (e.doc?.kind === "EOB") statements.push({ file, statement: e.doc });
    else if (e.doc?.kind === "PENDING") pending.push({ file, doc: e.doc });
    else if (e.doc?.kind === "PLAN_DOC") planDocs.push({ file, doc: e.doc });
  }
  return { statements, pending, planDocs };
}

export function medicalReportOf(book: Book): MedicalReport {
  const hit = memo.get(book);
  if (hit) return hit;
  const { statements, pending, planDocs } = medicalDocs(book);
  const plans = book.medical?.plans ?? [];
  // Claims first without payments, to know what to match; then the report with them.
  const bare = buildMedicalReport({ statements, pending, planDocs, plans, today: book.today });
  const { byClaim } = matchClaimPayments(bare.claims.map(claimLite), statements.length ? paymentRows(book) : []);
  const report = buildMedicalReport({
    statements,
    pending,
    planDocs,
    plans,
    today: book.today,
    payments: byClaim,
    premiums: premiumLines(book.stubs),
    hsaPay: book.stubs.map((s) => {
      const a = amountsFromLines(s.lines, "current");
      return { payDate: s.payDate, employer: s.employer, cents: a.hsa + a.employerHsa };
    }),
  });
  memo.set(book, report);
  return report;
}

export const claimLite = (c: MedicalReport["claims"][number]): ClaimLite => ({
  id: c.id,
  coverage: c.coverage,
  patient: c.patient,
  provider: c.provider,
  firstDate: c.firstDate,
  lastDate: c.lastDate,
  statementDate: c.statementDate,
  file: c.file,
  yourShareCents: c.yourShareCents,
  planCents: c.planCents,
});

export function hsaEob(book: Book): HsaEobIn {
  const r = medicalReportOf(book);
  const payments = [...new Map(r.claims.flatMap((c) => (c.payment ? [[c.payment.rowId, c.payment] as const] : []))).values()];
  return { claims: r.claims.map(claimLite), payments };
}
