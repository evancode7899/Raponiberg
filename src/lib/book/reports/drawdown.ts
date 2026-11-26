/**
 * Drawdowns of a chained return: the deepest fall from a high, and how far below its high the
 * portfolio stands now, both time-weighted (each period's return chained, so money in and out
 * moves neither). A period without a return (too little invested) leaves the index where it was.
 */
export type Drawdown = {
  /** The deepest fall from a high, as a ratio (−0.12 is 12% below), with the periods it ran between. */
  max: { ratio: number; /** Null: the start of the stretch. */ peak: string | null; trough: string } | null;
  /** Below the latest high now (0 at a new high), and the high's period. */
  now: { ratio: number; peak: string | null };
};

export function drawdown(periods: readonly { label: string; r: number | null }[]): Drawdown | null {
  if (!periods.length) return null;
  let index = 1;
  let high = 1;
  let highAt: string | null = null;
  let max: Drawdown["max"] = null;
  for (const p of periods) {
    if (p.r != null) index *= 1 + p.r;
    if (index > high) {
      high = index;
      highAt = p.label;
    }
    const down = index / high - 1;
    if (down < 0 && (!max || down < max.ratio)) max = { ratio: down, peak: highAt, trough: p.label };
  }
  return { max, now: { ratio: Math.min(0, index / high - 1), peak: highAt } };
}
