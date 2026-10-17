import { describe, expect, it } from "vitest";
import { TAX_YEARS } from "../tax/params";
import { gainsTaxRate, payTaxRate, type HomeTaxBasis } from "./homeTax";

// Invented household: two earners, no dependents.
const year = Math.max(...Object.keys(TAX_YEARS).map(Number));
const basis: HomeTaxBasis = { year, earners: [{ id: "a", name: "A", share: 0.6 }, { id: "b", name: "B", share: 0.4 }], dependents: [] };

describe("payTaxRate", () => {
  it("is a sensible all-in rate that rises with pay", () => {
    const low = payTaxRate(basis, 150_000)!;
    const high = payTaxRate(basis, 400_000)!;
    expect(low).toBeGreaterThan(0.15);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThan(0.45);
  });

  it("is null without earners or the law year", () => {
    expect(payTaxRate({ ...basis, earners: [] }, 200_000)).toBeNull();
    expect(payTaxRate({ ...basis, year: 1999 }, 200_000)).toBeNull();
  });
});

describe("gainsTaxRate", () => {
  it("adds NIIT and Connecticut to the federal rate at a high income", () => {
    // Federal 15–20% + 3.8% NIIT + CT's ordinary rate (around 6–7%).
    const r = gainsTaxRate(basis, 400_000, 100_000)!;
    expect(r).toBeGreaterThan(0.24);
    expect(r).toBeLessThan(0.32);
  });

  it("is lower at a modest income (no NIIT, 15% federal)", () => {
    expect(gainsTaxRate(basis, 120_000, 50_000)!).toBeLessThan(gainsTaxRate(basis, 400_000, 50_000)!);
  });
});
