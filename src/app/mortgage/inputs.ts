import type { SliderSpec } from "@/app/home-budget/RangeSlider";
import { fetchSavedInputs } from "@/components/ui/kit";
import { defaultHomeBudgetInputs, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import { calendarToLoanPaymentMonth, type Lump, type MortgagePlan } from "@/lib/mortgage/prepayVsInvest";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type LumpRow = {
  id: string;
  label: string;
  month: number;
  year: number;
  amount: number;
  /** Repeats every year in the same month through `untilYear` (a bonus, an RSU vest). */
  repeat: boolean;
  untilYear: number;
};

export type MortgageInputs = {
  principal: number;
  rate: number;
  termYears: number;
  startMonth: number;
  startYear: number;
  extraMonthly: number;
  lumps: LumpRow[];
  horizonYears: number;
  investReturn: number;
  volatility: number;
  dividendYield: number;
  investTaxRate: number;
  account: "taxable" | "taxFree";
  sellAtHorizon: boolean;
  deductInterest: boolean;
  marginalRate: number;
  standardDeduction: number;
  otherItemized: number;
  otherItemizedFrom2030: number;
  debtCap: number;
  inflation: number;
  realDollars: boolean;
};

export const STORAGE_KEY = "pf-mortgage-v2";

/**
 * Defaults: a 30-year loan at today's rates, a broad stock index (7% long-run, 16%
 * volatility, 1.5% dividends) in a taxable account at 15% LTCG + 3.8% NIIT, and 2026
 * federal rules (standard deduction $32,200 joint, SALT cap $40k through 2029 then $10k,
 * $750k acquisition-debt cap).
 */
export const defaultInputs = (): MortgageInputs => ({
  principal: 400_000,
  rate: 0.06,
  termYears: 30,
  startMonth: 1,
  startYear: 2027,
  extraMonthly: 500,
  lumps: [],
  horizonYears: 30,
  investReturn: 0.07,
  volatility: 0.16,
  dividendYield: 0.015,
  investTaxRate: 0.188,
  account: "taxable",
  sellAtHorizon: true,
  deductInterest: true,
  marginalRate: 0.24,
  standardDeduction: 32_200,
  otherItemized: 15_000,
  otherItemizedFrom2030: 10_000,
  debtCap: 750_000,
  inflation: 0.025,
  realDollars: false,
});

export const SPECS = {
  principal: { min: 50_000, max: 2_000_000, step: 5_000, unit: "usd" },
  rate: { min: 0.02, max: 0.1, step: 0.000625, unit: "pct", digits: 3, band: [0.055, 0.07], sides: ["Optimistic", "Conservative"] },
  termYears: { min: 5, max: 40, step: 1, unit: "years" },
  extraMonthly: { min: 0, max: 10_000, step: 50, unit: "usd" },
  horizonYears: { min: 1, max: 50, step: 1, unit: "years" },
  investReturn: { min: 0, max: 0.12, step: 0.0025, unit: "pct", digits: 2, band: [0.05, 0.08], sides: ["Conservative", "Optimistic"] },
  volatility: { min: 0, max: 0.3, step: 0.01, unit: "pct", digits: 0, band: [0.12, 0.18], sides: ["Optimistic", "Conservative"] },
  dividendYield: { min: 0, max: 0.05, step: 0.0025, unit: "pct", digits: 2, band: [0.01, 0.02] },
  investTaxRate: { min: 0, max: 0.4, step: 0.001, unit: "pct", digits: 1, band: [0.15, 0.238] },
  marginalRate: { min: 0, max: 0.55, step: 0.01, unit: "pct", digits: 0, band: [0.22, 0.37] },
  standardDeduction: { min: 0, max: 60_000, step: 100, unit: "usd" },
  otherItemized: { min: 0, max: 100_000, step: 500, unit: "usd" },
  inflation: { min: 0, max: 0.06, step: 0.0025, unit: "pct", digits: 2, band: [0.02, 0.03] },
} satisfies Record<string, SliderSpec>;

export function lumpLabel(r: LumpRow): string {
  const when = `${MONTHS[r.month - 1]} ${r.year}`;
  const name = r.label.trim() || (r.repeat ? "Yearly lump" : "Lump sum");
  return r.repeat ? `${name} · ${when}–${r.untilYear}` : `${name} · ${when}`;
}

/** Rows → dated lumps in loan months; rows before the first payment are dropped. */
export function expandLumps(rows: LumpRow[], startYear: number, startMonth: number): Lump[] {
  const out: Lump[] = [];
  for (const r of rows) {
    if (!(r.amount > 0)) continue;
    // Nothing past a century of payments matters (the horizon tops out well before), and a
    // typo in "until" mustn't loop through millions of years.
    const last = Math.min(r.repeat ? Math.max(r.year, r.untilYear) : r.year, startYear + 100);
    for (let y = r.year; y <= last; y++) {
      const month = calendarToLoanPaymentMonth(y, r.month, startYear, startMonth);
      if (month >= 1) out.push({ id: r.id, month, amount: r.amount });
    }
  }
  return out;
}

export function toPlan(i: MortgageInputs): MortgagePlan {
  return {
    principal: i.principal,
    annualRate: i.rate,
    termMonths: Math.round(i.termYears * 12),
    startYear: i.startYear,
    startMonth: i.startMonth,
    extraMonthly: i.extraMonthly,
    lumps: expandLumps(i.lumps, i.startYear, i.startMonth),
    horizonMonths: Math.round(i.horizonYears * 12),
    investReturn: i.investReturn,
    dividendYield: i.dividendYield,
    investTaxRate: i.investTaxRate,
    taxFreeAccount: i.account === "taxFree",
    sellAtHorizon: i.sellAtHorizon,
    deductInterest: i.deductInterest,
    marginalRate: i.marginalRate,
    standardDeduction: i.standardDeduction,
    otherItemized: i.otherItemized,
    otherItemizedFrom2030: i.otherItemizedFrom2030,
    debtCap: i.debtCap,
    inflation: i.inflation,
  };
}

/** The loan from the Home budget page's "Test a price" scenario (its saved inputs, else this browser's copy). */
export async function fromHomeBudget(): Promise<Partial<MortgageInputs> | null> {
  try {
    let saved = await fetchSavedInputs<HomeBudgetInputs>("pf-home-budget-inputs").catch(() => null);
    if (!saved) {
      const raw = localStorage.getItem("pf-home-budget-inputs");
      if (!raw) return null;
      saved = JSON.parse(raw) as Partial<HomeBudgetInputs>;
    }
    const h: HomeBudgetInputs = { ...defaultHomeBudgetInputs(), ...saved };
    return {
      principal: Math.round(h.budgetHomePrice * (1 - h.budgetDownPaymentPct)),
      rate: h.annualMortgageRate,
      termYears: h.mortgageTermYears,
      investReturn: h.investmentReturnRate,
    };
  } catch {
    return null;
  }
}

type LegacyInputs = {
  principal?: number;
  ratePct?: number;
  termYears?: number;
  extraMonthly?: number;
  loanStartMonth?: number;
  loanStartYear?: number;
  investReturnPct?: number;
  marginalTaxPct?: number;
  lumpRows?: { id: string; month: number; year: number; amount: number }[];
};

/** Inputs saved by the previous version of this page, carried over once. */
export function migrateLegacy(): Partial<MortgageInputs> | null {
  try {
    if (localStorage.getItem(`${STORAGE_KEY}-migrated`)) return null;
    localStorage.setItem(`${STORAGE_KEY}-migrated`, "1");
    const raw = localStorage.getItem("pf-mortgage-inputs");
    if (!raw) return null;
    const o = JSON.parse(raw) as LegacyInputs;
    const out: Partial<MortgageInputs> = {};
    if (o.principal) out.principal = o.principal;
    if (o.ratePct != null) out.rate = o.ratePct / 100;
    if (o.termYears) out.termYears = o.termYears;
    if (o.extraMonthly != null) out.extraMonthly = o.extraMonthly;
    if (o.loanStartMonth) out.startMonth = o.loanStartMonth;
    if (o.loanStartYear) out.startYear = o.loanStartYear;
    if (o.investReturnPct != null) out.investReturn = o.investReturnPct / 100;
    if (o.marginalTaxPct != null) out.marginalRate = o.marginalTaxPct / 100;
    if (o.lumpRows?.length) out.lumps = o.lumpRows.map((r) => ({ ...r, label: "", repeat: false, untilYear: r.year }));
    if (out.termYears) out.horizonYears = out.termYears;
    return out;
  } catch {
    return null;
  }
}
