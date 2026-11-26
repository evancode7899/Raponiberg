import { describe, expect, it } from "vitest";
import { bracketFill } from "./bracketFill";
import { bracketTax } from "./computeReturn";

// Invented bounds (cents) for six brackets.
const BOUNDS = [10_000_00, 40_000_00, 90_000_00, 180_000_00, 230_000_00, 575_000_00];

describe("bracket fill", () => {
  it("fills each bracket up to its bound, and the taxes add up to the bracket tax", () => {
    const s = bracketFill(100_000_00, BOUNDS);
    expect(s.map((x) => x.incomeCents)).toEqual([10_000_00, 30_000_00, 50_000_00, 10_000_00, 0, 0, 0]);
    expect(s.reduce((t, x) => t + x.incomeCents, 0)).toBe(100_000_00);
    expect(Math.round(s.reduce((t, x) => t + x.taxCents, 0))).toBe(bracketTax(100_000_00, BOUNDS));
    expect(s.at(-1)!.to).toBeNull();
  });

  it("fills nothing on no income, and the top bracket on a lot", () => {
    expect(bracketFill(0, BOUNDS).every((x) => x.incomeCents === 0)).toBe(true);
    expect(bracketFill(700_000_00, BOUNDS).at(-1)!.incomeCents).toBe(125_000_00);
  });
});
