import { describe, expect, it } from "vitest";
import type { DividendCalendar } from "../reports/dividends";
import { divKey, dividendsDerived } from "./dividends";

const cal: DividendCalendar = {
  months: [
    { key: "2025-03", label: "Mar 2025", cents: 1500 },
    { key: "2025-04", label: "Apr 2025", cents: 0 },
  ],
  from: "2025-03-01",
  through: "2025-04-30",
  totalCents: 1500,
  securities: [
    { key: "acct|EXAMPLE INDEX FUND", security: "EXAMPLE INDEX FUND", accountId: "acct", accountName: "Brokerage ••1234", moneyMarket: false, byMonth: { "2025-03": 1500 }, totalCents: 1500, payments: [{ date: "2025-03-28", cents: 1000, documentId: "d1", statementId: "s1" }, { date: "2025-03-30", cents: 500, documentId: "d1", statementId: "s1" }], cadence: "yearly", next: "2026-03" },
  ],
};

describe("the dividend calendar's figures", () => {
  it("draws each cell, each security's year and each month from the statement's own rows", () => {
    const f = dividendsDerived(cal);
    const v = (k: string) => f.find((x) => x.key === k)?.value;
    expect(v(divKey("acct|EXAMPLE INDEX FUND", "2025-03"))).toEqual({ cents: 1500 });
    expect(v(divKey("acct|EXAMPLE INDEX FUND", "total"))).toEqual({ cents: 1500 });
    expect(v(divKey("all", "2025-03"))).toEqual({ cents: 1500 });
    expect(v(divKey("all", "total"))).toEqual({ cents: 1500 });
    // A month with nothing paid has no figure: the page draws a dash.
    expect(f.some((x) => x.key === divKey("all", "2025-04"))).toBe(false);
    expect(f.find((x) => x.key === divKey("acct|EXAMPLE INDEX FUND", "2025-03"))!.lines[0]!.link?.descriptor).toEqual({ report: "statement", statementId: "s1" });
  });
});
