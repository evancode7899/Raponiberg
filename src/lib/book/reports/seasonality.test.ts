import { describe, expect, it } from "vitest";
import { yearEndDerived } from "../derived/cashFlow";
import { calendarYears, seasonBands, yearEndEstimate } from "./seasonality";
import type { SpendingMonth } from "./spending";

// Invented months: spending by year and month (null: not proven, left out of the report).
const months = (byYear: Record<number, (number | null)[]>): SpendingMonth[] =>
  Object.entries(byYear).flatMap(([y, vs]) =>
    vs.flatMap((v, i) => (v == null ? [] : [{ start: `${y}-${String(i + 1).padStart(2, "0")}-01`, label: `${y}-${i + 1}`, spendingCents: v, kinds: { everydayCents: v / 2 } } as unknown as SpendingMonth])),
  );
const f = (m: SpendingMonth) => m.spendingCents;
const year = (v: number) => Array.from({ length: 12 }, () => v);

describe("seasonality", () => {
  it("files months by calendar month, a month not proven left empty", () => {
    const y = calendarYears(months({ 2024: [1, null, 3] }));
    expect(y.get(2024)!.slice(0, 4).map((m) => m?.spendingCents ?? null)).toEqual([1, null, 3, null]);
  });

  it("bands each month by the same month in earlier years", () => {
    const b = seasonBands(months({ 2023: year(100), 2024: [300, ...year(200).slice(1)], 2025: [50] }), 2025, f);
    expect(b[0]).toEqual({ n: 2, low: 100, mid: 200, high: 300, years: [2023, 2024] });
    expect(seasonBands(months({ 2025: [50] }), 2025, f)[0]).toBeNull();
  });

  it("lands the year at its months so far plus each month left at its middle", () => {
    const e = yearEndEstimate(months({ 2023: year(100), 2024: year(300), 2025: [1_000, 1_000] }), f)!;
    expect([e.year, e.through, e.soFarCents]).toEqual([2025, 1, 2_000]);
    expect(e.rest).toHaveLength(10);
    expect(e.estimateCents).toBe(2_000 + 10 * 200);
    expect(e.alike).toEqual([
      { year: 2023, cents: 3_000 },
      { year: 2024, cents: 5_000 },
    ]);
  });

  it("estimates nothing for a year that's over, one with a gap, or months no earlier year has", () => {
    expect(yearEndEstimate([], f)).toBeNull();
    expect(yearEndEstimate(months({ 2024: year(1), 2025: year(2) }), f)).toBeNull();
    expect(yearEndEstimate(months({ 2024: year(1), 2025: [1, null, 3] }), f)).toBeNull();
    expect(yearEndEstimate(months({ 2024: [1, 1, 1], 2025: [1] }), f)).toBeNull();
    // A year that starts after January has no "so far".
    expect(yearEndEstimate(months({ 2024: year(1), 2025: [null, 2] }), f)).toBeNull();
  });

  it("states the estimate as one, its months left marked estimate, adding up", () => {
    const [d] = yearEndDerived(months({ 2024: year(300), 2025: [1_000] }));
    expect(d!.describes).toMatch(/^Estimate: .* not a proven figure$/);
    expect(d!.value).toEqual({ cents: 1_000 + 11 * 300 });
    expect(d!.lines.slice(1, -1).every((l) => l.source === "estimate" && l.op === "+")).toBe(true);
    const sum = d!.lines.slice(0, -1).reduce((s, l) => s + ("cents" in l.value ? l.value.cents : 0), 0);
    expect(sum).toBe(1_000 + 11 * 300);
  });
});
