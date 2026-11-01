import { describe, expect, it } from "vitest";
import { proofTarget, type Report } from "@/app/cash-flow/model";
import { cashFlowDerived, categoryKey, merchantKeyOf, paceKey, windowKey } from "../derived/cashFlow";
import { derivedTarget, type DerivedFigure } from "../derived/types";
import { isUnswept } from "./clearance";
import { last12At, merchantMovers, mergeCategories, monthDrillMerchants, momentumWindows, PRESET_RANGES, quietMerchants, sliceRange, sliceStart, topPayers, yoyWindows, byYear, type CashFlowRecipe } from "../reports/cashFlowWindows";
import type { SpendingMonth } from "../reports/spending";
import { cashFlowWindowFigures, derivedFigures } from "./figures";
import { descriptorKey } from "./key";
import type { CashFlowMetric } from "./cashFlowProof";

/**
 * Swept = rendered: on an invented household's report, every recipe the Cash flow tabs
 * build (through the page's own proofTarget and derivedTarget) is one the proof sweep
 * enumerates (figures.ts), and the sweep enumerates nothing else. A tab that sums over a
 * run of months the sweep doesn't know fails here, before it can render a figure the sweep
 * never cleared; so does a figure the sweep holds that no tab draws.
 */

// Pat Example's household, Jan 2029 – Feb 2031: made-up merchants and amounts.
const MERCHANTS = [
  { key: "CORNER GROCER", name: "Corner Grocer", category: "Groceries" },
  { key: "SPRINGFIELD POWER", name: "Springfield Power", category: "Housing & utilities" },
  { key: "EXAMPLE CAFE", name: "Example Cafe", category: "Dining" },
];
function month(i: number): SpendingMonth {
  const d = new Date(Date.UTC(2029, i, 1));
  const start = d.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(2029, i + 1, 0)).toISOString().slice(0, 10);
  const merchants = MERCHANTS.filter((_, k) => (i + k) % 3 !== 0).map((m, k) => ({ ...m, cents: 10_000 + 1_000 * k + 37 * i, count: 2 + k }));
  const spending = merchants.reduce((s, m) => s + m.cents, 0);
  const income = 500_000 + (i % 12 === 2 ? 200_000 : 0);
  const byCat = new Map<string, number>();
  for (const m of merchants) byCat.set(m.category, (byCat.get(m.category) ?? 0) + m.cents);
  return {
    label: d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
    start,
    end,
    through: null,
    incomeCents: income,
    spendingCents: spending,
    netCents: income - spending,
    savingsRate: (income - spending) / income,
    incomeByCategory: [{ category: "Paycheck", group: null, cents: income }],
    spendingByCategory: [...byCat].map(([category, cents]) => ({ category, group: null, cents })),
    externalByCategory: i % 4 ? [] : [{ category: "Transfer from partner", group: null, cents: 25_000 }],
    retirementEmployeeCents: 40_000,
    retirementEmployerCents: 20_000,
    blockers: [],
    unreviewed: { rows: 0, cents: 0 },
    merchants,
    payers: [{ key: "EXAMPLE EMPLOYER", name: "Example Employer", category: "Paycheck", cents: income, count: 2 }],
    oneOffCents: i % 5 ? 0 : 5_000,
    kinds: { billCents: merchants.find((m) => m.key === "SPRINGFIELD POWER")?.cents ?? 0, bigCents: 0, everydayCents: spending - (merchants.find((m) => m.key === "SPRINGFIELD POWER")?.cents ?? 0) },
    daily: { allCents: [], billCents: [], everydayCents: [] },
    chargeSizes: [],
  } as SpendingMonth;
}

const months = Array.from({ length: 26 }, (_, i) => month(i));
const report = {
  months,
  recurring: [{ key: "SPRINGFIELD POWER", name: "Springfield Power", category: "Housing & utilities", kind: "bill", cadence: "monthly", count: 24, monthsSeen: 24, typicalCents: 11_000, last12Cents: 130_000, annualCents: 132_000, active: true, changeCents: 500 }],
} as unknown as Report;

const swept = new Set(cashFlowWindowFigures(report).map((f) => descriptorKey(f.descriptor)));
const derived: DerivedFigure[] = cashFlowDerived(report);
const sweptDerived = new Set(derivedFigures("cash-flow", derived).map((f) => descriptorKey(f.descriptor)));

/** Every run of months a tab can sum over on the default view (each preset range). */
function renderedWindows(): SpendingMonth[][] {
  const all = report.months;
  const hi = all.length - 1;
  const out: SpendingMonth[][] = all.map((m) => [m]);
  for (const range of PRESET_RANGES) {
    const s = sliceRange(report, range, { from: "", to: "" });
    const lo = sliceStart(report, s);
    out.push(s.months, s.prior, all.slice(Math.max(0, lo - 12), lo));
  }
  for (const [, ms] of byYear(all)) out.push(ms);
  for (const mode of ["month", "ytd", "12m"] as const) {
    const y = yoyWindows(all, mode);
    if (!y.missing.length) out.push(y.now, y.then);
  }
  const m = momentumWindows(all, hi);
  out.push(last12At(all, hi), m.recent, m.before, all.slice(hi - 2, hi + 1));
  return out.filter((w) => w.length);
}

const key = (metric: CashFlowMetric, ms: SpendingMonth[], o: CashFlowRecipe) => {
  const t = proofTarget(metric, ms, undefined, { ...o, shownCents: 0 });
  if (isUnswept(t)) throw new Error("no recipe");
  return descriptorKey(t.descriptor);
};

describe("swept = rendered: Cash flow", () => {
  it("enumerates every recipe the tabs build over every window they show, and nothing else", () => {
    const drawn = new Set<string>();
    const draw = (metric: CashFlowMetric, ms: SpendingMonth[], o: CashFlowRecipe = {}) => ms.length && drawn.add(key(metric, ms, o));
    const cats = (ms: SpendingMonth[]) => mergeCategories(ms, (m) => m.spendingByCategory).map((c) => c.category);
    const all = report.months;
    const hi = all.length - 1;
    // Each month: Overview's rows, Spending's cells and the month's drill (its credits and twelve biggest merchants).
    for (const m of all) {
      for (const metric of ["income", "spending", "net"] as const) draw(metric, [m]);
      draw("spending", [m], { excludeOneOffs: true });
      for (const spendingKind of ["bill", "big", "everyday"] as const) draw("spending", [m], { spendingKind });
      for (const c of cats([m])) draw("spending", [m], { category: c });
      const { credits, top } = monthDrillMerchants(m);
      for (const x of [...credits, ...top]) draw("spending", [m], { merchantKey: x.key });
    }
    for (const range of PRESET_RANGES) {
      const s = sliceRange(report, range, { from: "", to: "" });
      const ms = s.months;
      // The range on every tab.
      for (const metric of ["income", "spending", "net"] as const) draw(metric, ms);
      draw("spending", ms, { excludeOneOffs: true });
      for (const spendingKind of ["bill", "big", "everyday"] as const) draw("spending", ms, { spendingKind });
      for (const c of cats(ms)) draw("spending", ms, { category: c });
      for (const c of mergeCategories(ms, (m) => m.externalByCategory)) draw("external", ms, { category: c.category });
      for (const x of new Set(ms.flatMap((m) => m.merchants.map((y) => y.key)))) draw("spending", ms, { merchantKey: x });
      for (const x of topPayers(ms)) draw("income", ms, { merchantKey: x.key });
      // The run before it: Overview's and Spending's comparisons.
      for (const metric of ["income", "spending"] as const) draw(metric, s.prior);
      const prior = new Set(cats(s.prior));
      for (const c of cats(ms)) if (prior.has(c)) draw("spending", s.prior, { category: c });
      // Merchants › went quiet, over the twelve months before it.
      const lo = sliceStart(report, s);
      const recent = all.slice(Math.max(0, lo - 12), lo);
      for (const x of quietMerchants(recent, ms)) draw("spending", recent, { merchantKey: x.key });
    }
    // Year over year: each calendar year, and each comparison's two sides.
    for (const [, ms] of byYear(all)) {
      for (const metric of ["income", "spending", "net"] as const) draw(metric, ms);
      for (const spendingKind of ["bill", "big", "everyday"] as const) draw("spending", ms, { spendingKind });
      for (const c of cats(ms)) draw("spending", ms, { category: c });
    }
    for (const mode of ["month", "ytd", "12m"] as const) {
      const y = yoyWindows(all, mode);
      if (y.missing.length) continue;
      const { up, down } = merchantMovers(y.now, y.then);
      for (const [ms, side] of [[y.now, "now"], [y.then, "then"]] as const) {
        for (const metric of ["income", "spending", "net"] as const) draw(metric, ms);
        draw("spending", ms, { spendingKind: "everyday" });
        for (const c of cats(ms)) draw("spending", ms, { category: c });
        for (const x of [...up, ...down]) if (x[side]) draw("spending", ms, { merchantKey: x.key });
      }
    }
    // Trends: the trailing twelve months, the last three, momentum's two runs.
    const m = momentumWindows(all, hi);
    for (const metric of ["income", "spending"] as const) draw(metric, last12At(all, hi));
    draw("spending", last12At(all, hi), { spendingKind: "everyday" });
    draw("spending", all.slice(hi - 2, hi + 1), { spendingKind: "everyday" });
    for (const ms of [m.recent, m.before]) for (const c of cats(ms)) draw("spending", ms, { category: c });
    // Recurring: each habit's charges over the twelve months to the end.
    for (const c of report.recurring.filter((x) => x.kind === "habit")) draw("spending", report.months, { merchantKey: c.key, charges: true });
    expect([...drawn].filter((k) => !swept.has(k))).toEqual([]);
    expect([...swept].filter((k) => !drawn.has(k))).toEqual([]);
  });

  it("enumerates every derived figure a tab asks for, at the key it asks with", () => {
    const missing: string[] = [];
    const want = (figure: string, k?: string) => {
      const t = derivedTarget("cash-flow", derived, figure, k);
      if (isUnswept(t)) return; // a dash, never a number: nothing to sweep
      if (!sweptDerived.has(descriptorKey(t.descriptor))) missing.push(`${figure} ${k ?? ""}`);
    };
    for (const ms of renderedWindows()) {
      for (const f of ["savings-rate", "retirement", "typical-income", "above-typical", "merchants", "top10-share", "avg-charge", "charges-per-month"]) want(f, windowKey(ms));
      for (const c of new Set(ms.flatMap((m) => m.spendingByCategory.map((x) => x.category)))) {
        want("category-typical", categoryKey(ms, "EXPENSE", c));
        want("category-share", categoryKey(ms, "EXPENSE", c));
      }
      for (const x of new Set(ms.flatMap((m) => m.merchants.map((y) => y.key)))) for (const f of ["merchant-count", "merchant-avg", "merchant-pattern"]) want(f, merchantKeyOf(ms, "EXPENSE", x));
    }
    for (const f of ["bills-monthly", "price-changes", "habits-monthly", "stopped"]) want(f);
    expect(missing).toEqual([]);
    // And the tabs ask for something on every window: a list key that matched nothing would hide here.
    expect(derivedTarget("cash-flow", derived, "savings-rate", windowKey(sliceRange(report, "12m", { from: "", to: "" }).months))).toHaveProperty("descriptor");
  });

  it("states every Patterns › pace figure the tab shows, at the tab's value (SSOT F4)", () => {
    // Daily series for each month and a month under way: made-up amounts, a quarter-total line on day 3 of some months.
    const withDays = (m: SpendingMonth, i: number, through: number | null): SpendingMonth => {
      const n = Number(m.end.slice(8, 10));
      const all = Array.from({ length: n }, (_, d) => (through != null && d >= through ? 0 : 1_000 + ((d * 37 + i * 11) % 900) + (d === 2 && i % 3 === 0 ? 45_000 : 0)));
      const everyday = all.map((x, d) => (d === 2 ? x - (i % 3 === 0 ? 45_000 : 0) : x));
      return { ...m, daily: { allCents: all, billCents: all.map((x, d) => x - everyday[d]!), everydayCents: everyday } };
    };
    const ms = months.map((m, i) => withDays(m, i, null));
    const current = { ...withDays(month(26), 26, 17), through: "2031-03-17" };
    const list = cashFlowDerived({ ...report, months: ms, current });
    const value = (figure: string, key: string) => {
      const t = derivedTarget("cash-flow", list, figure, key);
      if (isUnswept(t) || "noFigure" in t) throw new Error(`${figure} ${key} not listed`);
      return t.shownCents;
    };
    // As PatternsTab works them out: running totals, the month before by the same day, the median typical month.
    const cumulative = (xs: number[]) => {
      let run = 0;
      return xs.map((v) => (run += v));
    };
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const h = Math.floor(s.length / 2);
      return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
    };
    let checked = 0;
    // The tab draws the pace of the latest whole month and the month under way (derived/cashFlow.ts paceDerived).
    for (const [i, m, partial] of [[ms.length - 1, ms.at(-1)!, false] as const, [ms.length, current, true] as const])
      for (const basis of ["all", "everyday"] as const) {
        const days = (x: SpendingMonth) => (basis === "all" ? x.daily.allCents : x.daily.everydayCents);
        const cur = cumulative(days(m));
        const throughDay = partial ? 17 : cur.length;
        expect(value("pace-spent", paceKey(m, basis, throughDay))).toBe(cur[throughDay - 1]);
        const prev = ms[i - 1];
        if (prev) {
          const pc = cumulative(days(prev));
          expect(value("pace-spent", paceKey(prev, basis, partial ? throughDay : pc.length))).toBe(partial ? pc[Math.min(throughDay, pc.length) - 1] : pc.at(-1));
        }
        const hist = ms.slice(Math.max(0, i - 12), i).map((x) => cumulative(days(x)));
        if (hist.length) expect(value("pace-typical", paceKey(m, basis))).toBe(median(hist.map((c) => c[Math.min(30, c.length - 1)]!)));
        checked++;
      }
    expect(checked).toBe(4);
    // And the sweep enumerates them all.
    const swept = new Set(derivedFigures("cash-flow", list).map((f) => descriptorKey(f.descriptor)));
    for (const f of list.filter((x) => x.figure.startsWith("pace-"))) expect(swept.has(descriptorKey({ report: "derived", page: "cash-flow", figure: f.figure, key: f.key }))).toBe(true);
  });

  it("withholds a figure the list doesn't have, rather than showing it", () => {
    expect(isUnswept(derivedTarget("cash-flow", derived, "savings-rate", "1999-01-01/1999-01-31"))).toBe(true);
  });
});
