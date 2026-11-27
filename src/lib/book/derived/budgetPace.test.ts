import { describe, expect, it } from "vitest";
import type { SpendingMonth } from "../reports/spending";
import { budgetPaceMonth, budgetRunning, cashFlowDerived } from "./cashFlow";

// An invented 30-day month: groceries on days 1 and 10, dining on day 5, travel (not budgeted) on day 2.
const days = (at: Record<number, number>) => Array.from({ length: 30 }, (_, d) => at[d + 1] ?? 0);
const month = (through: string | null): SpendingMonth =>
  ({
    label: "Jun 2026",
    start: "2026-06-01",
    end: through ?? "2026-06-30",
    through,
    daily: { allCents: days({ 1: 80_00, 2: 400_00, 5: 45_00, 10: 60_00 }), billCents: days({}), everydayCents: days({}) },
    dailyByCategory: { Groceries: days({ 1: 80_00, 10: 60_00 }), Dining: days({ 5: 45_00 }), Travel: days({ 2: 400_00 }) },
  }) as unknown as SpendingMonth;
const targets = { Groceries: 600_00, Dining: 300_00 };

describe("budget pace by day", () => {
  it("runs the budgeted categories only, day by day", () => {
    const run = budgetRunning(month(null), targets);
    expect(run[0]).toBe(80_00);
    expect(run[4]).toBe(125_00);
    expect(run[29]).toBe(185_00);
  });

  it("reads the month under way through its last day on file, and prorates the budget to it", () => {
    const cur = month("2026-06-06");
    expect(budgetPaceMonth({ months: [], current: cur })).toMatchObject({ day: 6, days: 30 });
    const d = cashFlowDerived({ months: [], recurring: [], current: cur }, targets);
    expect(d.find((x) => x.figure === "budget-pace" && x.key === "2026-06-01|6")).toMatchObject({ value: { cents: 125_00 } });
    expect(d.find((x) => x.figure === "budget-pace-plan" && x.key === "2026-06-01|6")).toMatchObject({ value: { cents: 180_00 } });
  });

  it("proves every day the chart draws: spending through each day on file, the even pace through every day of the month", () => {
    const d = cashFlowDerived({ months: [], recurring: [], current: month("2026-06-06") }, targets);
    expect(d.filter((x) => x.figure === "budget-pace").map((x) => x.key)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `2026-06-01|${n}`));
    expect(d.filter((x) => x.figure === "budget-pace-plan")).toHaveLength(30);
    expect(d.find((x) => x.figure === "budget-pace" && x.key === "2026-06-01|1")).toMatchObject({ value: { cents: 80_00 } });
  });

  it("has nothing without targets or without the month's category days", () => {
    expect(cashFlowDerived({ months: [], recurring: [], current: month("2026-06-06") }, {}).some((x) => x.figure.startsWith("budget-pace"))).toBe(false);
    const bare = { ...month(null), dailyByCategory: undefined } as SpendingMonth;
    expect(budgetPaceMonth({ months: [bare] })).toBeNull();
  });
});
