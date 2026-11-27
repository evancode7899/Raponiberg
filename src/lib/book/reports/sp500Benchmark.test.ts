import { describe, expect, it } from "vitest";
import { extractEmpowerHoldings } from "../../ingest/holdings/empower";
import type { Holding } from "../../ingest/holdings/types";
import { isSp500Fund, isUnitTrust } from "../../investments/sp500";
import { quarterOf, quarterSpan, shiftQuarter, sp500Quarters, type Sp500Snapshot } from "./sp500Benchmark";

// Invented funds, accounts and amounts throughout.
const fund = (name: string, valueCents: number, quantity: number, extra: Partial<Holding> = {}): Holding => ({ symbol: null, name, kind: "FUND", quantity, price: null, valueCents, costBasisCents: null, expenseRatio: null, ...extra });
const snap = (asOf: string, positions: Holding[], accountId = "plan-a"): Sp500Snapshot => ({ documentId: `doc-${accountId}-${asOf}`, accountId, institution: "Example", accountNumber: accountId, asOf, positions });
const trust = "Example S&P 500 DC CIT";

describe("which holdings are the S&P 500", () => {
  it("knows S&P 500 funds by ticker or name, and not its style slices or options", () => {
    expect(isSp500Fund({ symbol: "VOO", name: "Example 500 ETF", kind: "ETF" })).toBe(true);
    expect(isSp500Fund({ symbol: null, name: trust, kind: "FUND" })).toBe(true);
    expect(isSp500Fund({ symbol: null, name: "Example Instl 500 Idx Tr", kind: "FUND" })).toBe(true);
    expect(isSp500Fund({ symbol: "SPYV", name: "Example S&P 500 Value ETF", kind: "ETF" })).toBe(false);
    expect(isSp500Fund({ symbol: "VOO260417C620", name: "CALL EXAMPLE 500 INDEX", kind: "OPTION" })).toBe(false);
    expect(isSp500Fund({ symbol: null, name: "Example S&P 400 DC CIT", kind: "FUND" })).toBe(false);
    expect(isUnitTrust({ name: trust })).toBe(true);
    expect(isUnitTrust({ name: "Example 500 Index Fund" })).toBe(false);
  });

  it("steps quarters across a year end", () => {
    expect(quarterOf("2024-06-30")).toBe("2024-Q2");
    expect(shiftQuarter("2024-Q4", 1)).toBe("2025-Q1");
    expect(shiftQuarter("2024-Q1", -3)).toBe("2023-Q2");
    expect(quarterSpan("2024-Q1")).toEqual({ start: "2024-01-01", end: "2024-03-31" });
  });
});

describe("the S&P 500 a quarter at a time", () => {
  const printedIndex = (threeMonth: number, oneYear: number) => ({ name: "S&P 500 Index", threeMonth, yearToDate: null, oneYear });

  it("takes the index's printed return first, then a trust's unit value, quarter by quarter", () => {
    const snaps = [
      snap("2023-12-31", [fund(trust, 100_00, 1, { printedIndex: printedIndex(0.1, 0.2) })]),
      snap("2024-03-31", [fund(trust, 220_00, 2, { printedIndex: printedIndex(0.05, 0.25) })]),
      // Q2: no table printed; the unit value goes from $110 to $121.
      snap("2024-06-30", [fund(trust, 363_00, 3)]),
    ];
    const q = sp500Quarters(snaps, [], ["2023-Q4", "2024-Q1", "2024-Q2"]);
    expect(q.get("2023-Q4")).toMatchObject({ ratio: 0.1, source: { kind: "printed" } });
    expect(q.get("2024-Q1")).toMatchObject({ ratio: 0.05, source: { kind: "printed" } });
    expect(q.get("2024-Q2")!.source.kind).toBe("unit-value");
    expect(q.get("2024-Q2")!.ratio).toBeCloseTo(0.1, 12);
  });

  it("backs a quarter out of a 1-year return printed three quarters later, and the one before it from the next", () => {
    const later = [
      snap("2023-03-31", [fund(trust, 1_00, 1, { printedIndex: printedIndex(0.02, 0) })]),
      snap("2023-06-30", [fund(trust, 1_00, 1, { printedIndex: printedIndex(0.03, 0) })]),
      snap("2023-09-30", [fund(trust, 1_00, 1, { printedIndex: printedIndex(0.04, (1.01 * 1.02 * 1.03 * 1.04) - 1) })]),
      snap("2023-12-31", [fund(trust, 1_00, 1, { printedIndex: printedIndex(0.05, (1.02 * 1.03 * 1.04 * 1.05) - 1) })]),
    ];
    const q = sp500Quarters(later, [], ["2022-Q3", "2022-Q4", "2023-Q1", "2023-Q2", "2023-Q3", "2023-Q4"]);
    expect(q.get("2022-Q4")!.source.kind).toBe("backed-out");
    expect(q.get("2022-Q4")!.ratio).toBeCloseTo(0.01, 12);
    // 2022-Q3 needs a 1-year return printed for 2023-Q2: none is (it prints 0), so it backs out to 1 ÷ (1.01·1.02·1.03) − 1.
    expect(q.get("2022-Q3")!.ratio).toBeCloseTo(1 / (1.01 * 1.02 * 1.03) - 1, 12);
  });

  it("chains an S&P 500 fund's monthly statements, dividends in, where nothing better covers the quarter", () => {
    const etf = (asOf: string, price: number) => snap(asOf, [{ symbol: "VOO", name: "Example S&P 500 ETF", kind: "ETF", quantity: 10, price, valueCents: price * 10 * 100, costBasisCents: null, expenseRatio: null }], "brokerage");
    const snaps = [etf("2024-03-31", 100), etf("2024-04-30", 101), etf("2024-05-31", 103), etf("2024-06-30", 104)];
    const income = [{ documentId: "tax", institution: "Example", accountNumber: "brokerage", periodStart: "2024-01-01", periodEnd: "2024-12-31", incomeRows: [{ kind: "DIVIDEND", security: "Example S&P 500 ETF", date: "2024-06-28", amount: 1000 }] }] as never;
    const q = sp500Quarters(snaps, income, ["2024-Q2"]).get("2024-Q2")!;
    expect(q.source).toMatchObject({ kind: "fund-months", total: true });
    // $1 a share of dividends in June: 104 + 1 over 100.
    expect(q.ratio).toBeCloseTo(1.05 - 1, 12);
  });

  it("leaves a quarter nothing covers without a figure", () => {
    expect(sp500Quarters([snap("2024-06-30", [fund(trust, 1_00, 1)])], [], ["2024-Q2"]).size).toBe(0);
  });
});

describe("Empower's holdings table", () => {
  const TEXT = `How is my account invested?
50.00% Large Cap Funds
Dividends Ending
Beginning /Change Withdrawals Ending Units/
Balance Deposits in Value Transfers /Expenses Balance Shares
Large Cap Funds
Example S&P 500
DC CIT
1,000.00 100.00 50.00 -1.00 1,149.00 5.000
Bond Funds
Example Bond Index Adm 0.00 200.00 -2.00 198.00 19.800
Totals 1,000.00 300.00 48.00 -1.00 $1,347.00
How is my account being funded?
Investment Option Code 3 Month YTD 1 Year 3 Year 5 Year /10 Year Date Ratio
Example S&P 500 DC CIT 14 99999 7.50 7.50 -7.70 18.60 11.19 11.49 Mar 2017 .01
S & P 500 Index 1,3,4,10,14 N/A 7.50 7.50 -7.73 18.60 11.19 12.24
`;

  it("reads each fund's ending balance and units, a wrapped name joined, and the S&P 500 Index's printed returns", () => {
    const h = extractEmpowerHoldings(TEXT, "111111-01", "2023-03-31")!;
    expect(h.printedTotalCents).toBe(134_700);
    expect(h.positions.map((p) => [p.name, p.valueCents, p.quantity])).toEqual([
      ["Example S&P 500 DC CIT", 114_900, 5],
      ["Example Bond Index Adm", 19_800, 19.8],
    ]);
    expect(h.positions[0]!.printedIndex).toEqual({ name: "S&P 500 Index", threeMonth: 0.075, yearToDate: 0.075, oneYear: -0.0773 });
    expect(h.positions[1]!.printedIndex).toBeUndefined();
  });

  it("lists nothing for an account every fund was sold out of", () => {
    const emptied = `How is my account invested?
Large Cap Funds
Example S&P 500
DC CIT
1,000.00 10.00 -1,010.00 0.00 0.000
Totals 1,000.00 10.00 -$1,010.00
`;
    expect(extractEmpowerHoldings(emptied, "111111-01", "2025-12-31")).toBeNull();
  });
});
