import { describe, expect, it } from "vitest";
import { contributions } from "./contributions";

describe("contribution to change", () => {
  it("adds up to the change, each part's share of it summing to one", () => {
    const c = contributions(
      [
        { key: "a", now: 500_00, then: 300_00 },
        { key: "b", now: 100_00, then: 200_00 },
        { key: "c", now: 50_00, then: 0 },
      ],
      { now: 650_00, then: 500_00 },
    );
    expect(c.rows.map((r) => r.change)).toEqual([200_00, -100_00, 50_00]);
    expect(c.rest).toBe(0);
    expect(c.rows.reduce((s, r) => s + r.share!, 0)).toBeCloseTo(1, 12);
    expect(c.total.change).toBe(150_00);
  });

  it("keeps what the parts' own rounding leaves as a row of its own", () => {
    const c = contributions([{ key: "a", now: 100_01, then: 50_00 }], { now: 100_03, then: 49_99 });
    expect(c.rows[0]!.change + c.rest).toBe(c.total.change);
    expect(c.rest).toBe(3);
  });

  it("says no share when the total barely moved, and handles nothing at all", () => {
    expect(contributions([{ key: "a", now: 10_00, then: 0 }, { key: "b", now: 0, then: 9_50 }], { now: 10_00, then: 9_50 }).rows.map((r) => r.share)).toEqual([null, null]);
    expect(contributions([], { now: 0, then: 0 })).toEqual({ rows: [], total: { now: 0, then: 0, change: 0 }, rest: 0 });
  });
});
