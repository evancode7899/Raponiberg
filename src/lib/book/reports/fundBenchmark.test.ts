import { describe, expect, it } from "vitest";
import type { Holding } from "../../ingest/holdings/types";
import type { IncomeRow } from "../../tax/facts/investments";
import { benchmarkCandidates, fundBenchmark, isBroadUsIndex, type FundIncome, type FundSnapshot } from "./fundBenchmark";

// Pat Example's made-up brokerage at Example Securities: an invented total-market fund and two others.
const fund = (price: number, quantity: number): Holding => ({ symbol: "XTMKT", name: "EXAMPLE TOTAL STOCK MARKET INDEX FUND", kind: "FUND", quantity, price, valueCents: Math.round(price * quantity * 100), costBasisCents: null, expenseRatio: 0.0004 });
const intl: Holding = { symbol: "XINTL", name: "EXAMPLE TOTAL INTERNATIONAL STOCK INDEX", kind: "ETF", quantity: 10, price: 50, valueCents: 50_000, costBasisCents: null, expenseRatio: null };
const sp500 = (price: number): Holding => ({ symbol: null, name: "Example S&P 500 Index Trust", kind: "FUND", quantity: 5, price, valueCents: Math.round(price * 500), costBasisCents: null, expenseRatio: null });
const snap = (asOf: string, positions: Holding[], accountId = "acct-1", accountNumber = "••1234"): FundSnapshot => ({ documentId: `doc-${accountId}-${asOf}`, accountId, institution: "Example Securities", accountNumber, asOf, positions });
const income = (periodStart: string, periodEnd: string, rows: Partial<IncomeRow>[] = []): FundIncome => ({
  documentId: `tax-${periodEnd}`,
  institution: "Example Securities",
  accountNumber: "••1234",
  periodStart,
  periodEnd,
  incomeRows: rows.map((r) => ({ date: periodEnd, security: "EXAMPLE TOTAL STOCK MARKET INDEX FUND", cusip: "", kind: "DIVIDEND", amount: 0, nonQualified: false, moneyMarket: false, ...r })),
});

const snaps = [snap("2031-01-31", [fund(100, 20), intl]), snap("2031-02-28", [fund(102, 20), intl]), snap("2031-03-31", [fund(99, 20.2), intl])];

describe("isBroadUsIndex", () => {
  it("takes total-market and S&P 500 funds, by ticker or name, and nothing narrower", () => {
    expect(isBroadUsIndex(fund(1, 1))).toBe(true);
    expect(isBroadUsIndex(sp500(1))).toBe(true);
    expect(isBroadUsIndex({ symbol: "VTI", name: "Any name", kind: "ETF" })).toBe(true);
    expect(isBroadUsIndex(intl)).toBe(false);
    expect(isBroadUsIndex({ symbol: null, name: "EXAMPLE TOTAL BOND MARKET INDEX", kind: "FUND" })).toBe(false);
    expect(isBroadUsIndex({ symbol: "XTMKT", name: "EXAMPLE TOTAL STOCK MARKET", kind: "STOCK" })).toBe(false);
  });
});

describe("fundBenchmark", () => {
  it("chains each statement's price and the dividends a share since the one before, from 100", () => {
    // A $40.00 dividend on 20 shares in March: $2.00 a share.
    const b = fundBenchmark(snaps, [income("2031-02-01", "2031-02-28"), income("2031-03-01", "2031-03-31", [{ date: "2031-03-28", amount: 4_000 }])], null)!;
    expect(b.key).toBe("XTMKT");
    expect(b.series.kind).toBe("total-return");
    expect(b.series.months["2031-01"]).toBe(100);
    expect(b.series.months["2031-02"]).toBeCloseTo(102, 10);
    expect(b.series.months["2031-03"]).toBeCloseTo(102 * ((99 + 2) / 102), 10);
    expect(b.steps.map((s) => s.dividendCents)).toEqual([0, 4_000]);
  });

  it("is the price alone, and says so, when a step's dividends aren't on file", () => {
    const b = fundBenchmark(snaps, [income("2031-02-01", "2031-02-28")], null)!;
    expect(b.series.kind).toBe("price");
    expect(b.steps[1]!.dividendCents).toBeNull();
    expect(b.series.months["2031-03"]).toBeCloseTo(99, 10);
  });

  it("uses the owner's pick when it is held, else the fund priced in the most months", () => {
    const both = [...snaps.slice(0, 2).map((s) => ({ ...s, positions: [...s.positions, sp500(40)] }))];
    expect(benchmarkCandidates(both).map((c) => c.key)).toEqual(["EXAMPLE S&P 500 INDEX TRUST", "XTMKT"]);
    expect(fundBenchmark(both, [], "EXAMPLE S&P 500 INDEX TRUST")!.name).toBe("Example S&P 500 Index Trust");
    expect(fundBenchmark(both, [], "NOT HELD")!.key).toBe("EXAMPLE S&P 500 INDEX TRUST");
  });

  it("reads one account's statements, the one pricing the fund most often", () => {
    const other = [snap("2031-01-31", [fund(100, 1)], "acct-2", "••9999")];
    const b = fundBenchmark([...snaps, ...other], [], null)!;
    expect(b.steps.every((s) => s.documentId.startsWith("doc-acct-1"))).toBe(true);
  });

  it("is nothing without a broad index fund", () => {
    expect(fundBenchmark([snap("2031-01-31", [intl])], [], null)).toBeNull();
  });
});
