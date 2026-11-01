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

// ---------------------------------------------------------------- what the tabs pick out

/** A month's drill: the merchants that paid back more than they charged, and its twelve biggest. */
export function monthDrillMerchants(m: SpendingMonth): { credits: MerchantMonth[]; top: MerchantMonth[] } {
  return { credits: m.merchants.filter((x) => x.cents < 0).sort((a, b) => a.cents - b.cents), top: m.merchants.filter((x) => x.cents > 0).slice(0, 12) };
}

/** Income › Who pays you: the fifteen biggest payers over the months. */
export const topPayers = (months: SpendingMonth[]) => mergeMerchants(months, (m) => m.payers).slice(0, 15);

/** Merchants › Went quiet: charged in at least three of the twelve months before the range (`recent`), none in it; the ten biggest. */
export function quietMerchants(recent: SpendingMonth[], inRange: SpendingMonth[]): MerchantTotal[] {
  const keys = new Set(mergeMerchants(inRange).map((m) => m.key));
  return mergeMerchants(recent)
    .filter((m) => m.months >= 3 && !keys.has(m.key))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 10);
}

/** Year over year's merchants: the ten that rose most and the ten that fell most, with what each spent either side. */
export function merchantMovers(now: SpendingMonth[], then: SpendingMonth[]) {
  const n = new Map(mergeMerchants(now).map((m) => [m.key, m]));
  const t = new Map(mergeMerchants(then).map((m) => [m.key, m]));
  const all = [...new Set([...n.keys(), ...t.keys()])].map((key) => ({ key, name: (n.get(key) ?? t.get(key))!.name, now: n.get(key)?.cents ?? 0, then: t.get(key)?.cents ?? 0 }));
  return {
    up: all.filter((m) => m.now - m.then > 0).sort((x, y) => y.now - y.then - (x.now - x.then)).slice(0, 10),
    down: all.filter((m) => m.now - m.then < 0).sort((x, y) => x.now - x.then - (y.now - y.then)).slice(0, 10),
  };
}

/**
 * What the tabs draw over one run of months: which totals (income, spending, saved), spending
 * less one-offs, which bands of spending, which spending categories (every one, or those
 * named), its outside-money categories, which merchants and which payers.
 */
export type WindowDraws = { totals: ("income" | "spending" | "net")[]; oneOffs: boolean; kinds: SpendingKind[]; categories: "all" | string[]; external: boolean; merchants: "all" | string[]; payers: string[] };

const NOTHING: WindowDraws = { totals: [], oneOffs: false, kinds: [], categories: [], external: false, merchants: [], payers: [] };
const TOTALS: WindowDraws["totals"] = ["income", "spending", "net"];
const union = <T,>(a: "all" | T[], b: "all" | T[] | undefined): "all" | T[] => (a === "all" || b === "all" ? "all" : [...new Set([...a, ...(b ?? [])])]);
const ALL_KINDS: SpendingKind[] = ["bill", "big", "everyday"];

function mergeDraws(a: WindowDraws, b: Partial<WindowDraws>): WindowDraws {
  return {
    totals: [...new Set([...a.totals, ...(b.totals ?? [])])],
    oneOffs: a.oneOffs || !!b.oneOffs,
    kinds: [...new Set([...a.kinds, ...(b.kinds ?? [])])],
    categories: union(a.categories, b.categories),
    external: a.external || !!b.external,
    merchants: union(a.merchants, b.merchants),
    payers: [...new Set([...a.payers, ...(b.payers ?? [])])],
  };
}

/**
 * Every run of months a tab sums a figure over (cashFlowWindows), with what the tabs draw
 * over it, on the page's default view (no account filter, a preset range), from the same
 * pickers the tabs use:
 *  - each month: Overview's month rows and the month's drill (totals, one-offs, bands,
 *    categories, its credits and biggest merchants), Spending's month cells, Budget's latest;
 *  - each preset range: every tab (all of it: every merchant, as Merchants lists them; the
 *    payers Income lists; outside money by category);
 *  - the run before it: Overview's and Spending's comparisons (income and spending, and each
 *    category the range has too);
 *  - the twelve months before it: Merchants' merchants that went quiet;
 *  - each calendar year: Year over year's year table (totals, bands, categories);
 *  - each side of a year-over-year comparison: its totals, everyday spending, categories and the merchants that moved most;
 *  - Trends: the trailing twelve months (totals, everyday spending), the last three (everyday
 *    spending), and momentum's two runs (categories).
 */
export function cashFlowWindowDraws(r: Pick<SpendingReport, "months">): { months: SpendingMonth[]; draws: WindowDraws }[] {
  const all = r.months;
  if (!all.length) return [];
  const byKey = new Map<string, { months: SpendingMonth[]; draws: WindowDraws }>();
  const add = (months: SpendingMonth[], d: Partial<WindowDraws>) => {
    if (!months.length) return;
    const k = `${months[0]!.start}/${months.at(-1)!.end}`;
    const cur = byKey.get(k);
    byKey.set(k, { months, draws: mergeDraws(cur?.draws ?? NOTHING, d) });
  };
  for (const m of all) {
    const { credits, top } = monthDrillMerchants(m);
    add([m], { totals: TOTALS, oneOffs: true, kinds: ALL_KINDS, categories: "all", merchants: [...credits, ...top].map((x) => x.key) });
  }
  const hi = all.length - 1;
  for (const range of PRESET_RANGES) {
    const s = sliceRange(r, range, { from: "", to: "" });
    const lo = sliceStart(r, s);
    add(s.months, { totals: TOTALS, oneOffs: true, kinds: ALL_KINDS, categories: "all", external: true, merchants: "all", payers: topPayers(s.months).map((x) => x.key) });
    add(s.prior, { totals: ["income", "spending"], categories: mergeCategories(s.months, (m) => m.spendingByCategory).map((c) => c.category) });
    const recent = all.slice(Math.max(0, lo - 12), lo);
    add(recent, { merchants: quietMerchants(recent, s.months).map((x) => x.key) });
  }
  for (const [, ms] of byYear(all)) add(ms, { totals: TOTALS, kinds: ALL_KINDS, categories: "all" });
  for (const mode of ["month", "ytd", "12m"] as const) {
    const y = yoyWindows(all, mode);
    if (y.missing.length) continue;
    const { up, down } = merchantMovers(y.now, y.then);
    add(y.now, { totals: TOTALS, kinds: ["everyday"], categories: "all", merchants: [...up, ...down].filter((x) => x.now).map((x) => x.key) });
    add(y.then, { totals: TOTALS, kinds: ["everyday"], categories: "all", merchants: [...up, ...down].filter((x) => x.then).map((x) => x.key) });
  }
  const m = momentumWindows(all, hi);
  add(last12At(all, hi), { totals: ["income", "spending"], kinds: ["everyday"] });
  add(all.slice(Math.max(0, hi - 2), hi + 1), { kinds: ["everyday"] });
  add(m.recent, { categories: "all" });
  add(m.before, { categories: "all" });
  return [...byKey.values()];
}

/** One figure over a run of months: its recipe and the total the page shows. */
export type CashFlowFigure = { descriptor: CashFlowDescriptor; cents: number };

/**
 * The figures the tabs draw over one run of months (cashFlowWindowDraws), with the total
 * each shows: income, spending and saved; spending less one-offs; the bands of spending;
 * each category of spending and of outside money; and the merchants and payers drawn.
 */
export function windowFigures(months: SpendingMonth[], draws: WindowDraws): CashFlowFigure[] {
  const out: CashFlowFigure[] = [];
  const add = (metric: CashFlowMetric, o: CashFlowRecipe, cents: number) => out.push({ descriptor: cashFlowDescriptor(metric, months, undefined, o), cents });
  const income = sum(months, (m) => m.incomeCents);
  const spending = sum(months, (m) => m.spendingCents);
  const total = { income, spending, net: income - spending };
  for (const metric of draws.totals) add(metric, {}, total[metric]);
  if (draws.oneOffs) add("spending", { excludeOneOffs: true }, spending - sum(months, (m) => m.oneOffCents));
  for (const k of draws.kinds) add("spending", { spendingKind: k }, sum(months, (m) => m.kinds[KIND_FIELD[k]]));
  for (const c of mergeCategories(months, (m) => m.spendingByCategory)) if (draws.categories === "all" || draws.categories.includes(c.category)) add("spending", { category: c.category }, c.cents);
  if (draws.external) for (const c of mergeCategories(months, (m) => m.externalByCategory)) add("external", { category: c.category }, c.cents);
  const merchants = mergeMerchants(months);
  if (draws.merchants === "all") for (const x of merchants) add("spending", { merchantKey: x.key }, x.cents);
  else {
    // A month's credits (a merchant that paid back more than it charged) as well as what it charged.
    const cents = new Map([...merchants.map((x) => [x.key, x.cents] as const), ...(months.length === 1 ? months[0]!.merchants.filter((x) => x.cents < 0).map((x) => [x.key, x.cents] as const) : [])]);
    for (const k of draws.merchants) if (cents.has(k)) add("spending", { merchantKey: k }, cents.get(k)!);
  }
  const payers = new Map(mergeMerchants(months, (m) => m.payers).map((x) => [x.key, x.cents]));
  for (const k of draws.payers) if (payers.has(k)) add("income", { merchantKey: k }, payers.get(k)!);
  return out;
}
