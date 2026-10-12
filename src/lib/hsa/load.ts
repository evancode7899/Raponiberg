import type { Book } from "../book/load.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import type { HsaAccountIn, LedgerAccountIn, LedgerRowIn } from "./report.ts";

/** What the HSA page needs from the Book; cached with it (it changes only when the Book does). */
export type HsaLedger = { rows: LedgerRowIn[]; accounts: LedgerAccountIn[]; hsaAccounts: HsaAccountIn[]; persons: string[] };

export function hsaLedger(book: Book): HsaLedger {
  const nw = buildNetWorth(book, { granularity: "year" });
  const returns = new Map(nw.proven.returns.byAccount.map((r) => [r.accountId, r.annualized]));
  return {
    rows: book.rows.map((r) => ({
      id: r.id,
      date: r.date,
      amountCents: r.amountCents,
      lane: r.lane,
      accountId: r.accountId,
      payee: r.payee,
      detail: r.detail ?? null,
      merchantKey: r.merchantKey,
      category: r.category,
      classifiedBy: r.classifiedBy,
    })),
    accounts: book.accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, group: a.group, identifiers: a.identifiers })),
    hsaAccounts: nw.accounts
      .filter((a) => a.group === "Health savings" && !a.closed)
      .map((a) => ({ name: a.name, balanceCents: a.currentCents, asOf: a.currentAsOf, annualizedReturn: returns.get(a.id) ?? null })),
    persons: [...book.taxProfile.persons.map((p) => p.name), ...book.taxProfile.dependents.map((d) => d.name)].filter((n) => n && n !== "Me"),
  };
}
