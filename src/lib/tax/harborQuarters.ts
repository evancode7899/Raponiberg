import { estimateInstallments } from "../dates/taxDates.ts";
import type { SafeHarbor } from "./computeReturn.ts";
import type { TaxAuthority, TaxPaymentRow } from "./facts/payments.ts";

/**
 * The safe harbor quarter by quarter, by the law's regular method (IRC §6654(d)(1),
 * C.G.S. §12-722, New York Tax Law §685(c); the same rule installmentsDue plans the dates
 * left by): by the year's k-th due date, k quarters of the required annual payment must be
 * in. Withholding counts in four equal parts whatever day it was withheld (§6654(g)), so the
 * year's projected withholding counts a quarter at each date; estimated payments count from
 * the day the bank ledger shows them. A year under the de-minimis line owes nothing by any date.
 */
export type HarborQuarter = {
  quarter: 1 | 2 | 3 | 4;
  date: string;
  /** Whether the date has passed (on or before today). */
  past: boolean;
  /** k quarters of the required annual payment. */
  requiredCents: number;
  /** k quarters of the year's withholding. */
  withheldCents: number;
  /** Estimated payments for the year on file by the date. */
  estimatesCents: number;
  /** Short of the required amount by then (0 when on track). */
  shortCents: number;
};

export function harborQuarters(sh: Pick<SafeHarbor, "requiredAnnualPayment" | "withholding" | "underDeMinimis">, year: number, payments: readonly TaxPaymentRow[], authority: TaxAuthority, today: string): HarborQuarter[] {
  const estimates = payments.filter((p) => p.authority === authority && p.attribution.taxYear === year && p.attribution.kind === "ESTIMATE");
  return estimateInstallments(year).map(({ quarter, date }) => {
    const requiredCents = sh.underDeMinimis ? 0 : Math.round((sh.requiredAnnualPayment * quarter) / 4);
    const withheldCents = Math.round((sh.withholding * quarter) / 4);
    const estimatesCents = estimates.filter((p) => p.date <= date).reduce((s, p) => s + p.amount, 0);
    return { quarter, date, past: date <= today, requiredCents, withheldCents, estimatesCents, shortCents: Math.max(0, requiredCents - withheldCents - estimatesCents) };
  });
}
