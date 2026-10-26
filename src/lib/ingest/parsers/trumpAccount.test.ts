import { describe, expect, it } from "vitest";
import { classifyTransaction, type ClassifyContext } from "../../classifier/classify.ts";
import { validateDocument } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic statements in the Trump Account's real text layout (names and figures are made up).
const statement = (opts: { opening: string; rows: string; summary: string; total: string; qty: string; price: string; value: string; period: string }) => `This statement shall be conclusive if not objected to in writing within ten days.
Trump Accounts are traditional individual retirement accounts with special rules established under section 530A of the Internal Revenue Code. Robinhood Securities, LLC, on behalf of the U.S. Treasury and through its designated Financial Agent, serves as Trustee for Trump Accounts.
1234567
Trump Account #: ********1234
Trump Account FBO Sam Example
Responsible Party Pat Example
${opts.period}
1 MAIN ST, SPRINGFIELD, ST 00000
Robinhood Securities as Trustee
Account Summary Opening Balance Closing Balance
Net Account Balance ${opts.opening} $0.00
Total Securities ${opts.opening} ${opts.value}
Portfolio Value ${opts.opening} ${opts.value}
Income and Expense Summary This Period Year to Date
Dividends $0.00 $0.00
Contribution Summary This Period Year to Date
${opts.summary}
Page of\t1 6

-- 1 of 6 --

Securities Held in Account Sym/Cusip Acct Type Qty Price Mkt Value % of Total Portfolio
Example S&P 500 ETF EXSP Cash ${opts.qty} $${opts.price} ${opts.value} 100.00%
Total Securities ${opts.value} 100.00%
Brokerage Cash Balance $0.00 0.00%
Total Priced Portfolio ${opts.value}
Page of\t2 6

-- 2 of 6 --

Description Symbol Acct Type Transaction Date Qty Price Debit Credit
${opts.rows}
Total Funds Paid and Received ${opts.total}
Page of\t3 6

-- 3 of 6 --
`;

const FIRST = statement({
  period: "03/01/2026 to 03/31/2026",
  opening: "N/A",
  summary: "Other $5.00 $5.00\nPilot Program $1,000.00 $1,000.00",
  rows: `Other Contribution: Debit Card Deposit Cash OCON 03/10/2026 $5.00
Pilot Program Contribution Cash PPCON 03/10/2026 $1,000.00
Example S&P 500 ETF
CUSIP: 000000000
Automatic Investment
EXSP Cash Buy 03/11/2026 20.1 $50.00000 $1,005.00`,
  total: "$1,005.00 $1,005.00",
  qty: "20.1",
  price: "51.00000",
  value: "$1,025.10",
});

const CTX: ClassifyContext = { mergeDate: "2024-12-01", userRules: [] };

describe("Trump Account statement", () => {
  const o = parseStatementText(FIRST);
  if (!o.ok) throw new Error(JSON.stringify(o));
  const s = o.doc.sections[0]!;

  it("files it as the child's Other investment, opening at zero, and ties out to the cent", () => {
    expect(o.parserId).toBe("trump-account");
    expect(s).toMatchObject({
      institution: "Trump Account",
      accountNumber: "1234",
      accountName: "Trump Account — Sam Example",
      kind: "INVESTMENT",
      subtype: "OTHER",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      openingBalanceCents: 0,
      closingBalanceCents: 102_510,
      growthCents: 2_010,
      growthFromBalances: true,
    });
    expect(validateDocument(o.doc).ok).toBe(true);
    expect(s.checks.every((c) => c.expectedCents === c.actualCents)).toBe(true);
  });

  it("keeps the contributions as flows and the automatic investment out", () => {
    expect(s.transactions).toEqual([
      expect.objectContaining({ date: "2026-03-10", amountCents: 500, section: "Other Contribution", detail: "Debit Card Deposit" }),
      expect.objectContaining({ date: "2026-03-10", amountCents: 100_000, section: "Pilot Program Contribution" }),
    ]);
  });

  it("marks the tax figures as a Trump Account, with no current income", () => {
    expect(o.doc.brokerageFacts?.[0]).toMatchObject({ accountNumber: "1234", kind: "TRUMP_ACCOUNT", ownerLine: "Trump Account FBO Sam Example", income: null, contributionsYtd: 100_500 });
  });

  it("reads the position held", () => {
    expect(o.doc.holdings?.[0]).toMatchObject({ accountNumber: "1234", asOf: "2026-03-31", printedTotalCents: 102_510 });
    expect(o.doc.holdings?.[0]?.positions).toEqual([expect.objectContaining({ symbol: "EXSP", kind: "ETF", quantity: 20.1, price: 51, valueCents: 102_510 })]);
  });

  it("classifies the government seed as income and the debit card deposit as a bank transfer", () => {
    const classify = (section: string) => {
      const t = s.transactions.find((x) => x.section === section)!;
      return classifyTransaction({ institution: "Trump Account", accountSubtype: "OTHER", section: t.section, description: t.description, amountCents: t.amountCents, date: t.date }, CTX);
    };
    expect(classify("Pilot Program Contribution")).toMatchObject({ lane: "INCOME", needsReview: false });
    expect(classify("Other Contribution")).toMatchObject({ lane: "TRANSFER", needsReview: false });
  });

  it("opens a later statement at its printed opening value", () => {
    const later = parseStatementText(
      statement({
        period: "04/01/2026 to 04/30/2026",
        opening: "$1,025.10",
        summary: "Other $0.00 $5.00\nPilot Program $0.00 $1,000.00",
        rows: "",
        total: "$0.00 $0.00",
        qty: "20.1",
        price: "52.00000",
        value: "$1,045.20",
      }),
    );
    if (!later.ok) throw new Error(JSON.stringify(later));
    expect(later.doc.sections[0]).toMatchObject({ openingBalanceCents: 102_510, closingBalanceCents: 104_520, growthCents: 2_010, transactions: [] });
    expect(validateDocument(later.doc).ok).toBe(true);
  });

  it("refuses an unfamiliar transaction code rather than guessing", () => {
    const odd = parseStatementText(FIRST.replace("PPCON 03/10/2026", "XFER 03/10/2026"));
    expect(odd).toMatchObject({ ok: false, reason: "PARSE_ERROR" });
  });
});
