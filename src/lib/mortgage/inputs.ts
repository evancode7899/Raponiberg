/**
 * The Mortgage page's inputs and their defaults. Kept apart from the page so scripts can
 * read the defaults too (npm run privacy:check leaves a calculator's untouched defaults
 * alone).
 */

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
  /** Federal tax on qualified dividends and long-term gains, NIIT included. */
  fedGainsRate: number;
  /** Connecticut tax on the same: it taxes them as ordinary income. */
  ctGainsRate: number;
  account: "taxable" | "taxFree";
  sellAtHorizon: boolean;
  deductInterest: boolean;
  /** Federal only: Connecticut has no itemized deductions. */
  fedMarginalRate: number;
  standardDeduction: number;
  stateIncomeTax: number;
  propertyTax: number;
  charity: number;
  debtCap: number;
  inflation: number;
  realDollars: boolean;
};

/**
 * 2026 law, as in src/lib/tax/params.ts (a test keeps them in step): top long-term gains
 * rate plus NIIT, Connecticut's top rate, and the SALT cap (joint) through 2029.
 */
export const FED_TOP_GAINS_RATE = 0.2 + 0.038;
export const CT_TOP_RATE = 0.0699;
export const SALT_CAP_2026 = 40_400;
export const SALT_CAP_FROM_2030 = 10_000;

/**
 * Defaults: a 30-year loan at today's rates, a broad stock index (7% long-run, 16%
 * volatility, 1.5% dividends) in a taxable account at the top rates (20% LTCG + 3.8% NIIT
 * federal, 6.99% Connecticut), the 35% federal bracket, and 2026 federal rules (standard
 * deduction $32,200 joint, $750k acquisition-debt cap).
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
  fedGainsRate: FED_TOP_GAINS_RATE,
  ctGainsRate: CT_TOP_RATE,
  account: "taxable",
  sellAtHorizon: true,
  deductInterest: true,
  fedMarginalRate: 0.35,
  standardDeduction: 32_200,
  stateIncomeTax: 25_000,
  propertyTax: 7_500,
  charity: 5_000,
  debtCap: 750_000,
  inflation: 0.025,
  realDollars: false,
});
