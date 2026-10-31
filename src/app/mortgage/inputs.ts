import type { SliderSpec } from "@/app/home-budget/RangeSlider";
import { fetchSavedInputs } from "@/components/ui/kit";
import { defaultHomeBudgetInputs, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import type { LumpRow, MortgageInputs } from "@/lib/mortgage/inputs";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export { defaultInputs, expandLumps, RETIRED_KEYS, toPlan, type LumpRow, type MortgageInputs } from "@/lib/mortgage/inputs";


export const STORAGE_KEY = "pf-mortgage-v2";

export const SPECS = {
  principal: { min: 50_000, max: 2_000_000, step: 5_000, unit: "usd" },
  rate: { min: 0.02, max: 0.1, step: 0.000625, unit: "pct", digits: 3, band: [0.055, 0.07], sides: ["Optimistic", "Conservative"] },
  termYears: { min: 5, max: 40, step: 1, unit: "years" },
  extraMonthly: { min: 0, max: 10_000, step: 50, unit: "usd" },
  horizonYears: { min: 1, max: 50, step: 1, unit: "years" },
  investReturn: { min: 0, max: 0.12, step: 0.0025, unit: "pct", digits: 2, band: [0.05, 0.08], sides: ["Conservative", "Optimistic"] },
  volatility: { min: 0, max: 0.3, step: 0.01, unit: "pct", digits: 0, band: [0.12, 0.18], sides: ["Optimistic", "Conservative"] },
  dividendYield: { min: 0, max: 0.05, step: 0.0025, unit: "pct", digits: 2, band: [0.01, 0.02] },
  fedGainsRate: { min: 0, max: 0.3, step: 0.001, unit: "pct", digits: 1, band: [0.15, 0.238] },
  ctGainsRate: { min: 0, max: 0.1, step: 0.0001, unit: "pct", digits: 2, band: [0.03, 0.0699] },
  fedMarginalRate: { min: 0, max: 0.37, step: 0.01, unit: "pct", digits: 0, band: [0.22, 0.37] },
  standardDeduction: { min: 0, max: 60_000, step: 100, unit: "usd" },
  stateIncomeTax: { min: 0, max: 200_000, step: 500, unit: "usd" },
  propertyTax: { min: 0, max: 60_000, step: 100, unit: "usd" },
  charity: { min: 0, max: 100_000, step: 500, unit: "usd" },
  inflation: { min: 0, max: 0.06, step: 0.0025, unit: "pct", digits: 2, band: [0.02, 0.03] },
} satisfies Record<string, SliderSpec>;

export function lumpLabel(r: LumpRow): string {
  const when = `${MONTHS[r.month - 1]} ${r.year}`;
  const name = r.label.trim() || (r.repeat ? "Yearly lump" : "Lump sum");
  return r.repeat ? `${name} · ${when}–${r.untilYear}` : `${name} · ${when}`;
}

/** The loan and its property tax from the Home budget page's "Test a price" scenario (its saved inputs, else this browser's copy). */
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
      propertyTax: Math.round(h.budgetHomePrice * h.annualPropertyTaxRate),
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
    if (o.lumpRows?.length) out.lumps = o.lumpRows.map((r) => ({ ...r, label: "", repeat: false, untilYear: r.year }));
    if (out.termYears) out.horizonYears = out.termYears;
    return out;
  } catch {
    return null;
  }
}
