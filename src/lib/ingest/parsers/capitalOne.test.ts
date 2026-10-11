import { describe, expect, it } from "vitest";
import { classifyTransaction, type ClassifyContext } from "../../classifier/classify.ts";
import { validateDocument } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic statement in Capital One's real text layout (names and figures are made up).
const TEXT = `Account Summary
Previous Balance \t$100.00
Payments \t- $100.00
Other Credits \t- $15.00
Transactions \t+ \t$163.50
Cash Advances \t+ $0.00
Fees Charged \t+ \t$40.00
Interest Charged \t+ $2.50
New Balance \t= $191.00
Credit Limit \t$2,000.00
Payment Information
New Balance
$191.00
Page 1 of 4
Quicksilver Credit Card | World Elite Mastercard ending in 1234
Dec 21, 2025 - Jan 20, 2026 \t| \t31 days in Billing Cycle
Pay or manage your account at capitalone.com \tCustomer Service: 800-000-0000
Rewards Summary
Previous Balance \tEarned This Period \tRedeemed this period
$1.00 \t$2.00 \t$0.00
Payment Due Date: \tFeb 14, 2026 \tAccount ending in 1234

-- 1 of 4 --

Page 2 of 4
Quicksilver Credit Card | World Elite Mastercard ending in 1234
Dec 21, 2025 - Jan 20, 2026 \t| \t31 days in Billing Cycle
Transactions
Visit capitalone.com to see detailed transactions.
PAT EXAMPLE #1234: Payments, Credits and Adjustments
Trans Date \tPost Date \tDescription \tAmount
Dec 22 \tDec 22 \tCAPITAL ONE MOBILE PYMTAuthDate 22-Dec \t- $100.00
Jan 3 \tJan 3 \tCREDIT-CASH BACK REWARD \t- $15.00
PAT EXAMPLE #1234: Transactions
Trans Date \tPost Date \tDescription \tAmount
Dec 20 \tDec 21 \tTRATTORIA ESEMPIOROMAITA \t$59.00
$50.00
EUR
0.847457627 Exchange Rate
Dec 30 \tDec 31 \tSumUp \t*Caffe ExampleNapoli \t$4.50
PAT EXAMPLE #1234: Total Transactions \t$63.50
Additional Information on the next page
Quicksilver Credit Card | World Elite Mastercard ending in 1234
Dec 21, 2025 - Jan 20, 2026 \t| \t31 days in Billing Cycle
Page 3 of 4
Transactions (Continued)
SAM EXAMPLE #5678: Payments, Credits and Adjustments
Trans Date \tPost Date \tDescription \tAmount
SAM EXAMPLE #5678: Transactions
Trans Date \tPost Date \tDescription \tAmount
Jan 10 \tJan 11 \tCVS PHARMACY #1HARTFORDCT \t$100.00
SAM EXAMPLE #5678: Total Transactions \t$100.00
Total Transactions for This Period \t$163.50
Fees
Trans Date \tPost Date \tDescription \tAmount
Jan 15 \tJan 15 \tPAST DUE FEE \t$40.00
Total Fees for This Period \t$40.00
Interest Charged
Interest Charge on Purchases \t$2.50
Interest Charge on Cash Advances \t$0.00
Interest Charge on Other Balances \t$0.00
Total Interest for This Period \t$2.50
Totals Year-to-Date
Total Fees charged \t$40.00
Total Interest charged \t$2.50
`;

const CTX: ClassifyContext = { mergeDate: "2024-12-01", userRules: [] };

describe("Capital One card statement", () => {
  const o = parseStatementText(TEXT);
  if (!o.ok) throw new Error(JSON.stringify(o));
  const s = o.doc.sections[0]!;
  const by = (d: string) => s.transactions.find((t) => t.description.startsWith(d))!;

  it("stores the card as owing money (negative) and ties out to the cent", () => {
    expect(o.parserId).toBe("capital-one-card");
    expect(s).toMatchObject({
      institution: "Capital One",
      accountNumber: "1234",
      accountName: "Capital One Quicksilver",
      periodStart: "2025-12-21",
      periodEnd: "2026-01-20",
      openingBalanceCents: -10_000,
      closingBalanceCents: -19_100,
    });
    expect(o.doc.warnings).toEqual([]);
    expect(validateDocument(o.doc).ok).toBe(true);
  });

  it("flips signs, splits payments from credits and resolves years across December", () => {
    expect(by("CAPITAL ONE MOBILE PYMT")).toMatchObject({ date: "2025-12-22", amountCents: 10_000, section: "Payments", detail: "AuthDate 22-Dec" });
    expect(by("CREDIT-CASH BACK")).toMatchObject({ date: "2026-01-03", amountCents: 1_500, section: "Credits" });
    // Transaction date a day before the cycle starts stays in the earlier year.
    expect(by("TRATTORIA")).toMatchObject({ date: "2025-12-20", amountCents: -5_900, detail: "50.00 EUR @ 0.847457627" });
    expect(by("SumUp *Caffe")).toMatchObject({ amountCents: -450, cardMember: "PAT EXAMPLE" });
    expect(by("CVS PHARMACY")).toMatchObject({ amountCents: -10_000, cardMember: "SAM EXAMPLE" });
    expect(by("PAST DUE FEE")).toMatchObject({ amountCents: -4_000, section: "Fees" });
    expect(by("INTEREST CHARGE ON PURCHASES")).toMatchObject({ date: "2026-01-20", amountCents: -250, section: "Interest" });
    expect(s.transactions).toHaveLength(7);
  });

  it("classifies the card's payments as transfers and its rewards as perks", () => {
    const classify = (d: string) => {
      const t = by(d);
      return classifyTransaction({ institution: "Capital One", accountSubtype: "CREDIT_CARD", section: t.section, description: t.description, amountCents: t.amountCents, date: t.date }, CTX);
    };
    expect(classify("CAPITAL ONE MOBILE PYMT").lane).toBe("TRANSFER");
    expect(classify("CREDIT-CASH BACK").ruleId).toBe("card-perk-credit");
    expect(classifyTransaction({ institution: "Capital One", accountSubtype: "CREDIT_CARD", section: "Credits", description: "REFERRALBONUSABC123", amountCents: 10_000, date: "2026-01-01" }, CTX).ruleId).toBe("card-perk-credit");
    expect(classify("PAST DUE FEE").ruleId).toBe("card-fee-interest");
  });

  it("pairs bank payments to Capital One as own-account transfers, not untracked card spending", () => {
    for (const description of ["Capital One Mobile Pmt 3Abc Web ID: 1", "Capital One Crcardpmt CA0Abc Web ID: 1"]) {
      const c = classifyTransaction({ institution: "Chase", accountSubtype: "CHECKING", description, amountCents: -10_000, date: "2026-01-14" }, CTX);
      expect(c.lane).toBe("TRANSFER");
      expect(c.counterparty).toMatchObject({ institution: "Capital One", subtypes: ["CREDIT_CARD"] });
    }
  });
});
