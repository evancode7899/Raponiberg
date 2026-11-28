import { describe, expect, it } from "vitest";
import { normalizeInsuranceNotes } from "./notes";
import { coverGap, DEFAULT_NEED_YEARS, type CoverNeed } from "./needMath";

const need = (o: Partial<CoverNeed> = {}): CoverNeed => ({
  years: 10,
  living: { monthlyCents: 500_000, months: 12, from: "2025-01-01", to: "2025-12-31" },
  balances: { asOf: "2025-12-31", assetsCents: 20_000_000, debtsCents: 5_000_000 },
  ...o,
});

describe("the coverage gap", () => {
  it("is years of living plus debts, less what the accounts hold, against the cover in force", () => {
    // 10 years × $60,000 + $50,000 debts − $200,000 held = $450,000 needed; $300,000 in force leaves $150,000 short.
    expect(coverGap(need(), 30_000_000)).toEqual({ livingCents: 60_000_000, neededCents: 45_000_000, gapCents: 15_000_000 });
    expect(coverGap(need(), 50_000_000)!.gapCents).toBe(-5_000_000);
  });

  it("never needs less than nothing, and says nothing while a part is withheld", () => {
    expect(coverGap(need({ balances: { asOf: "2025-12-31", assetsCents: 900_000_000, debtsCents: 0 } }), 0)).toMatchObject({ neededCents: 0, gapCents: 0 });
    expect(coverGap(need({ balances: null }), 0)).toBeNull();
    expect(coverGap(need({ living: null }), 0)).toBeNull();
  });

  it("keeps the owner's years within reason", () => {
    expect(normalizeInsuranceNotes({}).needYears).toBe(DEFAULT_NEED_YEARS);
    expect(normalizeInsuranceNotes({ needYears: 400 }).needYears).toBe(40);
    expect(normalizeInsuranceNotes({ needYears: 7.4 }).needYears).toBe(7);
  });
});
