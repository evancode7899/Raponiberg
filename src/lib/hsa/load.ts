import type { Book } from "../book/load.ts";
import { personPayYear } from "../book/pay.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import { daysBetween } from "../dates/isoDate.ts";
import { w2FromAmounts } from "../tax/facts/payroll.ts";
import type { TaxForecastLink } from "../forecast/forecast.ts";
import { buildTaxReport } from "../tax/buildTaxReport.ts";
import { TAX_YEARS, taxYearParams, type FederalParams } from "../tax/params.ts";
import { payrollTaxSaved, type HsaAccountIn, type LedgerAccountIn, type LedgerRowIn, type PayrollHsaIn, type TaxMarginalIn } from "./report.ts";

/** What the HSA page needs from the Book; cached with it (it changes only when the Book does). */
export type HsaLedger = { rows: LedgerRowIn[]; accounts: LedgerAccountIn[]; hsaAccounts: HsaAccountIn[]; payrollHsa: PayrollHsaIn | null; persons: string[] };

/**
 * The Taxes page's marginal rates for one more dollar of the top earner's wages: income
 * tax (federal, which already holds the Additional Medicare surtax, + Connecticut + New
 * York) and Social Security + Medicare. This year's, else last year's when this year's
 * figures aren't proven yet.
 */
export function hsaTaxMarginal(book: Book, year: number, forecast: TaxForecastLink | null, birthYears: Record<string, number>): TaxMarginalIn | null {
  for (const [y, source] of [[year, "TAX_REPORT"], [year - 1, "PRIOR_YEAR"]] as const) {
    if (!TAX_YEARS[y]) continue;
    const t = buildTaxReport(book, y, { forecast: y === year ? forecast : null, birthYears });
    if (!t.blocked) return { year: y, incomeRate: t.marginal.federal + t.marginal.ct + t.marginal.ny, payrollRate: t.marginal.payroll, source };
  }
  return null;
}

/**
 * The latest year any pay stub shows HSA money: everyone's employee and employer amounts
 * (year-to-date on each year's last stub), and the payroll tax a contributed dollar avoids.
 * A year still in progress has its wages run out to a full year at the pace so far, to
 * tell whether the contributor ends it over the Social Security wage base.
 */
function latestPayrollHsa(book: Book): PayrollHsaIn | null {
  const lastPay = book.stubs.reduce((m, s) => (s.payDate > m ? s.payDate : m), "");
  const years = [...new Set(book.stubs.map((s) => Number(s.payDate.slice(0, 4))))].sort((a, b) => b - a);
  for (const year of years) {
    let fp: FederalParams | null = null;
    try {
      fp = taxYearParams(year).federal;
    } catch {
      fp = null;
    }
    const inProgress = lastPay.startsWith(`${year}-`) && !lastPay.startsWith(`${year}-12`);
    const pace = inProgress ? 365 / (daysBetween(`${year}-01-01`, lastPay) + 1) : 1;
    let employeeCents = 0;
    let employerCents = 0;
    let householdWagesCents = 0;
    const contributors: { wagesCents: number; hsaCents: number }[] = [];
    for (const p of book.taxProfile.persons) {
      let wagesCents = 0;
      let hsaCents = 0;
      for (const e of personPayYear(book, p.id, year).employers) {
        employeeCents += e.ytd.hsa;
        employerCents += e.ytd.employerHsa;
        hsaCents += e.ytd.hsa;
        if (fp) wagesCents += w2FromAmounts(e.employer, e.ytd, fp).box5MedicareWages;
      }
      wagesCents = Math.round(wagesCents * pace);
      householdWagesCents += wagesCents;
      if (hsaCents > 0) contributors.push({ wagesCents, hsaCents });
    }
    if (employeeCents + employerCents <= 0) continue;
    // Married filing jointly when the household is two earners; the surtax threshold is joint then.
    const status = book.taxProfile.persons.length >= 2 ? "MFJ" : "SINGLE";
    const payrollRate =
      fp && contributors.length
        ? contributors.reduce(
            (s, c) =>
              s +
              (c.hsaCents / employeeCents) *
                payrollTaxSaved({
                  personWagesCents: c.wagesCents,
                  householdWagesCents,
                  wageBaseCents: fp.socialSecurity.wageBase,
                  ssRate: fp.socialSecurity.rate,
                  medicareRate: fp.medicareRate,
                  additionalMedicareRate: fp.additionalMedicareRate,
                  surtaxThresholdCents: fp.surtaxThreshold[status],
                }),
            0,
          )
        : null;
    const surtaxRate = fp && householdWagesCents > fp.surtaxThreshold[status] ? fp.additionalMedicareRate : 0;
    return { year, employeeCents, employerCents, payrollRate, surtaxRate };
  }
  return null;
}

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
    payrollHsa: latestPayrollHsa(book),
    persons: [...book.taxProfile.persons.map((p) => p.name), ...book.taxProfile.dependents.map((d) => d.name)].filter((n) => n && n !== "Me"),
  };
}
