import type { HomeFunds, HomeSpending } from "../book/reports/homeFunds.ts";
import type { HomeForecast } from "../forecast/forecast.ts";
import { cashForHomeFromNetWorth, type HomeBudgetInputs } from "./homeBudgetModel.ts";
import { gainsTaxRate, payTaxRate } from "./homeTax.ts";

/**
 * Where the cash for the home comes from (net worth or a fixed amount) and when you buy:
 * null = today's proven balances, or a month (YYYY-MM) read from the shared forecast. The
 * household salary follows the forecast for that year unless typed (`salary: "manual"`);
 * the income and capital-gains tax rates come from the tax engine unless typed; the lender
 * view counts bonus unless `lenderBonus` is false.
 */
export type FundsConfig = {
  mode: "networth" | "manual";
  share: number;
  buyAt?: string | null;
  salary?: "forecast" | "manual";
  incomeTax?: "engine" | "manual";
  gainsTax?: "engine" | "manual";
  lenderBonus?: boolean;
};

export const defaultFunds = (): FundsConfig => ({ mode: "networth", share: 0.8, buyAt: null, salary: "forecast", incomeTax: "engine", gainsTax: "engine", lenderBonus: true });

/** What /api/home-budget/funds serves: the Book's liquid money, the shared forecast's view for a buy date, and spending outside housing. */
export type FundsBook = HomeFunds & { forecast: HomeForecast | null; spending: HomeSpending | null };

/** A tax rate from the engine (null when it can't be worked out) and whether the page uses it. */
export type LinkedRate = { engine: number | null; linked: boolean };

/** Everything the page links to the Book and the forecast, and the one set of inputs the model sees. */
export type HomeLinked = {
  /** The buy month actually used (null = now), and the forecast's household base salary that year (dollars). */
  buy: { key: string | null; year: number; salary: number | null; salaryLinked: boolean };
  /** Liquid net worth after cards (at the buy date), its tax on gains, after-tax and the committed share. */
  derived: { liquid: number; gain: number; taxOnGain: number; afterTax: number; available: number; buyKey: string | null; added: number; gainAdded: number } | null;
  /** Income tax on the salary and capital-gains tax, from the tax engine. */
  tax: { year: number | null; income: LinkedRate; gains: LinkedRate & { gain: number } };
  /** True when the cash for the home is the net-worth figure (linked, loaded, proven). */
  linked: boolean;
  /** What the model sees: the typed inputs with the linked figures put in. */
  ins: HomeBudgetInputs;
  /** The lender's two-year bonus average (dollars), whether it's counted, and the income the lender view uses. */
  lender: { bonus: { annual: number; years: number[] } | null; countBonus: boolean; income: number };
};

/**
 * The Home budget page's links, worked out once for the page and for its proofs (the
 * "planning" proof kind): the buy month, the forecast's salary that year, liquid money then
 * (today's proven balances plus what the forecast adds), the tax engine's rates, and the
 * inputs the model runs on. Money in dollars, as the model takes it. Pure.
 */
export function linkHome(book: FundsBook | null, stored: HomeBudgetInputs, config: FundsConfig, fallbackYear = new Date().getFullYear()): HomeLinked {
  // A buy month only means something with a forecast that reaches it.
  const fc = book?.forecast ?? null;
  const buyKey = fc && config.buyAt && config.buyAt > fc.startKey && fc.months.some((m) => m.key === config.buyAt) ? config.buyAt : null;
  const buyYear = buyKey ? Number(buyKey.slice(0, 4)) : fc ? Number(fc.startKey.slice(0, 4)) : fallbackYear;
  const forecastSalary = fc?.salary[buyYear] != null ? fc.salary[buyYear]! / 100 : null;
  const salaryLinked = config.salary !== "manual" && forecastSalary != null;
  const buy = { key: buyKey, year: buyYear, salary: forecastSalary, salaryLinked };
  const salary = salaryLinked ? forecastSalary! : stored.annualHouseholdSalary;

  // At a future month: today's proven liquid money plus what the forecast adds by then, and the growth in it as more gain.
  let gains: { added: number; gainAdded: number; gain: number } | null = null;
  if (book) {
    const at = buyKey && fc ? fc.months.find((m) => m.key === buyKey)! : null;
    const added = at && fc ? (at.liquid - fc.startLiquid) / 100 : 0;
    const gainAdded = at && fc ? fc.months.filter((m) => m.key <= buyKey!).reduce((t, m) => t + m.liquidGrowth, 0) / 100 : 0;
    gains = { added, gainAdded, gain: book.gainCents / 100 + gainAdded };
  }

  // Tax rates from the engine at this salary, unless typed.
  const basis = fc?.tax ?? null;
  const gain = gains?.gain ?? 0;
  const incomeEngine = basis ? payTaxRate(basis, salary) : null;
  const gainsEngine = basis ? gainsTaxRate(basis, salary, gain) : null;
  const tax = {
    year: basis?.year ?? null,
    income: { engine: incomeEngine, linked: config.incomeTax !== "manual" && incomeEngine != null },
    gains: { engine: gainsEngine, linked: config.gainsTax !== "manual" && gainsEngine != null, gain },
  };
  const capitalGainsTaxRate = tax.gains.linked ? tax.gains.engine! : stored.capitalGainsTaxRate;

  let derived: HomeLinked["derived"] = null;
  if (book && gains) {
    const liquid = (book.cashCents + book.investmentsCents + book.cardsCents) / 100 + gains.added;
    derived = { liquid, gain: gains.gain, buyKey, added: gains.added, gainAdded: gains.gainAdded, ...cashForHomeFromNetWorth({ liquid, gain: gains.gain, taxRate: capitalGainsTaxRate, share: config.share }) };
  }

  const linked = config.mode === "networth" && derived !== null && book!.blockers.length === 0;
  // The model only sees one number each: the linked figure, or the typed amount.
  const ins: HomeBudgetInputs = {
    ...stored,
    cashForHome: linked ? derived!.available : stored.cashForHome,
    annualHouseholdSalary: salary,
    incomeTaxRate: tax.income.linked ? tax.income.engine! : stored.incomeTaxRate,
    capitalGainsTaxRate,
  };

  const lenderBonus = fc?.lenderBonus ? { annual: fc.lenderBonus.annual / 100, years: fc.lenderBonus.years } : null;
  const countBonus = config.lenderBonus !== false && lenderBonus != null;
  return { buy, derived, tax, linked, ins, lender: { bonus: lenderBonus, countBonus, income: ins.annualHouseholdSalary + (countBonus ? lenderBonus!.annual : 0) } };
}
