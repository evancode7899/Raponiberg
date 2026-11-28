import { describe, expect, it } from "vitest";
import { chainReAdds } from "../book/proof/common";
import { needDerived, type InsuranceInput } from "../book/derived/insurance";
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

  it("draws a gap whose chain re-adds to it, short or covered", () => {
    // Only what the gap reads of a life policy: its status and death benefit.
    const life = (faceCents: number) => ({ status: "IN_FORCE", faceNowCents: faceCents, policy: { faceCents } }) as unknown as InsuranceInput["policies"][number];
    const gap = (faceCents: number) => needDerived({ policies: [life(faceCents)], homes: [], autos: [], through: "2025-12-31", need: need() }).find((f) => f.figure === "need-gap")!;
    // $450,000 needed: $300,000 in force is $150,000 short; $500,000 is $50,000 beyond the need.
    for (const [face, cents] of [[30_000_000, 15_000_000], [50_000_000, 5_000_000]] as const) {
      const f = gap(face);
      expect(f.value).toEqual({ cents });
      expect(chainReAdds(f.lines)).toEqual([]);
    }
  });
});
