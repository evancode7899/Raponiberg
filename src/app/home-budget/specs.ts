import type { HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import type { SliderSpec } from "./RangeSlider";

const AC: [string, string] = ["Aggressive", "Conservative"]; // low value is the aggressive end
const CA: [string, string] = ["Conservative", "Aggressive"]; // high value is the aggressive end
const RB: [string, string] = ["Favors renting", "Favors buying"];
const BR: [string, string] = ["Favors buying", "Favors renting"];

type Field = keyof HomeBudgetInputs;

/**
 * Slider scales. Bands are rules of thumb, not advice: lender DTI norms for the housing
 * cap, the 1–2% maintenance rule, typical closing costs, long-run US appreciation and
 * rent growth, a balanced portfolio's long-run return, and so on.
 */
export const SPECS: Partial<Record<Field, SliderSpec & { hint?: string }>> = {
  annualHouseholdSalary: { min: 50_000, max: 750_000, step: 5_000, unit: "usd", hint: "Gross, before tax and payroll deductions." },
  housingCostMaxOfGross: {
    min: 0.2, max: 0.5, step: 0.005, unit: "pct", band: [0.28, 0.36], sides: CA,
    hint: "All-in housing as a share of gross pay. Lenders' classic limits: 28% front-end, 36% back-end; 43% is the usual hard ceiling.",
  },
  incomeTaxRate: {
    min: 0.1, max: 0.5, step: 0.005, unit: "pct", band: [0.25, 0.38], sides: AC,
    hint: "Average all-in rate (federal, state, payroll) on gross pay — not the top marginal bracket.",
  },
  minimumMonthlySavings: { min: 0, max: 10_000, step: 100, unit: "usd", sides: AC, hint: "Saved every month on top of housing." },

  annualMortgageRate: { min: 0.03, max: 0.1, step: 0.000625, unit: "pct", digits: 3, band: [0.055, 0.07], sides: ["Optimistic", "Conservative"] },
  annualMortgageInsuranceRateOnLoan: {
    min: 0, max: 0.015, step: 0.0005, unit: "pct", digits: 2, band: [0, 0.01], sides: ["Aggressive", "Conservative"],
    hint: "PMI, usually 0.3–1% of the loan a year, and only with under 20% down.",
  },

  annualPropertyTaxRate: { min: 0.002, max: 0.03, step: 0.0001, unit: "pct", digits: 2, band: [0.012, 0.02], sides: AC, hint: "Effective rate on market value; check the county's actual levy." },
  annualInsuranceRateOnValue: { min: 0.002, max: 0.02, step: 0.0005, unit: "pct", digits: 2, band: [0.004, 0.01], sides: AC },
  annualMaintenanceRate: { min: 0, max: 0.04, step: 0.0025, unit: "pct", digits: 2, band: [0.01, 0.02], sides: AC, hint: "The 1–2% rule: older homes sit at the top." },
  utilitiesMonthly: { min: 0, max: 2_000, step: 25, unit: "usd", band: [300, 800], sides: AC },
  hoaMonthly: { min: 0, max: 2_000, step: 25, unit: "usd" },

  closingCostsPctOfHomePrice: { min: 0, max: 0.1, step: 0.0025, unit: "pct", digits: 2, band: [0.02, 0.05], sides: AC, hint: "Lender fees, title, transfer tax, prepaids." },
  renovationPctOfHomePrice: { min: 0, max: 0.25, step: 0.005, unit: "pct", band: [0.02, 0.1], sides: AC, hint: "Furnishing and first-year fixes, paid in cash at the start." },

  budgetDownPaymentPct: { min: 0.03, max: 1, step: 0.005, unit: "pct", band: [0.2, 0.3], sides: AC, hint: "Under 20% usually means mortgage insurance." },
  capitalGainsTaxRate: { min: 0, max: 0.35, step: 0.001, unit: "pct", band: [0.15, 0.238], sides: AC, hint: "15% or 20% federal, plus 3.8% NIIT at higher incomes, plus state." },

  marketRentMonthly: { min: 500, max: 15_000, step: 50, unit: "usd", sides: RB, hint: "Rent for a comparable home." },
  rentGrowthRate: { min: 0, max: 0.08, step: 0.0025, unit: "pct", digits: 2, band: [0.02, 0.04], sides: RB },
  homeAppreciationRate: { min: -0.02, max: 0.08, step: 0.0025, unit: "pct", digits: 2, band: [0.02, 0.045], sides: RB, hint: "US home prices have risen ~3–4% a year over the long run." },
  investmentReturnRate: { min: 0.02, max: 0.12, step: 0.0025, unit: "pct", digits: 2, band: [0.05, 0.08], sides: BR, hint: "What the renter earns on the cash the buyer ties up." },
  sellingCostsPct: { min: 0, max: 0.1, step: 0.0025, unit: "pct", digits: 2, band: [0.05, 0.08], sides: BR },
  horizonYears: { min: 1, max: 30, step: 1, unit: "years", band: [5, 15], sides: RB, hint: "Buying costs a lot up front and to sell, so it needs time to pay off." },
  equityRiskPremium: { min: 0, max: 0.1, step: 0.0025, unit: "pct", digits: 2, band: [0.03, 0.06], sides: BR, hint: "Year-one snapshot only: the extra return given up on cash tied up in the home." },
};

/** Share of after-tax liquid net worth committed to the purchase. */
export const FUNDS_SHARE_SPEC: SliderSpec = { min: 0.2, max: 1, step: 0.01, unit: "pct", digits: 0, band: [0.6, 0.85], sides: CA };

export function spec(field: Field): SliderSpec & { hint?: string } {
  const s = SPECS[field];
  if (!s) throw new Error(`No slider spec for ${field}`);
  return s;
}
