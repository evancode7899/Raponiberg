import type { Book } from "../book/load.ts";
import { personPayYear } from "../book/pay.ts";
import { blockersFor, netWorthAtBlockers } from "../book/blockers.ts";
import { refs, type BlockerRef } from "../book/reports/blockerRef.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import { accountIdForNumber, investmentIncomeByAccount } from "../book/investments.ts";
import { homeForecast, type Forecast } from "../forecast/forecast.ts";
import { gainsTaxRate } from "../home-budget/homeTax.ts";
import { valueAt } from "../ledger/timeline.ts";
import type { OutlookSeeds } from "../profile/basePay.ts";
import { w2FromAmounts } from "../tax/facts/payroll.ts";
import type { TaxForecastLink } from "../forecast/forecast.ts";
import { buildTaxReport } from "../tax/buildTaxReport.ts";
import { TAX_YEARS, taxYearParams, type FederalParams } from "../tax/params.ts";
import { payrollTaxSaved, type HsaAccountIn, type LedgerAccountIn, type LedgerRowIn, type PayrollHsaIn, type TaxMarginalIn } from "./report.ts";

/** What the HSA page needs from the Book; cached with it (it changes only when the Book does). */
export type HsaLedger = {
  rows: LedgerRowIn[];
  accounts: LedgerAccountIn[];
  hsaAccounts: HsaAccountIn[];
  payrollHsa: PayrollHsaIn | null;
  persons: string[];
  /** The day the HSA opened, from its first statement when that one opens at $0 (null: the statements don't reach back to it). */
  openedOn: string | null;
  /** What withholds the balance, and the rows the receipts are matched to (report.ts ReportInput.blockers). */
  blockers: { balance: BlockerRef[]; rows: BlockerRef[] };
};

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
 * For a year still in progress the payroll rate is left to the tax engine, which runs the
 * year out on the shared forecast (report.ts takes the Taxes page's payroll rate then):
 * whether the contributor ends it over the Social Security wage base is a projection,
 * and the app has one.
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
      householdWagesCents += wagesCents;
      if (hsaCents > 0) contributors.push({ wagesCents, hsaCents });
    }
    if (employeeCents + employerCents <= 0) continue;
    // Married filing jointly when the household is two earners; the surtax threshold is joint then.
    const status = book.taxProfile.persons.length >= 2 ? "MFJ" : "SINGLE";
    const payrollRate =
      fp && contributors.length && !inProgress
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
  const hsaIds = nw.accounts.filter((a) => a.group === "Health savings").map((a) => a.id);
  const opened = book.ledger.accounts.filter((a) => hsaIds.includes(a.id)).map((a) => a.timeline.firstDay!).sort()[0];
  const blockers = {
    balance: hsaIds.length ? refs(netWorthAtBlockers(book, nw.provenThrough, hsaIds)) : [],
    rows: opened && opened <= book.horizon.cashFlow ? refs(blockersFor(book, { affects: "CASH_FLOW", from: opened, to: book.horizon.cashFlow })) : [],
  };
  const first = book.ledger.accounts.filter((a) => hsaIds.includes(a.id)).sort((x, y) => (x.timeline.firstDay! < y.timeline.firstDay! ? -1 : 1))[0];
  const openedOn = first && first.timeline.segments[0]?.opening === 0 ? first.timeline.firstDay : null;
  return {
    openedOn,
    blockers,
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

/**
 * The shared figures the HSA strategy's rates default to: the forecast's return (what the
 * whole app assumes money earns), the dividend yield the taxable brokerage statements
 * show for the last full year (year-to-date dividends ÷ year-end value), and the tax
 * engine's rate on a long-term gain at the household's forecast salary. Null where the
 * figure can't be had.
 */
export function hsaLinkedRates(book: Book, forecast: Forecast | null, seeds: OutlookSeeds | null): { returnRate: number | null; dividendYield: number | null; taxableRate: number | null } {
  const year = Number(book.today.slice(0, 4)) - 1;
  let dividends = 0;
  let value = 0;
  for (const v of investmentIncomeByAccount(book, year).values()) {
    if (v.kind !== "TAXABLE") continue;
    const id = accountIdForNumber(book, v.accountNumber);
    const a = id ? book.ledger.accounts.find((x) => x.id === id) : null;
    const b = book.brokerage.filter((x) => x.accountNumber === v.accountNumber && x.periodEnd.startsWith(String(year)) && x.income).sort((x, y) => x.periodEnd.localeCompare(y.periodEnd)).at(-1);
    if (!a || !b?.income) continue;
    const end = valueAt(a.timeline, `${year}-12-31`).cents;
    if (end <= 0) continue;
    dividends += b.income.dividends;
    value += end;
  }
  const hf = forecast && seeds ? homeForecast(forecast, seeds) : null;
  const salary = hf?.salary[Number(book.today.slice(0, 4))] ?? null;
  return {
    returnRate: forecast?.assumptions.returnRate ?? null,
    dividendYield: value > 0 ? dividends / value : null,
    taxableRate: hf && salary ? gainsTaxRate(hf.tax, salary / 100, 10_000) : null,
  };
}
