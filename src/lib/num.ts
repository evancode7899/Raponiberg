/**
 * Small number helpers that every report and page needed its own copy of. Totals here are
 * plain sums of what they're given: they never round, so a sum of cents stays in cents.
 */

/** The total of a list of numbers. */
export function sum(xs: readonly number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

/** The total of `f` over a list. */
export function sumBy<T>(xs: readonly T[], f: (x: T) => number): number {
  let t = 0;
  for (const x of xs) t += f(x);
  return t;
}

/** The total, or null when any part is missing: a sum of unknowns is unknown, never zero. */
export function sumOrNull(xs: readonly (number | null | undefined)[]): number | null {
  let t = 0;
  for (const x of xs) {
    if (x == null) return null;
    t += x;
  }
  return t;
}

/** `part` as a share of `whole` (0.25 for a quarter), or null when there is no whole to share. */
export function shareOf(part: number, whole: number): number | null {
  return whole === 0 || !Number.isFinite(whole) ? null : part / whole;
}

/** `v` held between `lo` and `hi`. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
