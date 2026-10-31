import { TAX_YEARS } from "../tax/params.ts";
import { calendarToLoanPaymentMonth, type Lump, type MortgagePlan } from "./prepayVsInvest.ts";

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
    investTaxRate: i.fedGainsRate + i.ctGainsRate,
    taxFreeAccount: i.account === "taxFree",
    sellAtHorizon: i.sellAtHorizon,
    deductInterest: i.deductInterest,
    marginalRate: i.fedMarginalRate,
    standardDeduction: i.standardDeduction,
    stateIncomeTax: i.stateIncomeTax,
    propertyTax: i.propertyTax,
    charity: i.charity,
    saltCap: SALT_CAP_2026,
    saltCapFrom2030: SALT_CAP_FROM_2030,
    debtCap: i.debtCap,
    inflation: i.inflation,
  };
}

/** Fields of earlier saves whose meaning changed (combined state + federal rates, one "other itemized"); dropped on load. */
export const RETIRED_KEYS = ["investTaxRate", "marginalRate", "otherItemized", "otherItemizedFrom2030"] as const;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Inputs as the page and its proofs carry them: the defaults with every saved field of the
 * right kind over them, nothing else (no retired or unknown field). The page's figures name
 * these in their recipe, and the proof sweep reads the saved ones the same way.
 */
export function normalizeMortgageInputs(raw: Record<string, unknown> | null | undefined): MortgageInputs {
  const out = defaultInputs() as MortgageInputs & Record<string, unknown>;
  const x = raw ?? {};
  for (const [k, d] of Object.entries(out)) {
    const v = x[k];
    if (v === undefined) continue;
    if (typeof d === "number" && isNum(v)) out[k] = v;
    else if (typeof d === "boolean" && typeof v === "boolean") out[k] = v;
  }
  if (x.account === "taxable" || x.account === "taxFree") out.account = x.account;
  if (Array.isArray(x.lumps))
    out.lumps = x.lumps
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .slice(0, 100)
      .map((r) => ({ id: String(r.id ?? "").slice(0, 80), label: String(r.label ?? "").slice(0, 120), month: isNum(r.month) ? r.month : 1, year: isNum(r.year) ? r.year : out.startYear, amount: isNum(r.amount) ? r.amount : 0, repeat: r.repeat === true, untilYear: isNum(r.untilYear) ? r.untilYear : out.startYear }));
  if (x.typed && typeof x.typed === "object") {
    const typed = Object.fromEntries(LINKED_KEYS.filter((k) => (x.typed as Record<string, unknown>)[k] === true).map((k) => [k, true as const]));
    if (Object.keys(typed).length) out.typed = typed;
  }
  return out;
}
