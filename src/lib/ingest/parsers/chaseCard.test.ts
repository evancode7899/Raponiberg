import { describe, expect, it } from "vitest";
import { validateSection } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic statement in Chase's card layout (names and amounts invented).
const text = `Manage your account online at: Customer Service: Mobile:
www.chase.com/cardhelp 1-800-524-3880 Download the
Account Number: XXXX XXXX XXXX 1234
New Balance $31.03
Previous Balance $100.00
Payment, Credits -$100.00
Purchases +$30.13
Cash Advances $0.00
Balance Transfers $0.00
Fees Charged +$0.90
Interest Charged $0.00
Opening/Closing Date 12/11/23 - 01/10/24
ACCOUNT SUMMARY
CHASE FREEDOM UNLIMITED
Date of
Transaction Merchant Name or Transaction Description $ Amount
12/15 Payment Thank You-Mobile -100.00
01/03 MAPLE CAFE OTTAWA ON 30.13
01/03 CANADIAN DOLLAR
41.00 X 0.734878048 (EXCHG RATE)
01/03 FOREIGN TRANSACTION FEE .90
MAPLE CAFE OTTAWA ON $30.13
TOTAL FEES FOR THIS PERIOD $0.90
Total fees charged in 2024 $0.90
Total interest charged in 2024 $0.00`;

describe("Chase card statement", () => {
  it("reads the summary and rows, flips signs, and reconciles", () => {
    const o = parseStatementText(text);
    if (!o.ok) throw new Error(JSON.stringify(o));
    expect(o.parserId).toBe("chase-card");
    const s = o.doc.sections[0]!;
    expect(s).toMatchObject({ accountNumber: "1234", accountName: "Chase Freedom Unlimited", periodStart: "2023-12-11", periodEnd: "2024-01-10", openingBalanceCents: -10_000, closingBalanceCents: -3_103 });
    expect(s.transactions.map((t) => [t.date, t.amountCents, t.section])).toEqual([
      ["2023-12-15", 10_000, "Payments"],
      ["2024-01-03", -3_013, undefined],
      ["2024-01-03", -90, "Fees"],
    ]);
    expect(s.transactions[1]!.detail).toContain("CANADIAN DOLLAR");
    expect(validateSection(s).ok).toBe(true);
  });
});
