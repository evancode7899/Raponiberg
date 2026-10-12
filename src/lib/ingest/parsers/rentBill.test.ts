import { describe, expect, it } from "vitest";
import { classifyTransaction } from "../../classifier/classify.ts";
import { BILL_PAYMENTS, continueBill } from "../billContinuation.ts";
import { validateDocument } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic bill in Yardi RentCafe's real text layout (names and figures are made up).
const bill = (items: string, total: string, due = "4/1/2027", through: string | null = "03-25-2027") => `DUE DATE ${due}
ACCT NO. T0001234
AMOUNT DUE $${total}
EXAMPLE PROPERTIES LLC
1 MAIN STREET 2ND FLR.
SPRINGFIELD, NY 10001
Dear Tenant(s),
Please remit payment by check
to 1 Main Street, Springfield .
email request to rent@example.com\tInvoice For:
PAT EXAMPLE
2 ELM ST.
APT. 3
SPRINGFIELD, NY 10001
${through ? `Reflects payments processed through ${through}` : ""}
Date Item Desciption Amount
${items}
TOTAL: $${total}
6 DETACH AND RETURN COUPON WITH YOUR PAYMENT 6
DUE DATE ${due}
AMOUNT DUE $${total}

-- 1 of 1 --
`;

const parse = (text: string) => {
  const o = parseStatementText(text);
  if (!o.ok) throw new Error(JSON.stringify(o));
  return o;
};

describe("Yardi rent bill", () => {
  it("is a statement of the landlord account: the charges owed as of the payments-processed date", () => {
    const o = parse(
      bill(
        ["3/31/2027 Payment (100.00)", "4/1/2027 RES RENT (04/2027) 3,000.00", "4/1/2027 Trash (04/2027) 15.00", "4/1/2027 PARKING (04/2027) 120.00", "4/1/2027 :Tax PARKING (04/2027) 7.50"].join("\n"),
        "3,042.50",
      ),
    );
    expect(o.parserId).toBe("yardi-rent-bill");
    expect(o.doc).toMatchObject({ kind: "STATEMENT", institution: "EXAMPLE PROPERTIES LLC", title: "Rent bill", warnings: [] });
    const s = o.doc.sections[0]!;
    expect(s).toMatchObject({
      accountNumber: "T0001234",
      kind: "OTHER",
      subtype: "BILL",
      periodStart: "2027-03-25",
      periodEnd: "2027-03-25",
      openingBalanceCents: 0,
      closingBalanceCents: -304_250,
      paymentsFromPrior: true,
    });
    expect(s.transactions.map((t) => [t.date, t.description, t.amountCents])).toEqual([
      ["2027-03-31", "Payment", 10_000],
      ["2027-04-01", "RES RENT (04/2027)", -300_000],
      ["2027-04-01", "Trash (04/2027)", -1_500],
      ["2027-04-01", "PARKING (04/2027)", -12_000],
      ["2027-04-01", ":Tax PARKING (04/2027)", -750],
    ]);
    expect(validateDocument(o.doc).ok).toBe(true);
  });

  it("holds a bill whose items don't add up to the amount due", () => {
    const o = parse(bill("4/1/2027 RES RENT (04/2027) 3,000.00", "3,010.00"));
    expect(validateDocument(o.doc).sections[0]!.failedChecks).toEqual([{ label: "Bill items add up to the amount due", expectedCents: 301_000, actualCents: 300_000 }]);
  });

  it("ends the day before it's due without a payments-processed date", () => {
    const o = parse(bill("5/1/2027 Trash (05/2027) 15.00", "15.00", "5/1/2027", null));
    expect(o.doc.sections[0]!.periodEnd).toBe("2027-04-30");
    expect(o.doc.warnings).toHaveLength(1);
  });

  it("files charges as housing, parking as transportation and payments as transfers", () => {
    const file = (description: string, amountCents: number, section?: string) =>
      classifyTransaction({ institution: "EXAMPLE PROPERTIES LLC", accountSubtype: "BILL", description, amountCents, section, date: "2027-04-01" }, { mergeDate: "2020-01-01", userRules: [] });
    expect(file("RES RENT (04/2027)", -300_000)).toMatchObject({ lane: "EXPENSE", category: "Housing & utilities" });
    expect(file("Pet Rent", 5_000, "Payments and credits")).toMatchObject({ lane: "EXPENSE", category: "Housing & utilities" });
    expect(file(":Tax PARKING (04/2027)", -750)).toMatchObject({ lane: "EXPENSE", category: "Transportation" });
    expect(file("Payment", 10_000, "Payments and credits")).toMatchObject({ lane: "TRANSFER", counterparty: { kind: "OWN_ACCOUNT", subtypes: ["CHECKING", "SAVINGS"] } });
    expect(file(BILL_PAYMENTS, 304_250, BILL_PAYMENTS)).toMatchObject({ lane: "TRANSFER" });
  });
});

describe("a bill carried on from the previous one", () => {
  const april = parse(bill(["4/1/2027 RES RENT (04/2027) 3,000.00", "4/1/2027 Trash (04/2027) 15.00"].join("\n"), "3,015.00")).doc.sections[0]!;
  const may = (items: string[], total: string) => parse(bill(items.join("\n"), total, "5/1/2027", "04-25-2027")).doc.sections[0]!;

  it("opens at the previous bill's balance and says what was paid in between", () => {
    const s = continueBill(may(["5/1/2027 RES RENT (05/2027) 3,000.00", "5/1/2027 Trash (05/2027) 15.00"], "3,015.00"), april, april.transactions);
    expect(s).toMatchObject({ periodStart: "2027-03-26", periodEnd: "2027-04-25", openingBalanceCents: -301_500, closingBalanceCents: -301_500 });
    expect(s.transactions.at(-1)).toEqual({ date: "2027-04-25", datePrecision: "PERIOD", description: BILL_PAYMENTS, amountCents: 301_500, section: BILL_PAYMENTS });
    const sum = s.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect(s.openingBalanceCents + sum).toBe(s.closingBalanceCents);
  });

  it("doesn't count a charge still unpaid from the previous bill again", () => {
    // April's trash wasn't paid: it's still listed, and only $3,000 was paid.
    const s = continueBill(may(["4/1/2027 Trash (04/2027) 15.00", "5/1/2027 RES RENT (05/2027) 3,000.00", "5/1/2027 Trash (05/2027) 15.00"], "3,030.00"), april, april.transactions);
    expect(s.transactions.map((t) => [t.description, t.amountCents])).toEqual([
      ["RES RENT (05/2027)", -300_000],
      ["Trash (05/2027)", -1_500],
      [BILL_PAYMENTS, 300_000],
    ]);
  });
});
