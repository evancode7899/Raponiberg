import type { Book } from "../book/load.ts";
import { cashFlowContributions } from "../book/reports/cashFlow.ts";
import { buildHomeSpending } from "../book/reports/homeFunds.ts";
import { provenMonths } from "../book/reports/spending.ts";
import type { HomeBudgetInputs } from "../home-budget/homeBudgetModel.ts";
import type { FinancialProfileSettings } from "../profile/settings.ts";
import type { ScenarioFacts } from "./engine.ts";
import { DEFAULT_BUY, type BuyHome } from "./types.ts";

/**
 * What the scenarios read from the Book beyond the forecast: the childcare the household
 * pays now (the cost a child in care adds) and its housing & utilities (what buying a home
 * replaces), both over the same latest proven months Goals and the forecast's living cost use.
 */

/** Payees that are childcare: daycares, preschools, nannies, au pairs, sitters. */
export const CHILDCARE_PAYEE = /\b(day ?care|child ?care|pre-?school|nanny|nannies|au ?pair|babysit|montessori|early (learning|education))/i;

export function scenarioFacts(book: Book, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, asOf: string): ScenarioFacts {
  const window = provenMonths(book).window;
  let childcare: ScenarioFacts["childcare"] = null;
  if (window.length) {
    let cents = 0;
    const rows = new Set<string>();
    for (const { row, cents: c } of cashFlowContributions(book, window.map(({ start, end }) => ({ start, end })), null)) {
      if (row.lane !== "EXPENSE" || !CHILDCARE_PAYEE.test(row.payee)) continue;
      cents -= c;
      rows.add(row.id);
    }
    if (cents > 0) childcare = { annual: Math.round((cents / window.length) * 12), months: window.length, rows: rows.size };
  }
  const h = buildHomeSpending(book, settings);
  return { asOf, childcare, housing: h && h.housingMonthlyCents > 0 ? { monthly: h.housingMonthlyCents, months: h.months } : null };
}

/** A purchase's starting figures from the Home budget page's saved inputs (dollars there), else the defaults. */
export function buyDefaults(saved: Partial<HomeBudgetInputs> | null): Omit<BuyHome, "at"> {
  const d = DEFAULT_BUY;
  const n = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  const s = saved ?? {};
  const price = n(s.budgetHomePrice, 1, 1e9);
  const insRate = n(s.annualInsuranceRateOnValue, 0, 0.1);
  return {
    price: price != null ? Math.round(price * 100) : d.price,
    downPct: n(s.budgetDownPaymentPct, 0, 1) ?? d.downPct,
    rate: n(s.annualMortgageRate, 0, 0.3) ?? d.rate,
    termYears: Math.round(n(s.mortgageTermYears, 1, 50) ?? d.termYears),
    taxRate: n(s.annualPropertyTaxRate, 0, 0.1) ?? d.taxRate,
    upkeepRate: n(s.annualMaintenanceRate, 0, 0.1) ?? d.upkeepRate,
    insurance: insRate != null && price != null ? Math.round(price * insRate * 100) : d.insurance,
    hoa: Math.round((n(s.hoaMonthly, 0, 1e6) ?? d.hoa / 100) * 100),
    utilities: Math.round((n(s.utilitiesMonthly, 0, 1e6) ?? d.utilities / 100) * 100),
    closingPct: n(s.closingCostsPctOfHomePrice, 0, 0.2) ?? d.closingPct,
    appreciation: n(s.homeAppreciationRate, -0.2, 0.3) ?? d.appreciation,
  };
}
