import type { GoalForecast } from "../goals/fill.ts";
import { goalMonths, type GoalReach } from "./goals.ts";
import { monthsBetween, type RunMonth, type ScenarioRun } from "./engine.ts";

/**
 * What the Scenarios page compares, for a run: the short term (a year of cash flow from a
 * date, the first three years, the lowest cash), the long term (net worth, the FI year,
 * home equity against the money invested) and when each goal is reached. Pure.
 */

export type Flow = { from: string; to: string; months: number; gross: number; tax: number; takeHome: number; spending: number; saved: number; childcare: number; housing: number; rate: number | null };

export type Metrics = {
  /** Twelve months from `from`. */
  window: Flow;
  /** The first three years from the start, twelve months each. */
  years: Flow[];
  /** The lowest liquid balance over the first three years, and the month. */
  lowestCash: { cents: number; key: string };
  /** That lowest balance in months of the three years' average spending. */
  cushionMonths: number | null;
  /** Net worth (home equity included) at the end of each year. */
  netWorth: { year: number; cents: number }[];
  /** At the end of the horizon year: invested money (liquid + illiquid) and home equity. */
  horizon: { year: number; portfolio: number; equity: number; netWorth: number };
  fiYear: number | null;
  /** Per goal (in the order given): the month it's reached, "now", or null. */
  goals: (string | "now" | null)[];
};

/** Saving as a share of what came in after tax (take-home, bonuses kept and employer money). */
export const savingRate = (saved: number, income: number) => (income > 0 ? saved / income : null);

export function flowOf(months: readonly RunMonth[], from: string, n = 12): Flow {
  const ms = months.filter((m) => m.key >= from).slice(0, n);
  const sum = (k: keyof RunMonth) => ms.reduce((t, m) => t + (m[k] as number), 0);
  const income = sum("takeHome") + sum("employerMatch");
  return {
    from: ms[0]?.key ?? from,
    to: ms.at(-1)?.key ?? from,
    months: ms.length,
    gross: sum("gross"),
    tax: sum("tax"),
    takeHome: sum("takeHome"),
    spending: sum("spending"),
    saved: sum("saved"),
    childcare: sum("childcare"),
    housing: sum("housing"),
    rate: savingRate(sum("saved"), income),
  };
}

/** The path goals read: the run's liquid and illiquid balances (home equity funds no goal). */
export const goalPath = (run: ScenarioRun, startKey: string): GoalForecast => ({
  startKey,
  start: { liquid: run.plan.start.liquid, illiquid: run.plan.start.illiquid },
  months: run.outlook.map(({ key, liquid, illiquid }) => ({ key, liquid, illiquid })),
});

export function metricsOf(run: ScenarioRun, opts: { startKey: string; window: string; horizonYear: number; goals: readonly GoalReach[] }): Metrics {
  const first = run.months[0]?.key ?? opts.startKey;
  const years = [0, 1, 2].map((k) => flowOf(run.months, run.months[k * 12]?.key ?? first));
  const three = run.months.slice(0, 36);
  const low = three.reduce((a, m) => (m.liquid < a.liquid ? m : a), three[0] ?? { liquid: run.plan.start.liquid, key: first });
  const spend = three.length ? three.reduce((t, m) => t + m.spending, 0) / three.length : 0;
  const dec = run.years.filter((y) => y.year <= opts.horizonYear);
  const h = dec.at(-1);
  return {
    window: flowOf(run.months, opts.window),
    years,
    lowestCash: { cents: low.liquid, key: low.key },
    cushionMonths: spend > 0 ? low.liquid / spend : null,
    netWorth: dec.map((y) => ({ year: y.year, cents: y.netWorth })),
    horizon: { year: h?.year ?? opts.horizonYear, portfolio: h ? h.liquid + h.illiquid : 0, equity: h?.equity ?? 0, netWorth: h?.netWorth ?? 0 },
    fiYear: run.fiYear,
    goals: goalMonths(opts.goals, goalPath(run, opts.startKey)),
  };
}

/** How many months later (+) or sooner (−) a goal is reached than in today's plan; null when either never is. */
export function goalShift(scenario: string | "now" | null, today: string | "now" | null, startKey: string): number | null {
  if (scenario == null || today == null) return null;
  const k = (x: string) => (x === "now" ? startKey : x);
  return monthsBetween(k(today), k(scenario));
}
