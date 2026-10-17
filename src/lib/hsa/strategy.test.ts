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
  const [none, now, later] = strategyRows(base, 100_000, 2046);
  const F = grown - 0.2 * (grown - 1);

  it("costs the bill's pay without an HSA, the contribution with one, and both when paying out of pocket", () => {
    expect(none).toMatchObject({ payNowCents: 142_857, costNowCents: 100_000, taxSavedCents: 0, hsaLaterCents: 0, aheadCents: 0 });
    expect(now).toMatchObject({ payNowCents: 100_000, costNowCents: 70_000, taxSavedCents: 30_000, hsaLaterCents: 0 });
    expect(later).toMatchObject({ payNowCents: 242_857, costNowCents: 170_000, taxSavedCents: 30_000, hsaLaterCents: Math.round(100_000 * grown) });
  });

  it("counts the tax saved once, grown in the taxable account, in both HSA rows", () => {
    expect(now!.aheadCents).toBe(Math.round(30_000 * F));
    expect(later!.aheadCents).toBe(Math.round(-70_000 * F + 100_000 * grown));
  });

  it("puts waiting ahead of paying now by the taxable account's tax on the $1,000's growth, nothing more", () => {
    expect(later!.aheadCents - now!.aheadCents).toBeCloseTo(0.2 * (grown - 1) * 100_000, -1); // ≈ $574
  });

  it("gives waiting no edge with no time to grow, or when the taxable account isn't taxed", () => {
    const [, now0, later0] = strategyRows({ ...base, years: 0 }, 100_000, 2026);
    expect(later0!.aheadCents).toBe(now0!.aheadCents);
    const [, nowFree, laterFree] = strategyRows({ ...base, taxableRate: 0 }, 100_000, 2046);
    expect(laterFree!.aheadCents - nowFree!.aheadCents).toBeCloseTo(0, -1);
  });

  it("makes waiting a loss when the growth isn't covered and comes out at more than the taxable rate", () => {
    const [, nowU, laterU] = strategyRows({ ...base, growthCovered: false }, 100_000, 2046);
    expect(laterU!.aheadCents - nowU!.aheadCents).toBeCloseTo((0.2 - 0.3) * (grown - 1) * 100_000, -1); // ≈ −$287
  });

  it("adds payroll tax to what a contribution saves and to the pay a bank-paid bill takes", () => {
    const [noneP, nowP] = strategyRows({ ...base, payrollRate: 0.0145 }, 100_000, 2046);
    expect(nowP!.taxSavedCents).toBe(31_450);
    expect(noneP!.payNowCents).toBe(Math.round(100_000 / (1 - 0.3145)));
  });
});
