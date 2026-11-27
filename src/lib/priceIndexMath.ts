/**
 * The price-index file's shape and its arithmetic, apart from reading it (lib/priceIndex.ts)
 * so pages can use it in the browser. A series is month → level (the month's published
 * value: a monthly average for CPI, a month-end close for a market index).
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
export type PriceIndexFile = { version: 1; series: Record<string, IndexSeries> };

/** The consumer price index's id in the file. */
export const CPI = "cpi-u";

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

/** The twelve months to the series' latest month on or before `key`: CPI over a year, as published. */
export function yearChange(s: IndexSeries | undefined, key: string) {
  const to = s ? latestAtOrBefore(s, key) : null;
  return to ? indexChange(s, addMonths(to, -12), to) : null;
}

/** A calendar year's average level, from all twelve months (null when any is missing). */
export function yearAverage(s: IndexSeries | undefined, year: number): number | null {
  if (!s) return null;
  const xs = Array.from({ length: 12 }, (_, i) => s.months[`${year}-${String(i + 1).padStart(2, "0")}`]);
  return xs.every((x) => x) ? xs.reduce((t, x) => t + x!, 0) / 12 : null;
}
