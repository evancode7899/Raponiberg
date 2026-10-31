import { comparePrepayVsInvest, monteCarlo, type Comparison, type MonteCarlo } from "./prepayVsInvest.ts";
import { toPlan, type MortgageInputs } from "./inputs.ts";

/**
 * The Mortgage page's four headline figures, as one pure function the page renders and
 * the proof sweep enumerates (proof/planningProof.ts, page "mortgage"): the server runs the
 * same comparison and the same seeded simulation on the same inputs (SSOT F4). Money is in
 * cents; `null` is a dash (nothing to compare yet).
 */

export type MortgageFigure = "advantage" | "break-even" | "chance" | "interest-saved";
export const MORTGAGE_FIGURES: MortgageFigure[] = ["advantage", "break-even", "chance", "interest-saved"];

export type MortgageValue = { cents: number | null } | { ratio: number | null };

export type MortgageFigures = {
  cmp: Comparison;
  mc: MonteCarlo;
  /** Whether there's anything to compare (an extra monthly amount, or a lump within the horizon). */
  hasChoice: boolean;
  /** Months to the horizon. */
  horizon: number;
  /** Interest each way through the horizon, in the display unit (dollars). */
  interest: { invest: number; prepay: number };
  /** Divides a dollar amount at month m into the display unit (today's dollars when asked for). */
  defl: (m: number) => number;
  values: Record<MortgageFigure, MortgageValue>;
};

const cents = (dollars: number) => Math.round(dollars * 100);

/** The figures on the inputs the model runs on (the saved inputs with the links put in). */
export function mortgageFigures(eff: MortgageInputs, lumpLabels: Record<string, string> = {}): MortgageFigures {
  const plan = toPlan(eff);
  const cmp = comparePrepayVsInvest(plan, lumpLabels);
  const mc = monteCarlo(plan, eff.volatility);
  const H = cmp.horizonMonths;
  const defl = (m: number) => (eff.realDollars ? Math.pow(1 + eff.inflation, m / 12) : 1);
  /** A running total through the horizon: each month's amount deflated by its own month. */
  const flow = (a: Float64Array) => {
    let t = 0;
    for (let m = 1; m <= H; m++) t += (a[m]! - a[m - 1]!) / defl(m);
    return t;
  };
  const hasChoice = plan.extraMonthly > 0 || plan.lumps.some((l) => l.month <= H);
  const mcFresh = mc.bands.at(-1)?.month === H;
  const interest = { invest: flow(cmp.invest.interest), prepay: flow(cmp.prepay.interest) };
  return {
    cmp,
    mc,
    hasChoice,
    horizon: H,
    interest,
    defl,
    values: {
      advantage: { cents: hasChoice ? cents(cmp.advantage / defl(H)) : null },
      "break-even": { ratio: hasChoice ? cmp.breakEvenReturn : null },
      chance: { ratio: hasChoice && mcFresh ? mc.chanceInvestWins : null },
      "interest-saved": { cents: cents(interest.invest - interest.prepay) },
    },
  };
}
