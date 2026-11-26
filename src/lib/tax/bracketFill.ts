import { FEDERAL_RATES } from "./params.ts";

/**
 * How ordinary taxable income fills the federal brackets (the regular tax, before qualified
 * dividends and long-term gains stack on top at 0/15/20%): each bracket's span by law, the
 * income in it and the tax on that income. The taxes add up to the bracket tax on the
 * ordinary income, before the return rounds it. Pure.
 */
export type BracketSlice = { rate: number; from: number; to: number | null; incomeCents: number; taxCents: number };

export function bracketFill(ordinaryCents: number, upperBounds: readonly number[]): BracketSlice[] {
  const out: BracketSlice[] = [];
  let lower = 0;
  for (let i = 0; i < FEDERAL_RATES.length; i++) {
    const upper = upperBounds[i] ?? Infinity;
    const income = Math.max(0, Math.min(ordinaryCents, upper) - lower);
    out.push({ rate: FEDERAL_RATES[i]!, from: lower, to: Number.isFinite(upper) ? upper : null, incomeCents: income, taxCents: income * FEDERAL_RATES[i]! });
    lower = upper;
  }
  return out;
}
