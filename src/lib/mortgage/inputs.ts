import { TAX_YEARS } from "../tax/params.ts";

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
  /**
   * Inputs the owner typed over a linked figure (LINKED_KEYS: the forecast's return and
   * inflation, the tax engine's rates). Absent: the page uses the linked figure, when there is one.
   */
  typed?: Partial<Record<LinkedKey, true>>;
};

/** The inputs the page takes from the forecast or the tax engine unless typed (api/mortgage/links). */
export const LINKED_KEYS = ["investReturn", "inflation", "fedMarginalRate", "standardDeduction", "stateIncomeTax"] as const;
export type LinkedKey = (typeof LINKED_KEYS)[number];

/** The inputs the model runs on: each linked figure in place of the saved one, unless the owner typed it. */
export function withLinks(i: MortgageInputs, links: Partial<Record<LinkedKey, { value: number } | null>>): MortgageInputs {
  const out = { ...i };
  for (const k of LINKED_KEYS) {
    const l = links[k];
    if (l && !i.typed?.[k]) out[k] = l.value;
  }
  return out;
}

/**
 * 2026 law, read from src/lib/tax/params.ts: the top long-term gains rate plus NIIT,
 * Connecticut's top rate, the SALT cap and the standard deduction (joint), in dollars.
 * The cap from 2030 is the law's scheduled reversion, not yet a params year.
 */
const LAW = TAX_YEARS[2026]!;
export const FED_TOP_GAINS_RATE = LAW.federal.preferentialRates.twenty + LAW.federal.niitRate;
export const CT_TOP_RATE = LAW.ct.brackets.MFJ.at(-1)![1];
export const SALT_CAP_2026 = LAW.federal.salt.cap.MFJ / 100;
export const SALT_CAP_FROM_2030 = 10_000;
const STANDARD_DEDUCTION_2026 = LAW.federal.standardDeduction.MFJ / 100;

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
  standardDeduction: STANDARD_DEDUCTION_2026,
  stateIncomeTax: 25_000,
  propertyTax: 7_500,
  charity: 5_000,
  debtCap: 750_000,
  inflation: 0.025,
  realDollars: false,
});
