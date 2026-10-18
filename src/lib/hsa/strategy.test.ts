import { describe, expect, it } from "vitest";
import { hsaAfterTax, strategyRows, taxableAfterTax, type StrategyAssumptions } from "./strategy.ts";

const base: StrategyAssumptions = { rate: 0.07, dividendYield: 0, taxableRate: 0.2, marginalRate: 0.3, payrollRate: 0, growthCovered: true, exitRate: 0.3, years: 20 };
const grown = Math.pow(1.07, 20); // 3.8697

describe("taxableAfterTax", () => {
  it("taxes only the gain, once, at the sale when nothing is paid out", () => {
    expect(taxableAfterTax(base, 20)).toBeCloseTo(grown - 0.2 * (grown - 1), 6); // 3.2957
  });
  it("is the whole return with no tax", () => {
    expect(taxableAfterTax({ ...base, dividendYield: 0.015, taxableRate: 0 }, 20)).toBeCloseTo(grown, 6);
  });
  it("taxes every year when the whole return is dividends, leaving no gain at the sale", () => {
    expect(taxableAfterTax({ ...base, dividendYield: 0.07 }, 20)).toBeCloseTo(Math.pow(1 + 0.07 * 0.8, 20), 6);
  });
  it("is worth less with dividends than without (tax paid sooner)", () => {
    expect(taxableAfterTax({ ...base, dividendYield: 0.015 }, 20)).toBeLessThan(taxableAfterTax(base, 20));
  });
});

describe("hsaAfterTax", () => {
  it("is tax-free when later bills cover the growth, taxed on the growth alone when not", () => {
    expect(hsaAfterTax(base, 20)).toBeCloseTo(grown, 6);
    expect(hsaAfterTax({ ...base, growthCovered: false }, 20)).toBeCloseTo(1 + (grown - 1) * 0.7, 6);
  });
});

describe("strategyRows", () => {
  const [now, later] = strategyRows(base, 100_000, 2046);
  const F = grown - 0.2 * (grown - 1);

  it("has just the two ways, each costing the same $1,000 of take-home today", () => {
    expect(strategyRows(base, 100_000, 2046)).toHaveLength(2);
    expect(now).toMatchObject({ key: "NOW", fromHsaCents: 100_000, fromBankCents: 0, taxableNowCents: 100_000, hsaNowCents: 0, aheadCents: 0 });
    expect(later).toMatchObject({ key: "LATER", fromHsaCents: 0, fromBankCents: 100_000, taxableNowCents: 0, hsaNowCents: 100_000 });
    expect(now!.fromBankCents + now!.taxableNowCents).toBe(later!.fromBankCents + later!.taxableNowCents);
  });

  it("grows paying now's $1,000 in a taxable account and waiting's in the HSA", () => {
    expect(now!.worthCents).toBe(Math.round(100_000 * F));
    expect(later!.worthCents).toBe(Math.round(100_000 * grown));
  });

  it("puts waiting ahead by the taxable account's tax on the $1,000's growth, nothing more", () => {
    expect(later!.aheadCents).toBe(later!.worthCents - now!.worthCents);
    expect(later!.aheadCents).toBeCloseTo(0.2 * (grown - 1) * 100_000, -1); // ≈ $574
  });

  it("ignores income and payroll tax: the HSA is maxed either way", () => {
    const [, l2] = strategyRows({ ...base, marginalRate: 0.45, payrollRate: 0.0765 }, 100_000, 2046);
    expect(l2!.aheadCents).toBe(later!.aheadCents);
  });

  it("gives waiting no edge with no time to grow, or when the taxable account isn't taxed", () => {
    expect(strategyRows({ ...base, years: 0 }, 100_000, 2026)[1]!.aheadCents).toBe(0);
    expect(strategyRows({ ...base, taxableRate: 0 }, 100_000, 2046)[1]!.aheadCents).toBeCloseTo(0, -1);
  });

  it("makes waiting a loss when the growth isn't covered and comes out at more than the taxable rate", () => {
    const [, laterU] = strategyRows({ ...base, growthCovered: false }, 100_000, 2046);
    expect(laterU!.aheadCents).toBeCloseTo((0.2 - 0.3) * (grown - 1) * 100_000, -1); // ≈ −$287
  });
});
