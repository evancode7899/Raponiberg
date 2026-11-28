import { describe, expect, it } from "vitest";
import { defaultInputs, homePatchFor, normalizeMortgageInputs, sharedWithHome } from "./inputs";

const home = { budgetHomePrice: 800_000, budgetDownPaymentPct: 0.25, annualMortgageRate: 0.065, mortgageTermYears: 30, annualPropertyTaxRate: 0.02 };

describe("one Home & mortgage scenario", () => {
  it("runs Prepay vs invest on Test a price's loan while it follows it", () => {
    const m = sharedWithHome(defaultInputs(), home);
    expect([m.principal, m.rate, m.termYears, m.propertyTax]).toEqual([600_000, 0.065, 30, 16_000]);
    // A loan of its own keeps its own numbers.
    expect(sharedWithHome({ ...defaultInputs(), followHome: false }, home).principal).toBe(defaultInputs().principal);
    expect(normalizeMortgageInputs({ followHome: false }).followHome).toBe(false);
  });

  it("stores a change to a shared input in the scenario, so every tab reads it", () => {
    const p = homePatchFor({ principal: 640_000, rate: 0.06 }, home);
    expect(p.budgetDownPaymentPct).toBeCloseTo(0.2, 12);
    expect(p.annualMortgageRate).toBe(0.06);
    expect(homePatchFor({ propertyTax: 12_000 }, home)).toEqual({ annualPropertyTaxRate: 0.015 });
  });
});
