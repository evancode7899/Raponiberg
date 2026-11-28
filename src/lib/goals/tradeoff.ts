import type { FillTrace, GoalForecast } from "./fill.ts";

/**
 * Goals' trade-off: what saving more (or spending more) a month does to when each goal lands.
 * The shared forecast's path is the plan; a change of `delta` cents a month goes into (or comes
 * out of) the liquid accounts from the first month on, with no growth on it (so saving more is
 * never flattered). Each goal keeps its turn as the forecast filled it (FillTrace: what it had
 * to cover, from which kinds of account), so the order and the claims are the report's own.
 * A what-if: nothing here is a proven figure.
 */

export type TradeGoal = { id: string; filled: FillTrace | null; targetDate: string | null };

/** The month (YYYY-MM) a goal's turn is covered with `delta` more saved each month; null when the forecast never gets there. */
export function landsWith(f: GoalForecast, filled: FillTrace, delta: number): string | null {
  return (
    f.months.find((m, i) => {
      const added = filled.sides.reduce((t, s) => t + m[s] - f.start[s], 0) + (filled.sides.includes("liquid") ? delta * (i + 1) : 0);
      return added >= filled.need;
    })?.key ?? null
  );
}

/** The least more a month (in steps of `step` cents, up to `max`) that lands a goal by its target date; 0 when it already does, null when no amount up to `max` does. */
export function savingToLand(f: GoalForecast, g: TradeGoal, step = 50_00, max = 20_000_00): number | null {
  if (!g.filled || !g.targetDate || !g.filled.sides.includes("liquid")) return null;
  const by = g.targetDate.slice(0, 7);
  const ok = (d: number) => {
    const k = landsWith(f, g.filled!, d);
    return k != null && k <= by;
  };
  if (ok(0)) return 0;
  for (let d = step; d <= max; d += step) if (ok(d)) return d;
  return null;
}
