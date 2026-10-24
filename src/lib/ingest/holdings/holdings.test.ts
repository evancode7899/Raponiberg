import { describe, expect, it } from "vitest";
import { extractFidelityHoldings, extractHealthEquityHoldings, extractSlavicHoldings, extractVanguard401kHoldings, extractVanguardBrokerageHoldings, sumPositions } from "./index.ts";
import { locatePosition, splitRow } from "./types.ts";

// Synthetic statements in each provider's layout (no real account data).

const FIDELITY = `INVESTMENT REPORT
March 1, 2026 - March 31, 2026
Account # X11-111111
PAT EXAMPLE - INDIVIDUAL - TOD
Holdings
Core Account
Description
Beginning
Market Value
Mar 1, 2026
Quantity
Mar 31, 2026
Price
Per Unit
Mar 31, 2026
Ending
Market Value
Mar 31, 2026
Total
Cost Basis
Unrealized
Gain/Loss
Mar 31, 2026
EAI ($) /
EY (%)
FIDELITY GOVERNMENT MONEY
MARKET (SPAXX)
-- 7-day yield: 3.00%
$100.00 1,000.000 $1.0000 $1,000.00 not applicable not applicable $30.00
3.000%
Total Core Account (10% of account
holdings)
$100.00 $1,000.00 $30.00
-- 4 of 9 --
MR_CE _XXXX_ 20260331
S
5 of 9
INVESTMENT REPORT
March 1, 2026 - March 31, 2026
Account # X11-111111
PAT EXAMPLE - INDIVIDUAL - TOD Holdings
Exchange Traded Products
Includes exchange-traded funds (ETFs), exchange-traded notes (ETNs), and other exchange-traded vehicles.
Description
Equity ETPs
EXAMPLE TOTAL MARKET
INDEX ETF (TMKT)
$7,900.00 20.000 $400.0000 $8,000.00 $6,000.00 $2,000.00 $100.00
1.250%
M EXAMPLE STOCK CO (EXCO) 1,000.00 10.000 95.0000 950.00 1,200.00 -250.00 -
-
Total Equity ETPs (90% of account
holdings)
$8,900.00 8,950.00 7,200.00 1,750.00 100.00
Options
M CALL (TMKT) EXAMPLE TOTAL MARKET
JAN 15 27 $500 (100 SHS)
(TMKT270115C500) SHT
unavailable -1.000 $5.0000 -$500.00 -$300.00 -$200.00
Total Options (-5% of account holdings) unavailable -$500.00 -$300.00 -$200.00
Total Holdings $9,450.00 $6,900.00 $1,550.00 $130.00
All remaining positions held in cash account.
-- 5 of 9 --
INVESTMENT REPORT
March 1, 2026 - March 31, 2026
Account # X22-222222
PAT EXAMPLE - BENEFICIARY (529)
Holdings
Description
Percent of
Total Value
Mar 31, 2026
Beginning
Market Value
Mar 1, 2026
Quantity
Mar 31, 2026
Price
per Unit
Mar 31, 2026
Ending
Market Value
Mar 31, 2026
EX INTERNATIONAL INDEX 30% unavailable 100.000 $15.0000 $1,500.00
EX 500 INDEX 70 unavailable 200.000 17.5000 3,500.00
Total Market Value $5,000.00
`;

describe("holdings extraction", () => {
  it("locates quantity, price and value by quantity × price = value", () => {
    expect(locatePosition(splitRow("$100.00 1,000.000 $1.0000 $1,000.00 NA NA $30.00").nums)).toMatchObject({ q: 1, p: 2, v: 3 });
    // Option contracts are priced per share (×100) and can be short.
    expect(locatePosition(splitRow("unavailable -1.000 $5.0000 -$500.00 -$300.00 -$200.00").nums)).toMatchObject({ q: 1, v: 3, multiplier: 100 });
    // A tiny position: cost × gain ≈ income must not win over the real columns.
    expect(locatePosition(splitRow("$2.51 0.004 $600.0000 $2.40 $2.39 $0.01 $0.03").nums)).toMatchObject({ q: 1, p: 2, v: 3 });
  });

  it("reads Fidelity holdings across pages, sections, options and a 529 table", () => {
    const [brokerage, college] = extractFidelityHoldings(FIDELITY);
    expect(brokerage!.accountNumber).toBe("X11-111111");
    expect(brokerage!.asOf).toBe("2026-03-31");
    expect(brokerage!.positions.map((p) => [p.symbol, p.kind, p.valueCents, p.costBasisCents])).toEqual([
      ["SPAXX", "CASH", 100_000, null],
      ["TMKT", "ETF", 800_000, 600_000],
      ["EXCO", "ETF", 95_000, 120_000],
      ["TMKT270115C500", "OPTION", -50_000, -30_000],
    ]);
    expect(brokerage!.positions[2]!.name).toBe("EXAMPLE STOCK CO");
    expect(sumPositions(brokerage!.positions)).toBe(brokerage!.printedTotalCents);
    expect(college!.positions.map((p) => [p.name, p.quantity, p.valueCents])).toEqual([
      ["EX INTERNATIONAL INDEX", 100, 150_000],
      ["EX 500 INDEX", 200, 350_000],
    ]);
    expect(college!.printedTotalCents).toBe(500_000);
  });

  it("reads Vanguard brokerage sweep and ETF rows (name after the figures)", () => {
    const text = `Balances and holdings for Vanguard Brokerage Account—XXXX4321
Sweep program
Name 	Quantity
Price on
03/31/2026
120.0000 	$1.00 	$80.00 	$120.00	VANGUARD FEDERAL MONEY
MARKET FUND
7-day SEC Yield: 3.60%
Total Sweep Balance 	$80.00 	$120.00
-- 3 of 8 --
Balances and holdings for Vanguard Brokerage Account—XXXX4321 	continued
ETFs
Symbol 	Name
VTMK 	$50.00 	$950.00 	10.0000 	$100.0000 	$900.00 	$1,000.00	EXAMPLE TOTAL
MARKET ETF
Est. annual income: $15.00; Est. yield: 1.50%
Account activity for Vanguard Brokerage Account—XXXX4321
08/31 	08/31 	- 	SOMETHING 	Dividend 	- 	- 	- 	- 	$0.05`;
    const [acct] = extractVanguardBrokerageHoldings(text, "2026-03-31");
    expect(acct!.accountNumber).toBe("4321");
    expect(acct!.positions.map((p) => [p.symbol, p.kind, p.name, p.valueCents, p.costBasisCents])).toEqual([
      [null, "CASH", "VANGUARD FEDERAL MONEY MARKET FUND", 12_000, null],
      ["VTMK", "ETF", "EXAMPLE TOTAL MARKET ETF", 100_000, 95_000],
    ]);
  });

  it("reads a dash for a position opened this period as an empty column, not a minus on the value", () => {
    // A position new this quarter: nothing at the start ("-"), and the table's first row prints "$".
    const text = `Balances and holdings for Vanguard Brokerage Account—XXXX4321
Sweep program
Name 	Quantity
22.5000 	$1.00 	- 	$22.50	VANGUARD FEDERAL MONEY
MARKET FUND
Total Sweep Balance 	$0.00 	$22.50
ETFs
Symbol 	Name
EXWD 	-$12.00 	$812.00 	20.0000 	$40.0000 	- 	$800.00	EXAMPLE WORLD
EX US ETF
EXSP 	-3.00 	503.00 	1.0000 	500.0000 	- 	500.00	EXAMPLE 500
INDEX ETF
Account activity for Vanguard Brokerage Account—XXXX4321`;
    const [acct] = extractVanguardBrokerageHoldings(text, "2026-06-30");
    expect(acct!.positions.map((p) => [p.symbol, p.kind, p.valueCents, p.costBasisCents])).toEqual([
      [null, "CASH", 2_250, null],
      ["EXWD", "ETF", 80_000, 81_200],
      ["EXSP", "ETF", 50_000, 50_300],
    ]);
  });

  it("reads Vanguard 401(k) funds, with names that wrap and start with a number", () => {
    const text = `ACCOUNT SUMMARY: 01/01/2026 - 03/31/2026
Beginning 	Other 	Market 	Shares/ 	Ending
Balance 	Contributions 	Transactions* 	Gain/Loss 	Units 	Balance
$1,000.00 	$500.00 	- $1.00 	$51.00 	10.500 	$1,550.00	Example Target Retire
2065 Tr P
$2,000.00 	$0.00 	- $2.00 	$102.00 	20.000 	$2,100.00	Example Instl 500 Idx
Take the questionnaire annually.
Total Invested 	$3,000.00 	$500.00 	- $3.00 	$153.00 	$3,650.00`;
    const f = extractVanguard401kHoldings(text, "999")!;
    expect(f.asOf).toBe("2026-03-31");
    expect(f.positions.map((p) => [p.name, p.quantity, p.valueCents])).toEqual([
      ["Example Target Retire 2065 Tr P", 10.5, 155_000],
      ["Example Instl 500 Idx", 20, 210_000],
    ]);
    expect(f.printedTotalCents).toBe(sumPositions(f.positions));
  });

  it("reads Slavic funds and matches each to the fund menu's ticker and expense ratio", () => {
    const text = `Quarterly Account Snapshot
(as of 03/31/2026)
INVESTMENT FUNDS
Balance Shares
Example 500 Index $900.00 $100.00 $0.00 $0.00 $20.00 $1,020.00 5.100
TOTAL BALANCE $900.00 $100.00 $0.00 $0.00 $20.00 $1,020.00
FUND NAME Symbol Category YTD 1 Year 3 Years 5 Years 10 Years
Total Annual
Operating
Expenses*
Cost
Per $1k
Example Bond Fund EXBDX Core Bond
Funds 1.00% 3.00% 4.00% 1.00% 2.00% 0.250% $2.50
Example 500 Index Fund EXIDX S&P 500 Index
Funds 10.00% 20.00% 20.00% 13.00% 15.00% 0.015% $0.15`;
    const f = extractSlavicHoldings(text, "1234")!;
    expect(f.positions).toEqual([
      { symbol: "EXIDX", name: "Example 500 Index", kind: "FUND", quantity: 5.1, price: null, valueCents: 102_000, costBasisCents: null, expenseRatio: 0.00015 },
    ]);
    expect(f.printedTotalCents).toBe(102_000);
  });

  it("reads an HSA's cash and invested fund", () => {
    const text = `Ending Balance $ 1,000.00
Investment Portfolio
Fund Category Shares Closing Price Closing Value
Closing Account Value $ 2,000.00
EXTSX EXAMPLE TOTAL STK MKT
IDX ADMIRAL 10.00 200.00 2,000.00
Account Statement (Continued)`;
    const f = extractHealthEquityHoldings(text, "55", "2026-03-31", 100_000);
    expect(f.positions.map((p) => [p.symbol, p.kind, p.name, p.valueCents])).toEqual([
      [null, "CASH", "HSA cash", 100_000],
      ["EXTSX", "FUND", "EXAMPLE TOTAL STK MKT IDX ADMIRAL", 200_000],
    ]);
    expect(f.printedTotalCents).toBe(300_000);
  });
});
