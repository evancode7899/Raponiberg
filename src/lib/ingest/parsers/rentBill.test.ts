import { describe, expect, it } from "vitest";
import { validateDocument } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic bill in Yardi RentCafe's real text layout (names and figures are made up).
const bill = (items: string, total: string, due = "4/1/2027") => `DUE DATE ${due}
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
Reflects payments processed through 03-25-2027
Date Item Desciption Amount
${items}
TOTAL: $${total}
6 DETACH AND RETURN COUPON WITH YOUR PAYMENT 6
DUE DATE ${due}
AMOUNT DUE $${total}

-- 1 of 1 --
`;

describe("Yardi rent bill", () => {
  it("is a supporting document dated to the month the rent covers", () => {
    const o = parseStatementText(
      bill(
        ["4/1/2027 RES RENT (04/2027) 3,000.00", "4/1/2027 Trash (04/2027) 15.00", "3/31/2027 Payment (100.00)"].join("\n"),
        "2,915.00",
      ),
    );
    if (!o.ok) throw new Error(JSON.stringify(o));
    expect(o.parserId).toBe("yardi-rent-bill");
    expect(o.doc).toMatchObject({
      kind: "SUPPORTING",
      institution: "EXAMPLE PROPERTIES LLC",
      title: "Rent bill",
      periodStart: "2027-04-01",
      periodEnd: "2027-04-30",
      sections: [],
      warnings: [],
    });
    expect(validateDocument(o.doc).ok).toBe(true);
  });

  it("warns when the items don't add up to the total", () => {
    const o = parseStatementText(bill("4/1/2027 RES RENT (04/2027) 3,000.00", "3,010.00"));
    if (!o.ok) throw new Error(JSON.stringify(o));
    expect(o.doc.warnings).toEqual(["Bill items add up to 300000¢, not the printed total of 301000¢"]);
  });

  it("falls back to the due date's month without a rent line", () => {
    const o = parseStatementText(bill("4/1/2027 Trash (04/2027) 15.00", "15.00", "5/1/2027"));
    if (!o.ok) throw new Error(JSON.stringify(o));
    expect(o.doc.periodStart).toBe("2027-05-01");
    expect(o.doc.warnings).toHaveLength(1);
  });
});
