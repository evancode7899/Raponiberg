import { describe, expect, it } from "vitest";
import { leanReport, merchantsOf, withMerchants } from "./cashFlowParts";
import type { SpendingMonth } from "./book/reports/spending";

const month = (start: string, n: number) => ({ start, merchants: Array.from({ length: n }, (_, i) => ({ key: `M${i}`, name: `Example Shop ${i}`, cents: 100 * (i + 1) })), payers: [] }) as unknown as SpendingMonth;

describe("cash flow's payload in parts", () => {
  it("leaves the merchant lists out, and puts them back value for value", () => {
    const full = { months: [month("2026-01-01", 3), month("2026-02-01", 1)], current: month("2026-03-01", 2) };
    const lean = leanReport(full);
    expect(lean.months.every((m) => m.merchants.length === 0)).toBe(true);
    expect(JSON.stringify(withMerchants(lean, merchantsOf(full)).months)).toBe(JSON.stringify(full.months));
    expect(withMerchants(lean, merchantsOf(full)).current).toEqual(full.current);
  });
});
