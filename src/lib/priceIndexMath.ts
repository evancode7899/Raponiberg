/**
 * A monthly index series and its arithmetic: the benchmark fund's level month by month, read off
 * the household's own statements (book/reports/fundBenchmark.ts). Plain math, so pages can use it
 * in the browser.
 */
export type IndexSeries = {
  name: string;
  /** The publisher and its series id, as cited. */
  source: string;
  url: string;
  /** The day Claude fetched it (YYYY-MM-DD). */
  fetchedOn: string;
  /** A price index (dividends not in it) or a total-return one (they are). */
  kind: "price" | "total-return";
  months: Record<string, number>;
};

/** A month key `n` months from `key` (YYYY-MM). */
export function addMonths(key: string, n: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  return `${yy}-${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}`;
}

/** The latest month the series has on or before `key` (null: none). */
export function latestAtOrBefore(s: IndexSeries, key: string): string | null {
  return Object.keys(s.months).filter((k) => k <= key).sort().at(-1) ?? null;
}

/**
 * The change in a series from one month to another: level at `to` ÷ level at `from` − 1.
 * Null when either month is missing (nothing is filled in or guessed).
 */
export function indexChange(s: IndexSeries | undefined, from: string, to: string): { from: string; to: string; fromLevel: number; toLevel: number; change: number } | null {
  const a = s?.months[from];
  const b = s?.months[to];
  if (!a || !b) return null;
  return { from, to, fromLevel: a, toLevel: b, change: b / a - 1 };
}
