import { describe, expect, it } from "vitest";
import { keepOrReplace } from "./keepReplace";
import { COST_LINES, type MonthRow } from "./report";

const month = (i: number, fuel: number, repair: number, depreciation = 30_000): MonthRow => {
  const lines = Object.fromEntries(COST_LINES.map((l) => [l, 0])) as MonthRow["lines"];
  Object.assign(lines, { FUEL: fuel, REPAIR: repair, DEPRECIATION: depreciation, INTEREST: 5_000 });
  const m = `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
  return { month: m, label: m, miles: 1000, lines, plannedDepreciation: depreciation, marketDepreciation: null, total: 0, cash: 0, cumulativeTotal: 0, cumulativeMiles: 0 } as MonthRow;
};

describe("keep or replace", () => {
  it("adds each ownership year's running costs from the statement lines only, and sets the latest twelve months against the first year", () => {
    const months = [...Array.from({ length: 12 }, (_, i) => month(i, 10_000, 0)), ...Array.from({ length: 18 }, (_, i) => month(12 + i, 10_000, 5_000))];
    const kr = keepOrReplace({ months });
    expect(kr.years.map((y) => [y.n, y.months, y.runningCents, y.upkeepCents])).toEqual([
      [1, 12, 120_000, 0],
      [2, 12, 180_000, 60_000],
      [3, 6, 90_000, 30_000],
    ]);
    expect(kr.compare).toMatchObject({ extraCents: 60_000, upkeepExtraCents: 60_000, change: 0.5 });
    expect(kr.years[0]!.perMile).toBe(10);
  });

  it("waits for two years of ownership before comparing", () => {
    expect(keepOrReplace({ months: Array.from({ length: 20 }, (_, i) => month(i, 10_000, 0)) }).compare).toBeNull();
  });
});
