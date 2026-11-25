import { describe, expect, it } from "vitest";
import { sliceRange } from "./cashFlowWindows";
import type { SpendingMonth } from "./spending";

/** `n` months ending June 2026, numbered by how far back they are. */
const months = (n: number): { months: SpendingMonth[] } => ({
  months: Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 5 - (n - 1 - i), 1));
    const start = d.toISOString().slice(0, 10);
    return { start, end: start, label: start.slice(0, 7) } as SpendingMonth;
  }),
});
const custom = { from: "", to: "" };
const labels = (ms: SpendingMonth[]) => [ms[0]?.label, ms.at(-1)?.label, ms.length];

describe("what a range is compared with", () => {
  it("is the same months a year earlier when they're on file", () => {
    const s = sliceRange(months(30), "3m", custom);
    expect(labels(s.months)).toEqual(["2026-04", "2026-06", 3]);
    expect(labels(s.prior)).toEqual(["2025-04", "2025-06", 3]);
    expect(s.priorLabel).toBe("the same months a year earlier");
    expect(labels(sliceRange(months(30), "ytd", custom).prior)).toEqual(["2025-01", "2025-06", 6]);
    expect(labels(sliceRange(months(30), "12m", custom).prior)).toEqual(["2024-07", "2025-06", 12]);
  });

  it("falls back to as many months just before", () => {
    const s = sliceRange(months(10), "3m", custom);
    expect(labels(s.prior)).toEqual(["2026-01", "2026-03", 3]);
    expect(s.priorLabel).toBe("the 3 months before");
  });

  it("is nothing rather than fewer months than the range holds", () => {
    const s = sliceRange(months(18), "12m", custom);
    expect(s.prior).toEqual([]);
    expect(s.priorLabel).toBe("");
    expect(sliceRange(months(18), "all", custom).prior).toEqual([]);
  });

  it("says month for one", () => {
    expect(sliceRange(months(30), "custom", { from: "2026-03", to: "2026-03" }).priorLabel).toBe("the same month a year earlier");
  });

  it("never compares with a different number of months", () => {
    for (let n = 1; n <= 40; n++)
      for (const range of ["3m", "6m", "12m", "ytd", "all"] as const) {
        const s = sliceRange(months(n), range, custom);
        expect([0, s.months.length], `${n} ${range}`).toContain(s.prior.length);
      }
  });
});
