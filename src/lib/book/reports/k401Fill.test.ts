import { describe, expect, it } from "vitest";
import { k401Fill, k401Pace } from "./taxAccounts";

// Invented stubs: 401(k) of $1,000 pre-tax and $250 Roth each paycheck.
const stub = (payDate: string, pre = 1_000_00, roth = 250_00) => ({ payDate, lines: [{ kind: "REGULAR", current: 8_000_00 }, { kind: "RETIREMENT_PRETAX", current: pre }, { kind: "RETIREMENT_ROTH", current: roth }] });

describe("401(k) by paycheck", () => {
  it("adds each stub's deferrals by pay date, then the paychecks left, stopping at the limit", () => {
    const f = k401Fill([stub("2026-02-13"), stub("2026-01-30")], ["2026-02-27", "2026-03-13", "2026-03-27"], { retirementPretax: 1_000_00, retirementRoth: 250_00 }, 4_500_00);
    expect(f).toEqual([
      { date: "2026-01-30", cents: 1_250_00, projected: false },
      { date: "2026-02-13", cents: 2_500_00, projected: false },
      { date: "2026-02-27", cents: 3_750_00, projected: true },
      { date: "2026-03-13", cents: 4_500_00, projected: true },
      { date: "2026-03-27", cents: 4_500_00, projected: true },
    ]);
    expect(k401Fill([], ["2026-02-27"], null, 4_500_00)).toEqual([]);
  });

  it("spreads the limit evenly over the year", () => {
    expect(k401Pace(36_500_00, "2026-01-01").evenCents).toBe(100_00);
    expect(k401Pace(36_500_00, "2026-12-31").evenCents).toBe(36_500_00);
    expect(k401Pace(36_600_00, "2028-02-29").evenCents).toBe(60 * 100_00);
  });
});
