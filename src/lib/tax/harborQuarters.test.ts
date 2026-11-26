import { describe, expect, it } from "vitest";
import type { TaxPaymentRow } from "./facts/payments";
import { harborQuarters } from "./harborQuarters";

// Invented: $40,000 required, $28,000 withheld over the year, one $2,000 estimate paid in May.
const pay = (date: string, amount: number, taxYear = 2026): TaxPaymentRow => ({ transactionId: date, date, amount, payee: "TAX", authority: "FEDERAL", attribution: { kind: "ESTIMATE", taxYear }, overridden: false, basis: "DATE" });
const sh = { requiredAnnualPayment: 40_000_00, withholding: 28_000_00, underDeMinimis: false };

describe("safe harbor quarter by quarter", () => {
  it("needs a quarter more each date, withholding counting evenly and estimates from the day paid", () => {
    const q = harborQuarters(sh, 2026, [pay("2026-05-02", 2_000_00), pay("2026-05-02", 9_999_00, 2025)], "FEDERAL", "2026-07-15");
    expect(q.map((x) => x.requiredCents)).toEqual([10_000_00, 20_000_00, 30_000_00, 40_000_00]);
    expect(q.map((x) => x.withheldCents)).toEqual([7_000_00, 14_000_00, 21_000_00, 28_000_00]);
    expect(q.map((x) => x.estimatesCents)).toEqual([0, 2_000_00, 2_000_00, 2_000_00]);
    expect(q.map((x) => x.shortCents)).toEqual([3_000_00, 4_000_00, 7_000_00, 10_000_00]);
    expect(q.map((x) => x.past)).toEqual([true, true, false, false]);
    expect(q[3]!.date.startsWith("2027-01")).toBe(true);
  });

  it("owes nothing under the de-minimis line, and is never short when paid ahead", () => {
    expect(harborQuarters({ ...sh, underDeMinimis: true }, 2026, [], "FEDERAL", "2026-01-01").every((x) => x.shortCents === 0 && x.requiredCents === 0)).toBe(true);
    expect(harborQuarters(sh, 2026, [pay("2026-01-10", 20_000_00)], "FEDERAL", "2026-01-01").every((x) => x.shortCents === 0)).toBe(true);
  });
});
