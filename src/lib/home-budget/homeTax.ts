import type { HomeForecast } from "../forecast/forecast.ts";
import { taxOnPay, type PayForTax } from "../profile/basePay.ts";
import { TAX_YEARS } from "../tax/params.ts";

/**
 * The page's two tax rates from the real engine (federal, Connecticut, FICA, CT paid leave,
 * filing jointly), for any household salary: it is split between the earners in their
 * base-pay shares. Wages only — no 401(k), HSA or benefit deductions — so the rate errs a
 * little high. Pure, so the page reruns it as the salary moves. Money in dollars.
 */
export type HomeTaxBasis = HomeForecast["tax"];

/** A gain this size or bigger prices the gains rate when the embedded gain is small. */
const MIN_GAIN = 50_000;

function people(basis: HomeTaxBasis, salary: number): PayForTax[] {
  return basis.earners.map((e) => ({ id: e.id, name: e.name, salary: Math.round(salary * e.share * 100), bonus: 0, k401Pretax: 0, hsa: 0, section125: 0 }));
}

const paramsFor = (basis: HomeTaxBasis) => TAX_YEARS[basis.year] ?? null;

/** All-in tax on the salary ÷ the salary: federal and CT income tax plus payroll. Null when the law year isn't in the app. */
export function payTaxRate(basis: HomeTaxBasis, salary: number): number | null {
  const params = paramsFor(basis);
  if (!params || salary <= 0 || !basis.earners.length) return null;
  return taxOnPay(params, people(basis, salary), basis.dependents).total / 100 / salary;
}

/**
 * Tax on a long-term gain on top of the salary, ÷ the gain: federal 15/20%, the 3.8% NIIT
 * and Connecticut (which taxes gains as ordinary income), at the margin where the gain lands.
 */
export function gainsTaxRate(basis: HomeTaxBasis, salary: number, gain: number): number | null {
  const params = paramsFor(basis);
  if (!params || salary <= 0 || !basis.earners.length) return null;
  const g = Math.max(MIN_GAIN, gain);
  const base = taxOnPay(params, people(basis, salary), basis.dependents);
  const withGain = taxOnPay(params, people(basis, salary), basis.dependents, Math.round(g * 100));
  return (withGain.federal + withGain.ct - base.federal - base.ct) / 100 / g;
}
