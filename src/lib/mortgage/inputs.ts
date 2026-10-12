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
