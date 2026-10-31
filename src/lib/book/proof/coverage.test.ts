import { describe, expect, it } from "vitest";
import { proofTarget, type Report } from "@/app/cash-flow/model";
import { cashFlowDerived, categoryKey, merchantKeyOf, windowKey } from "../derived/cashFlow";
import { derivedTarget, type DerivedFigure } from "../derived/types";
import { isUnswept } from "./clearance";
import { last12At, momentumWindows, PRESET_RANGES, sliceRange, sliceStart, yoyWindows, byYear, type CashFlowRecipe } from "../reports/cashFlowWindows";
import type { SpendingMonth } from "../reports/spending";
import { cashFlowWindowFigures, derivedFigures } from "./figures";
import { descriptorKey } from "./key";
import type { CashFlowMetric } from "./cashFlowProof";

/**
 * Swept = rendered: on an invented household's report, every recipe the Cash flow tabs
 * build (through the page's own proofTarget and derivedTarget) is one the proof sweep
 * enumerates (figures.ts). A tab that sums over a run of months the sweep doesn't know
 * fails here, before it can render a figure the sweep never cleared.
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
  it("enumerates every recipe the tabs build over every window they show", () => {
    const missing: string[] = [];
    const want = (k: string) => swept.has(k) || missing.push(k);
    for (const ms of renderedWindows()) {
      for (const metric of ["income", "spending", "net", "external"] as const) want(key(metric, ms, {}));
      want(key("spending", ms, { excludeOneOffs: true }));
      for (const spendingKind of ["bill", "big", "everyday"] as const) want(key("spending", ms, { spendingKind }));
      for (const c of new Set(ms.flatMap((m) => m.spendingByCategory.map((x) => x.category)))) want(key("spending", ms, { category: c }));
      for (const c of new Set(ms.flatMap((m) => m.externalByCategory.map((x) => x.category)))) want(key("external", ms, { category: c }));
      for (const x of new Set(ms.flatMap((m) => m.merchants.map((y) => y.key)))) want(key("spending", ms, { merchantKey: x }));
      for (const x of new Set(ms.flatMap((m) => m.payers.map((y) => y.key)))) want(key("income", ms, { merchantKey: x }));
    }
    // Recurring: each recurring merchant's charges over the twelve months to the end.
    for (const c of report.recurring) want(key("spending", report.months, { merchantKey: c.key, charges: true }));
    expect(missing).toEqual([]);
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

  it("withholds a figure the list doesn't have, rather than showing it", () => {
    expect(isUnswept(derivedTarget("cash-flow", derived, "savings-rate", "1999-01-01/1999-01-31"))).toBe(true);
  });
});
