import { median } from "./cashFlowWindows.ts";
import type { SpendingMonth } from "./spending.ts";

/**
 * Seasonality: each calendar month against the same month in earlier years, and an estimate
 * of where the year lands. Only proven months count; a year's months are indexed by calendar
 * month (0 = January), a month not proven left empty. Pure.
 *
 * The year-end figure is an estimate by its nature (months not yet on file): it's named one
 * wherever it shows, and never added into a proven total.
 */

export type SeasonMetric = "spending" | "everyday";
export const SEASON_METRICS: Record<SeasonMetric, { label: string; f: (m: SpendingMonth) => number }> = {
  spending: { label: "Spending", f: (m) => m.spendingCents },
  everyday: { label: "Everyday spending", f: (m) => m.kinds.everydayCents },
};

/** Each calendar year's proven months, by calendar month. */
export function calendarYears(months: readonly SpendingMonth[]): Map<number, (SpendingMonth | null)[]> {
  const out = new Map<number, (SpendingMonth | null)[]>();
  for (const m of months) {
    const y = Number(m.start.slice(0, 4));
    const row = out.get(y) ?? Array.from({ length: 12 }, () => null);
    row[Number(m.start.slice(5, 7)) - 1] = m;
    out.set(y, row);
  }
  return out;
}

/** The same month in the years before `year`: how many there are, and their low, middle and high. */
export type Band = { n: number; low: number; mid: number; high: number; years: number[] } | null;

export function seasonBands(months: readonly SpendingMonth[], year: number, f: (m: SpendingMonth) => number): Band[] {
  const years = [...calendarYears(months)].filter(([y]) => y < year);
  return Array.from({ length: 12 }, (_, i) => {
    const seen = years.flatMap(([y, ms]) => (ms[i] ? [{ y, v: f(ms[i]!) }] : []));
    if (!seen.length) return null;
    const vs = seen.map((x) => x.v);
    return { n: seen.length, low: Math.min(...vs), mid: median(vs), high: Math.max(...vs), years: seen.map((x) => x.y) };
  });
}

export type YearEnd = {
  year: number;
  /** The last month on file, by calendar month (0 = January). */
  through: number;
  /** The year so far: January through `through`, every one proven. */
  soFarCents: number;
  /** Each month left, at the middle of the same month in earlier years. */
  rest: { month: number; cents: number; years: number }[];
  estimateCents: number;
  /** If the rest of the year went as it did in each earlier year with every month left on file. */
  alike: { year: number; cents: number }[];
};

/**
 * Where the latest year lands: the year so far plus each month left at its middle in earlier
 * years. Null for a year not started in January, one already over, or a month left that no
 * earlier year has.
 */
export function yearEndEstimate(months: readonly SpendingMonth[], f: (m: SpendingMonth) => number): YearEnd | null {
  const last = months.at(-1);
  if (!last) return null;
  const year = Number(last.start.slice(0, 4));
  const all = calendarYears(months);
  const row = all.get(year)!;
  const through = Number(last.start.slice(5, 7)) - 1;
  if (through >= 11 || row.slice(0, through + 1).some((m) => !m)) return null;
  const bands = seasonBands(months, year, f);
  const left = bands.slice(through + 1);
  if (left.some((b) => !b)) return null;
  const soFarCents = row.slice(0, through + 1).reduce((s, m) => s + f(m!), 0);
  const rest = left.map((b, k) => ({ month: through + 1 + k, cents: b!.mid, years: b!.n }));
  const alike = [...all]
    .filter(([y, ms]) => y < year && ms.slice(through + 1).every(Boolean))
    .map(([y, ms]) => ({ year: y, cents: soFarCents + ms.slice(through + 1).reduce((s, m) => s + f(m!), 0) }));
  return { year, through, soFarCents, rest, estimateCents: soFarCents + rest.reduce((s, r) => s + r.cents, 0), alike };
}
