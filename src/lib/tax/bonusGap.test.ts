import { describe, expect, it } from "vitest";
import { bonusChecksOf, bonusGaps } from "./bonusGap";

// Invented stubs: a regular check, an all-bonus check, and a combined one.
const stub = (payDate: string, lines: [string, number][]) => ({ payDate, lines: lines.map(([kind, current]) => ({ kind, current })) });
const stubs = [
  stub("2026-02-13", [["REGULAR", 8_000_00], ["FEDERAL_TAX", 1_500_00]]),
  stub("2026-03-06", [["BONUS", 20_000_00], ["FEDERAL_TAX", 4_400_00]]),
  stub("2026-06-12", [["REGULAR", 8_000_00], ["BONUS", 5_000_00], ["FEDERAL_TAX", 2_600_00]]),
];

describe("bonus withholding, check by check", () => {
  it("keeps bonus checks only, with a stub's withholding where the check was all bonus, then the forecast's", () => {
    const checks = bonusChecksOf(stubs, [{ label: "Year-end bonus", gross: 30_000_00, date: "2026-12-18" }]);
    expect(checks.map((c) => [c.payDate, c.grossCents, c.federalWithheldCents, c.source])).toEqual([
      ["2026-03-06", 20_000_00, 4_400_00, "STUB"],
      ["2026-06-12", 5_000_00, null, "STUB"],
      ["2026-12-18", 30_000_00, null, "FORECAST"],
    ]);
  });

  it("compares each with the year's rate on the next dollar", () => {
    const rows = bonusGaps(bonusChecksOf(stubs, []), 0.32);
    expect(rows.map((r) => [r.withheldCents, r.withheldFrom, r.atRateCents, r.gapCents])).toEqual([
      [4_400_00, "STUB", 6_400_00, 2_000_00],
      [1_100_00, "SUPPLEMENTAL_RATE", 1_600_00, 500_00],
    ]);
  });

  it("has nothing without a bonus", () => {
    expect(bonusChecksOf([stubs[0]!], [])).toEqual([]);
    expect(bonusGaps([], 0.24)).toEqual([]);
  });
});
