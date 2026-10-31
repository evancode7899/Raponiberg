import type { CashFlowDescriptor, CashFlowMetric } from "../proof/cashFlowProof.ts";
import type { CategoryAmount } from "./cashFlow.ts";
import type { MerchantMonth, SpendingKind, SpendingMonth, SpendingReport } from "./spending.ts";

/**
 * The runs of months the Cash flow page sums its figures over, and the one recipe each of
 * those figures carries. Pure: the page (app/cash-flow) slices and sums with these, and the
 * proof sweep (proof/figures.ts) enumerates the same runs with them, so every figure a tab
 * renders is one the sweep holds to its proof (swept = rendered).
 */

export type RangeId = "3m" | "6m" | "12m" | "ytd" | "all" | "custom";

/** The range picker's presets (custom is the owner's own pick, swept only when it lands on one of these). */
export const PRESET_RANGES = ["3m", "6m", "12m", "ytd", "all"] as const satisfies readonly RangeId[];

export type Slice = {
  months: SpendingMonth[];
  /** Up to as many months just before, for comparison (empty when fewer than three are proven). */
  prior: SpendingMonth[];
  label: string;
};

export const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** "2026-06" style month keys for selects. */
export const monthKey = (iso: string) => iso.slice(0, 7);

/** "2026-06" moved by a number of months. */
export const shiftMonth = (ym: string, months: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 7);
};

export function sliceRange(r: Pick<SpendingReport, "months">, range: RangeId, custom: { from: string; to: string }): Slice {
  const all = r.months;
  if (!all.length) return { months: [], prior: [], label: "" };
  let lo = 0;
  let hi = all.length - 1;
  if (range === "custom") {
    lo = Math.max(0, all.findIndex((m) => m.start >= custom.from));
    const h = all.findLastIndex((m) => m.start <= custom.to);
    hi = h < 0 ? all.length - 1 : h;
    if (lo > hi) lo = hi;
  } else if (range === "ytd") {
    const y = all[hi]!.start.slice(0, 4);
    lo = Math.max(0, all.findIndex((m) => m.start.startsWith(y)));
  } else if (range !== "all") {
    lo = Math.max(0, hi - ({ "3m": 3, "6m": 6, "12m": 12 }[range] - 1));
  }
  const months = all.slice(lo, hi + 1);
  const n = months.length;
  // Compared per month, so a shorter run before still works (at least three months).
  const prior = all.slice(Math.max(0, lo - n), lo);
  if (prior.length < Math.min(3, n)) prior.length = 0;
  return { months, prior, label: n === 1 ? months[0]!.label : `${months[0]!.label} – ${months.at(-1)!.label}` };
}

/** Where a slice's months sit in the report (the slice is a contiguous run of them). */
export const sliceStart = (r: Pick<SpendingReport, "months">, s: Slice) => Math.max(0, r.months.indexOf(s.months[0]!));

export function mergeCategories(months: SpendingMonth[], pick: (m: SpendingMonth) => CategoryAmount[]): CategoryAmount[] {
  const m = new Map<string, CategoryAmount>();
  for (const p of months) {
    for (const c of pick(p)) {
      const cur = m.get(c.category) ?? { ...c, cents: 0 };
      cur.cents += c.cents;
      m.set(c.category, cur);
    }
  }
  return [...m.values()].filter((c) => c.cents !== 0).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
}

export type MerchantTotal = MerchantMonth & { months: number; lastMonth: string; series: number[] };

/** Merchants (or payers) summed over months, with how many months they appear in. */
export function mergeMerchants(months: SpendingMonth[], pick: (m: SpendingMonth) => MerchantMonth[] = (m) => m.merchants): MerchantTotal[] {
  const out = new Map<string, MerchantTotal>();
  months.forEach((p, i) => {
    for (const x of pick(p)) {
      const cur = out.get(x.key) ?? { ...x, cents: 0, count: 0, months: 0, lastMonth: p.label, series: months.map(() => 0) };
      cur.cents += x.cents;
      cur.count += x.count;
      cur.months++;
      cur.lastMonth = p.label;
      cur.series[i] = x.cents;
      out.set(x.key, cur);
    }
  });
  return [...out.values()].filter((x) => x.cents > 0).sort((a, b) => b.cents - a.cents);
}

/**
 * The sum of `f` over the `n` months ending at each month (null until `n` are available).
 * The report's months are one unbroken run, so a window never spans a gap.
 */
export function trailing(all: SpendingMonth[], n: number, f: (m: SpendingMonth) => number): (number | null)[] {
  let run = 0;
  return all.map((m, i) => {
    run += f(m);
    if (i >= n) run -= f(all[i - n]!);
    return i >= n - 1 ? run : null;
  });
}

/** Calendar years of the report's months, oldest first (a year's months are one unbroken run). */
export function byYear(months: SpendingMonth[]): [string, SpendingMonth[]][] {
  const out = new Map<string, SpendingMonth[]>();
  for (const m of months) {
    const y = m.start.slice(0, 4);
    out.set(y, [...(out.get(y) ?? []), m]);
  }
  return [...out];
}

export type YoyMode = "month" | "ytd" | "12m";

/** Year over year: the latest month, the year to date or the last twelve months, against the same months a year earlier (and which aren't proven). */
export function yoyWindows(months: SpendingMonth[], mode: YoyMode) {
  const byKey = new Map(months.map((m) => [monthKey(m.start), m]));
  const latestKey = monthKey(months.at(-1)!.start);
  const keys = (k: string, n: number) => Array.from({ length: n }, (_, i) => shiftMonth(k, -(n - 1 - i)));
  const nowKeys = mode === "month" ? [latestKey] : mode === "ytd" ? keys(latestKey, Number(latestKey.slice(5))) : keys(latestKey, 12);
  const thenKeys = nowKeys.map((k) => shiftMonth(k, -12));
  return {
    nowKeys,
    thenKeys,
    missing: [...nowKeys, ...thenKeys].filter((k) => !byKey.has(k)),
    now: nowKeys.map((k) => byKey.get(k)).filter((m): m is SpendingMonth => m != null),
    then: thenKeys.map((k) => byKey.get(k)).filter((m): m is SpendingMonth => m != null),
  };
}

/** Trends' momentum: the last three months to the end of the range, and the (up to) twelve before them. */
export function momentumWindows(months: SpendingMonth[], hi: number) {
  return { recent: months.slice(Math.max(0, hi - 2), hi + 1), before: months.slice(Math.max(0, hi - 14), Math.max(0, hi - 2)) };
}

/** The twelve months the trailing totals at `hi` sum (none until twelve exist). */
export const last12At = (months: SpendingMonth[], hi: number) => (hi >= 11 ? months.slice(hi - 11, hi + 1) : []);

export type CashFlowRecipe = {
  category?: string;
  merchantKey?: string;
  /** With merchantKey: the merchant's charges dated in the twelve months ending with the last of `months` (Recurring's "last 12 months"). */
  charges?: boolean;
  /** Spending without the one-offs (Cash flow's "Excluding one-offs"). */
  excludeOneOffs?: boolean;
  /** One band of spending (Trends' bills / everyday / big & one-off). */
  spendingKind?: SpendingKind;
};

/** The recipe of a figure summed over `months` (contiguous, as every window is): the descriptor its proof re-derives. */
export function cashFlowDescriptor(metric: CashFlowMetric, months: SpendingMonth[], accountIds: string[] | undefined, o: CashFlowRecipe): CashFlowDescriptor {
  return {
    report: "cash-flow",
    metric,
    granularity: "month",
    start: o.charges ? `${shiftMonth(monthKey(months.at(-1)!.start), -11)}-01` : months[0]!.start,
    end: months.at(-1)!.end,
    ...(o.category ? { category: o.category } : {}),
    ...(o.merchantKey ? { merchantKey: o.merchantKey, ...(o.charges ? { merchantBasis: "charges" as const } : {}) } : {}),
    ...(accountIds?.length ? { accountIds } : {}),
    ...(o.excludeOneOffs ? { oneOffs: "exclude" as const } : {}),
    ...(o.spendingKind ? { spendingKind: o.spendingKind } : {}),
  };
}

const KIND_FIELD: Record<SpendingKind, "billCents" | "bigCents" | "everydayCents"> = { bill: "billCents", big: "bigCents", everyday: "everydayCents" };

/**
 * Every run of months a tab sums a figure over, on the page's default view (no account
 * filter, a preset range): each single month, each preset range and the run before it,
 * each calendar year, the year-over-year sides, Trends' twelve months and momentum, and
 * the twelve months before each range (Merchants' "gone quiet"). Deduplicated.
 */
export function cashFlowWindows(r: Pick<SpendingReport, "months">): SpendingMonth[][] {
  const all = r.months;
  if (!all.length) return [];
  const runs: SpendingMonth[][] = all.map((m) => [m]);
  const hi = all.length - 1;
  for (const range of PRESET_RANGES) {
    const s = sliceRange(r, range, { from: "", to: "" });
    const lo = sliceStart(r, s);
    runs.push(s.months, s.prior, all.slice(Math.max(0, lo - 12), lo));
  }
  for (const [, ms] of byYear(all)) runs.push(ms);
  for (const mode of ["month", "ytd", "12m"] as const) {
    const y = yoyWindows(all, mode);
    if (!y.missing.length) runs.push(y.now, y.then);
  }
  const m = momentumWindows(all, hi);
  runs.push(last12At(all, hi), m.recent, m.before, all.slice(Math.max(0, hi - 2), hi + 1));
  const seen = new Set<string>();
  return runs.filter((ms) => {
    if (!ms.length) return false;
    const k = `${ms[0]!.start}/${ms.at(-1)!.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** One figure over a run of months: its recipe and the total the page shows. */
export type CashFlowFigure = { descriptor: CashFlowDescriptor; cents: number };

/**
 * Every figure the tabs show over one run of months, with the total each shows: income,
 * spending, outside money and saved; each category of each; the three bands of spending;
 * spending less one-offs; and each merchant and payer.
 */
export function windowFigures(months: SpendingMonth[]): CashFlowFigure[] {
  const out: CashFlowFigure[] = [];
  const add = (metric: CashFlowMetric, o: CashFlowRecipe, cents: number) => out.push({ descriptor: cashFlowDescriptor(metric, months, undefined, o), cents });
  const income = sum(months, (m) => m.incomeCents);
  const spending = sum(months, (m) => m.spendingCents);
  add("income", {}, income);
  add("spending", {}, spending);
  add("net", {}, income - spending);
  add("external", {}, sum(months, (m) => sum(m.externalByCategory, (c) => c.cents)));
  add("spending", { excludeOneOffs: true }, spending - sum(months, (m) => m.oneOffCents));
  for (const k of ["bill", "big", "everyday"] as const) add("spending", { spendingKind: k }, sum(months, (m) => m.kinds[KIND_FIELD[k]]));
  for (const c of mergeCategories(months, (m) => m.spendingByCategory)) add("spending", { category: c.category }, c.cents);
  for (const c of mergeCategories(months, (m) => m.incomeByCategory)) add("income", { category: c.category }, c.cents);
  for (const c of mergeCategories(months, (m) => m.externalByCategory)) add("external", { category: c.category }, c.cents);
  for (const x of mergeMerchants(months)) add("spending", { merchantKey: x.key }, x.cents);
  for (const x of mergeMerchants(months, (m) => m.payers)) add("income", { merchantKey: x.key }, x.cents);
  return out;
}
