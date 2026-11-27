/**
 * When goals are reached on a forecast: the money the forecast adds to liquid and illiquid
 * accounts fills unfinished goals in priority order. Pure and free of the Book, so the
 * Goals report (book/reports/goals.ts) and the Scenarios page (each scenario's own path)
 * run the same rule.
 */

/** The forecast's liquid and illiquid balances by month (cents), from the start. */
export type GoalForecast = { startKey: string; start: { liquid: number; illiquid: number }; months: { key: string; liquid: number; illiquid: number }[] };

/** What a goal's turn asked of the forecast: `need` (its own `own` plus earlier goals' on the same kinds) from the money added to `sides` since the start. */
export type FillTrace = { need: number; own: number; sides: ("liquid" | "illiquid")[] };

/**
 * New money from the forecast filling unfinished goals in priority order: call it once per
 * goal, in order, with what's still needed and which kinds of account fund it; it returns
 * the month (YYYY-MM) the goal is reached, or null. A goal on one kind of account waits
 * behind earlier goals on the same kind; a goal on both kinds waits behind all of them.
 * A tracking goal (a milestone) waits behind nobody and holds nobody up: it's reached when
 * the new money alone covers what it still needs.
 */
export function forecastFiller(f: GoalForecast): (remaining: number, liquid: boolean, illiquid: boolean, track?: boolean, trace?: (t: FillTrace) => void) => string | null {
  const filled = { liquid: 0, illiquid: 0 };
  const added = (m: GoalForecast["months"][number], s: "liquid" | "illiquid") => m[s] - f.start[s];
  return (remaining, liquid, illiquid, track = false, trace) => {
    const sides: FillTrace["sides"] = [...(liquid ? (["liquid"] as const) : []), ...(illiquid ? (["illiquid"] as const) : [])];
    const fill = (need: number, over: FillTrace["sides"]) => {
      trace?.({ need, own: remaining, sides: over });
      return f.months.find((m) => over.reduce((t, s) => t + added(m, s), 0) >= need)?.key ?? null;
    };
    if (track) return fill(remaining, sides);
    if (liquid && illiquid) {
      const need = filled.liquid + filled.illiquid + remaining;
      filled.liquid += remaining;
      return fill(need, sides);
    }
    const s = liquid ? "liquid" : "illiquid";
    filled[s] += remaining;
    return fill(filled[s], [s]);
  };
}
