import { describe, expect, it } from "vitest";
import { cashWaterfall } from "../../profile/annualMath";
import { payFlow, per100 } from "./payFlow";

// An invented year.
const year = (over: Partial<Parameters<typeof cashWaterfall>[0]> = {}) => ({
  year: 2025,
  asOf: "2025-12-31",
  cash: { waterfall: cashWaterfall({ salary: 200_000_00, bonus: 50_000_00, otherIncome: 1_000_00, withholding: 70_000_00, additionalTaxes: 5_000_00, refunds: 2_000_00, otherDeductions: 8_000_00, employer: 10_000_00, partnerKept: 0, living: 90_000_00, nonRecurring: 15_000_00, ...over }) },
}) as never;

describe("where a year's pay went", () => {
  it("has two sides equal to the cent, every band positive", () => {
    const f = payFlow(year())!;
    const sum = (bs: { cents: number }[]) => bs.reduce((s, b) => s + b.cents, 0);
    expect(sum(f.inflows)).toBe(sum(f.outflows));
    expect(f.outflows.map((b) => b.key)).toEqual(["taxes-deductions", "living", "one-offs", "saved"]);
    expect(f.outflows.find((b) => b.key === "taxes-deductions")!.cents).toBe(81_000_00);
    expect([...f.inflows, ...f.outflows].every((b) => b.cents > 0)).toBe(true);
    expect(per100(f, 81_000_00)).toBeCloseTo(81_000 / 251_000, 12);
  });

  it("turns a year that spent more than came in into savings drawn on", () => {
    const f = payFlow(year({ living: 300_000_00 }))!;
    expect(f.inflows.at(-1)).toMatchObject({ key: "drawn" });
    expect(f.outflows.some((b) => b.key === "saved")).toBe(false);
    expect(f.inflows.reduce((s, b) => s + b.cents, 0)).toBe(f.outflows.reduce((s, b) => s + b.cents, 0));
  });

  it("has nothing to draw without pay", () => {
    expect(payFlow({ year: 2025, asOf: "2025-12-31", cash: null } as never)).toBeNull();
    expect(payFlow(year({ salary: 0, bonus: 0, otherIncome: 0 }))).toBeNull();
  });
});
