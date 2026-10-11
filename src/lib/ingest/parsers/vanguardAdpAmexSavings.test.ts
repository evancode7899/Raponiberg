import { describe, expect, it } from "vitest";
import { classifyTransaction, type ClassifyContext } from "../../classifier/classify.ts";
import { validateDocument } from "../validate.ts";
import { amountsFromLines, stubChecks } from "../payroll/index.ts";
import { parseStatementText } from "./index.ts";

// Synthetic statements in each provider's real text layout (figures and names are made up).

const CTX: ClassifyContext = { mergeDate: "2024-12-01", userRules: [] };

function parse(text: string) {
  const o = parseStatementText(text);
  if (!o.ok) throw new Error(JSON.stringify(o));
  return o;
}

describe("Vanguard 401(k)", () => {
  const text = `ACCOUNT SUMMARY: 04/01/2026 - 06/30/2026
ACME CORPORATION 401(K) PLAN–– 012345
DIVISION NAME: US HOME BASED
PAT EXAMPLE
Current Period \tYear to Date
Beginning balance \t$10,000.00 \t$8,000.00
Your contributions \t$1,000.00 \t$1,500.00
Employer contributions \t$200.00 \t$300.00
Market gain/loss \t$800.00 \t$2,208.50
Fees* \t-$8.50 \t-$17.00
Ending balance \t$11,991.50 \t$11,991.50
vanguard.com
Total Invested \t$10,000.00 \t$1,200.00 \t- $8.50 \t$800.00 \t$11,991.50
`;

  it("reads the quarter as a statement and the year to date as a gap-filling recap", () => {
    const { doc, parserId } = parse(text);
    expect(parserId).toBe("vanguard-401k");
    expect(doc.sections).toHaveLength(2);
    const [quarter, ytd] = doc.sections;
    expect(quarter).toMatchObject({ accountNumber: "012345", accountName: "401(k) — Acme Corporation — Pat", openingBalanceCents: 1_000_000, closingBalanceCents: 1_199_150, growthCents: 80_000, feesCents: -850 });
    expect(quarter!.transactions.map((t) => [t.section, t.amountCents])).toEqual([
      ["Employee contributions", 100_000],
      ["Employer contributions", 20_000],
    ]);
    expect(ytd).toMatchObject({ isSummary: true, periodStart: "2026-01-01", openingBalanceCents: 800_000 });
    expect(validateDocument(doc).ok).toBe(true);
  });

  it("books the contributions as payroll retirement money, not own-account transfers", () => {
    const { doc } = parse(text);
    const t = doc.sections[0]!.transactions[0]!;
    const c = classifyTransaction({ institution: "Vanguard", accountSubtype: "401K", section: t.section, description: t.description, amountCents: t.amountCents, date: t.date }, CTX);
    expect(c.lane).toBe("CONTRIBUTION_EMPLOYEE");
  });
});

describe("Vanguard brokerage / IRA", () => {
  const text = `Assets listed in this statement are held by Vanguard Brokerage Services® (VBS), a division
Vanguard Personal Investor
June 30, 2026, quarter-to-date statement
Page \t1 of 8
PAT EXAMPLE
\tTRAD IRA VFTC AS CUSTODIAN
Statement overview \t$0.00
Accounts \tValue on
03/31/2026
Value on
06/30/2026
PAT EXAMPLE
TRAD IRA VFTC AS CUSTODIAN
Traditional IRA brokerage account \t$0.00 \t$0.00
Brokerage assets are held by Vanguard Brokerage (VBS)
Account overview \t$0.00
Total account value as of June 30, 2026
Traditional IRA brokerage account—XXXX4444
PAT EXAMPLE TRAD IRA VFTC AS CUSTODIAN
Completed transactions
Settlement
date
Trade
date \tSymbol \tName \tTransaction type \tAccount type \tQuantity \tPrice
Commissions
& fees \tAmount
06/09 \t06/09 \t- \t2026 IRA CONTRIBUTION \tContribution \t- \t- \t- \t- \t$7,500.00
MMF JRL FR XXXX1111
FROM: XXXX1111-1
06/09 \t06/09 \t- \tVANGUARD FEDERAL MONEY \tSweep in \t- \t- \t- \t- \t-7,500.00
MARKET FUND
06/10 \t06/10 \t- \tNON-QUAL PREM TO ROTH \tConversion \t- \t- \t- \t- \t-7,500.41
MMF JRL TO XXXX2222
TO: \tXXXX2222-1
06/10 \t06/10 \t- \tVANGUARD FEDERAL MONEY \tDividend \t- \t- \t- \t- \t0.41
MARKET FUND
06/10 \t06/10 \t- \tVANGUARD FEDERAL MONEY \tSweep out \t- \t- \t- \t- \t7,500.00
MARKET FUND
If you had an adjustment to a dividend or interest payment from a previous month, the monthly amount shown
Disclosures
`;

  it("keeps only external flows and derives growth from the balances", () => {
    const { doc } = parse(text);
    const s = doc.sections[0]!;
    expect(s).toMatchObject({ accountNumber: "4444", subtype: "TRADITIONAL_IRA", periodStart: "2026-04-01", periodEnd: "2026-06-30", growthCents: 41 });
    expect(s.transactions.map((t) => [t.date, t.amountCents, t.section])).toEqual([
      ["2026-06-09", 750_000, "Contribution"],
      ["2026-06-10", -750_041, "Conversion"],
    ]);
    expect(validateDocument(doc).ok).toBe(true);
  });

  it("recognizes journals between the owner's Vanguard accounts as transfers naming the other account", () => {
    const { doc } = parse(text);
    for (const [i, hint] of [[0, "1111"], [1, "2222"]] as const) {
      const t = doc.sections[0]!.transactions[i]!;
      const c = classifyTransaction({ institution: "Vanguard", accountSubtype: "TRADITIONAL_IRA", section: t.section, description: t.description, detail: t.detail, amountCents: t.amountCents, date: t.date }, CTX);
      expect(c.lane).toBe("TRANSFER");
      expect(c.counterparty).toMatchObject({ kind: "OWN_ACCOUNT", institution: "Vanguard", accountHint: hint });
    }
  });

  it("refuses an unfamiliar transaction type instead of treating it as growth", () => {
    const o = parseStatementText(text.replace("Conversion", "Mystery movement"));
    expect(o.ok).toBe(false);
  });

  const withIncome = text.replace(
    "Completed transactions\n",
    `Income summary
Dividends \tInterest \tTax-exempt interest \tShort-term capital gains \tLong-term capital gains \tOther income
June \t$0.41 \t$0.00 \t$0.00 \t$0.00 \t$0.00 \t$0.00
Year-to-date \t12.34 \t0.50 \t0.00 \t0.00 \t1.25 \t0.00
Completed transactions
`,
  );

  it("reads the year-to-date income summary and tags money-market dividends as non-qualified", () => {
    const { doc } = parse(withIncome);
    expect(doc.brokerageFacts).toHaveLength(1);
    expect(doc.brokerageFacts![0]).toMatchObject({
      accountNumber: "4444",
      kind: "TRADITIONAL_IRA",
      ownerLine: "PAT EXAMPLE TRAD IRA VFTC AS CUSTODIAN",
      periodEnd: "2026-06-30",
      income: { dividends: 1234, interest: 50, taxExempt: 0, capGainDistShort: 0, capGainDistLong: 125, taxDeferred: 0 },
      realized: null,
      incomeRows: [{ date: "2026-06-10", kind: "DIVIDEND", amount: 41, security: "VANGUARD FEDERAL MONEY MARKET FUND", moneyMarket: true, nonQualified: true }],
    });
  });

  it("leaves income unread (with a warning) when the summary's columns change", () => {
    const { doc } = parse(withIncome.replace("Other income", "Section 199A dividends"));
    expect(doc.brokerageFacts![0]!.income).toBeNull();
    expect(doc.warnings.some((w) => /columns changed/.test(w))).toBe(true);
  });
});

describe("Amex High Yield Savings", () => {
  const text = `American Express National Bank
Account Statement For:
Pat Example
Statement Period: August 9, 2026 - September 8, 2026
Account Owner(s): Pat Example
High Yield Savings Account: xxxxxxxx4321
Total Debits This Period $1,000.00
Total Credits This Period $5.00
Interest Credited This Period $5.00
Account Activity
Date Transactions Debits Credits Balance
08/09/2026 Beginning Balance $1,000.00
08/20/2026 ACH Withdrawal
VANGUARD MARKETI PAYMENTS
$1,000.00 $0.00
09/08/2026 Interest Payment $5.00 $5.00
09/08/2026 Ending Balance $5.00
-- 3 of 3 --
`;

  it("derives each row's direction from the running balance", () => {
    const { doc } = parse(text);
    const s = doc.sections[0]!;
    expect(s).toMatchObject({ accountNumber: "4321", kind: "SAVINGS", institution: "American Express", openingBalanceCents: 100_000, closingBalanceCents: 500 });
    expect(s.transactions.map((t) => [t.amountCents, t.description])).toEqual([
      [-100_000, "ACH Withdrawal VANGUARD MARKETI PAYMENTS"],
      [500, "Interest Payment"],
    ]);
    expect(validateDocument(doc).ok).toBe(true);
  });

  it("treats the ACH to Vanguard as an own-account transfer and the interest as income", () => {
    const { doc } = parse(text);
    const [ach, interest] = doc.sections[0]!.transactions;
    const base = { institution: "American Express", accountSubtype: "SAVINGS" as const, date: "2026-08-20" };
    const a = classifyTransaction({ ...base, description: ach!.description, amountCents: ach!.amountCents }, CTX);
    expect(a.lane).toBe("TRANSFER");
    expect(a.counterparty).toMatchObject({ kind: "OWN_ACCOUNT", institution: "Vanguard" });
    const i = classifyTransaction({ ...base, description: interest!.description, amountCents: interest!.amountCents }, CTX);
    expect(i).toMatchObject({ lane: "INCOME", category: "Interest" });
  });
});

describe("ADP earnings statement", () => {
  const text = `Earnings Statement
2000 ADP, Inc.
Period Beginning: \t12/08/2025
Period Ending: \t12/21/2025
Pay Date: \t12/19/2025
EXAMPLE \tCORP \tINC.
PAT EXAMPLE
Gross Pay \t$3 446 54
xxxxx5555
$2 454 92 \tNet Pay
`;

  it("refuses a stub without the positioned layout rather than half-reading it", () => {
    const o = parseStatementText(text);
    expect(o).toMatchObject({ ok: false, reason: "PARSE_ERROR", parserId: "adp-paystub" });
  });

  it("reads taxes, deferrals and the employer match from the positioned layout", () => {
    const layout = [
      "[pdf-layout]",
      "@1:736\t100-197 EXAMPLE CORP INC.\t354-428 Period Beginning:\t455-500 12/08/2025",
      "@1:712\t354-396 Pay Date:\t455-500 12/19/2025",
      "@1:600\t212-253 this period\t282-331 year to date",
      "@1:587\t21-53 Regular\t211-256 1 000 00\t286-336 20 000 00",
      "@1:539\t95-142 Gross Pay\t211-256 $1 000 00\t286-336 20 000 00",
      "@1:532\t354-441 Other Benefits and",
      "@1:522\t464-504 this period\t534-582 total to date",
      "@1:497\t95-180 Federal Income Tax\t221-256 -100 00\t291-336 2 000 00\t354-405 401K Match\t480-505 30 00\t561-586 600 00",
      "@1:485\t95-178 Social Security Tax\t226-256 -62 00\t291-336 1 240 00",
      "@1:335\t95-116 401K\t226-260 -50 00*\t291-336 1 000 00",
      "@1:317\t95-131 Net Pay\t211-256 $788 00",
      "@1:305\t95-121 Check\t211-256 -788 00\t286-336 15 760 00",
      "@1:245\t542-568 2000 ADP, Inc.",
    ].join("\n");
    const { doc } = parse(`${text}\n${layout}`);
    expect(doc.parserVersion).toBe(3);
    expect(doc.warnings).toEqual([]);
    const s = doc.payStubs![0]!;
    expect(s).toMatchObject({ payDate: "2025-12-19", employer: "Example Corp Inc" });
    // The deposit account comes from the layout's deposit advice, which this sample omits.
    expect(s.deposits).toEqual([{ last4: null, amount: 78_800 }]);
    expect(s.printed).toMatchObject({ grossCurrent: 100_000, netCurrent: 78_800 });
    const a = amountsFromLines(s.lines, "current");
    expect(a.federalWithheld + a.ssWithheld).toBe(16_200);
    expect(a.retirementPretax).toBe(5_000);
    expect(a.employerRetirement).toBe(3_000);
    expect(stubChecks(s).filter((c) => !c.ok)).toEqual([]);
  });
});

describe("Vanguard is a tracked institution", () => {
  it("treats a bank debit to Vanguard as an own-account transfer, not an untracked brokerage", () => {
    const c = classifyTransaction(
      { institution: "Chase", accountSubtype: "CHECKING", description: "Vanguard Buy Investment 123 Web ID: Vmc Pur", amountCents: -750_000, date: "2026-06-04" },
      CTX,
    );
    expect(c.lane).toBe("TRANSFER");
    expect(c.counterparty).toMatchObject({ institution: "Vanguard" });
  });

  it("does not mistake a restaurant card charge for Vanguard", () => {
    const c = classifyTransaction(
      { institution: "American Express", accountSubtype: "CREDIT_CARD", description: "VANGUARD DINER SPRINGFIELD MA", amountCents: -8_000, date: "2022-01-15" },
      CTX,
    );
    expect(c.lane).toBe("EXPENSE");
  });
});
