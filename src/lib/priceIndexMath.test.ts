import { describe, expect, it } from "vitest";
import { cpiYearOf, realYears } from "./book/derived/cashFlow";
import type { SpendingMonth } from "./book/reports/spending";
import { addMonths, indexChange, latestAtOrBefore, yearAverage, yearChange, type IndexSeries } from "./priceIndexMath";

// An invented series: 100 in Jan 2025, up 1 a month, published through Mar 2026.
const months: Record<string, number> = {};
for (let i = 0; i < 15; i++) months[addMonths("2025-01", i)] = 100 + i;
const s: IndexSeries = { name: "Invented", source: "", url: "", fetchedOn: "2026-04-15", kind: "price", months };
const month = (start: string, spendingCents: number) => ({ start: `${start}-01`, spendingCents }) as unknown as SpendingMonth;

describe("price series", () => {
  it("steps months across a year end, and finds the latest published month", () => {
    expect(addMonths("2025-11", 3)).toBe("2026-02");
    expect(addMonths("2026-01", -13)).toBe("2024-12");
    expect(latestAtOrBefore(s, "2026-06")).toBe("2026-03");
    expect(latestAtOrBefore(s, "2024-06")).toBeNull();
  });

  it("changes from month to month, nothing guessed for a month missing", () => {
    expect(indexChange(s, "2025-01", "2025-11")!.change).toBeCloseTo(0.1, 12);
    expect(indexChange(s, "2024-12", "2025-11")).toBeNull();
    expect(yearChange(s, "2026-06")).toMatchObject({ from: "2025-03", to: "2026-03" });
    expect(yearAverage(s, 2025)).toBeCloseTo(105.5, 12);
    expect(yearAverage(s, 2026)).toBeNull();
  });

  it("puts each year's spending in the latest CPI month's dollars, month by month", () => {
    const rep = { months: [month("2025-01", 1_000_00), month("2025-02", 1_000_00), month("2026-02", 500_00)], cpi: s };
    const r = realYears(rep);
    expect(r.map((x) => [x.year, x.to, x.cents])).toEqual([
      [2025, "2026-02", Math.round(1_000_00 * (113 / 100) + 1_000_00 * (113 / 101))],
      [2026, "2026-02", 500_00],
    ]);
    expect(cpiYearOf(rep)).toMatchObject({ from: "2025-02", to: "2026-02" });
    expect(realYears({ months: rep.months, cpi: null })).toEqual([]);
    expect(realYears({ months: [month("2024-06", 1_00)], cpi: s })).toEqual([]);
  });
});
