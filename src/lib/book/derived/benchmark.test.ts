import { describe, expect, it } from "vitest";
import type { NetWorthReport } from "../reports/netWorth";
import { benchmarkOf } from "./netWorth";

// Invented: three months of portfolio returns, and a benchmark from the month before.
const period = (start: string, r: number) => ({ start, household: { portfolioReturn: r } });
const rep = (months: Record<string, number>) =>
  ({
    proven: { returns: { portfolio: { from: "2026-01-01" } } },
    periods: [period("2026-01-01", 0.01), period("2026-02-01", 0.02), period("2026-03-01", -0.01)],
    benchmark: { name: "Invented index", source: "", url: "", fetchedOn: "2026-04-10", kind: "total-return", months },
  }) as unknown as NetWorthReport;

describe("against the benchmark", () => {
  it("chains the portfolio over the months the benchmark covers, from the level before the stretch", () => {
    const b = benchmarkOf(rep({ "2025-12": 100, "2026-01": 101, "2026-02": 104 }))!;
    expect(b).toMatchObject({ to: "2026-02", months: 2 });
    expect(b.benchmark).toBeCloseTo(0.04, 12);
    expect(b.portfolio).toBeCloseTo(1.01 * 1.02 - 1, 12);
  });

  it("is nothing when the benchmark doesn't reach back to the start", () => {
    expect(benchmarkOf(rep({ "2026-01": 101, "2026-02": 104 }))).toBeNull();
    expect(benchmarkOf({ ...rep({}), benchmark: null })).toBeNull();
  });
});
