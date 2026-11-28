import { COST_LINES, type CarReport, type CostLine } from "./report.ts";

/**
 * Keep or replace, from what the statements show the car costs to run (no prices from
 * outside, no guess at a new car's sticker): each year of ownership's running costs (fuel,
 * service, repairs, insurance, tolls, parking, registration: every line but depreciation and
 * financing interest), how much of it went on repairs and maintenance, and the miles. The
 * car's own first year stands for what a car like it costs to run while it's newer: the
 * latest twelve months against it say how much more keeping it now costs a year.
 */

/** The lines the statements pay: everything but depreciation (a value, not a payment) and interest (typed). */
export const RUNNING_LINES: readonly CostLine[] = COST_LINES.filter((l) => l !== "DEPRECIATION" && l !== "INTEREST");
const UPKEEP: readonly CostLine[] = ["REPAIR", "MAINTENANCE"];

export type OwnershipYear = {
  /** 1 for the first twelve months owned. */
  n: number;
  from: string;
  /** Last month in it (YYYY-MM). */
  to: string;
  months: number;
  runningCents: number;
  upkeepCents: number;
  miles: number;
  /** Running cost per mile, cents; null with no miles. */
  perMile: number | null;
};

export type KeepReplace = {
  years: OwnershipYear[];
  /** The first full year against the latest twelve months; null until the car has both (two years owned). */
  compare: { first: OwnershipYear; latest: OwnershipYear; extraCents: number; upkeepExtraCents: number; change: number | null } | null;
};

export function keepOrReplace(car: Pick<CarReport, "months">): KeepReplace {
  const months = car.months;
  const sum = (ms: typeof months, lines: readonly CostLine[]) => ms.reduce((s, m) => s + lines.reduce((t, l) => t + (m.lines[l] ?? 0), 0), 0);
  const yearOf = (n: number, ms: typeof months): OwnershipYear => {
    const miles = ms.reduce((s, m) => s + m.miles, 0);
    const runningCents = sum(ms, RUNNING_LINES);
    return { n, from: ms[0]!.month, to: ms.at(-1)!.month, months: ms.length, runningCents, upkeepCents: sum(ms, UPKEEP), miles, perMile: miles > 0 ? runningCents / miles : null };
  };
  const years: OwnershipYear[] = [];
  for (let i = 0; i < months.length; i += 12) years.push(yearOf(years.length + 1, months.slice(i, i + 12)));
  const first = years[0];
  // The latest twelve months, whichever ownership years they fall in.
  const latest = months.length >= 24 ? yearOf(0, months.slice(-12)) : null;
  const compare =
    first && first.months === 12 && latest
      ? { first, latest, extraCents: latest.runningCents - first.runningCents, upkeepExtraCents: latest.upkeepCents - first.upkeepCents, change: first.runningCents > 0 ? latest.runningCents / first.runningCents - 1 : null }
      : null;
  return { years, compare };
}
