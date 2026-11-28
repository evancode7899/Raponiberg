import { describe, expect, it } from "vitest";
import { classifyTransaction } from "../../classifier/classify.ts";
import { validateDocument } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic statement in Elan's real extracted layout: the plain text first (headings, totals
// and rows in scrambled runs, as pdf.js emits them), then the positioned layout extractPdfText
// appends. Names and figures are made up.
const PLAIN = `Open Date: 02/11/2026 Closing Date: 03/12/2026 Account ending in: 1234
Page 1 of 4
PAT Q EXAMPLE
Previous Balance + $80.00
Payments - $80.00
Other Credits - $7.50
Purchases + $251.25
Balance Transfers $0.00
Advances $0.00
Other Debits $0.00
Fees Charged $0.00
Interest Charged $0.00
New Balance $243.75
Payment Due Date 04/09/2026
Fidelity® Rewards Visa Signature® Card Elan Financial
Services
March 2026 Statement
Elan Financial Services
Account Payments and Credits
CR
TOTAL THIS PERIOD $80.00
02/20 ET PAYMENT: THANK YOU $80.00
`;

const LAYOUT = [
  "[pdf-layout]",
  "@1:687\t50-271 Open Date: 02 / 11 / 20 26 Closing Date: 03 / 12 / 20 26\t425-533 Account ending in: 1234",
  "@3:142\t65-212 Account Payments and Credits",
  "@3:97\t65-87 02 / 20\t137-148 ET\t173-274 PAYMENT: THANK YOU\t482-525 $80.00 CR",
  "@3:82\t353-443 TOTAL THIS PERIOD\t482-525 $80.00 CR",
  "@4:647\t65-130 Account Fees",
  "@4:587\t327-443 TOTAL FEES THIS PERIOD\t492-515 $0.00",
  "@4:568\t65-274 PAT E - 1234: Purchases and Other Debits",
  "@4:540\t65-87 02 / 14\t101-123 02 / 12\t137-157 1111\t173-336 SPRINGFIELD GROCERS SPRINGFIELD\t351-365 IL\t487-525 $41.25",
  "@4:525\t65-87 02 / 28\t101-123 02 / 27\t137-157 2222\t173-336 EXAMPLE HARDWARE SPRINGFIELD\t351-365 IL\t487-525 $60.00",
  // The block runs onto the next page, which repeats its heading.
  "@5:647\t65-274 PAT E - 1234: Purchases and Other Debits",
  "@5:620\t65-87 03 / 10\t101-123 03 / 09\t137-157 3333\t173-336 SAMPLE TRANSIT TICKET\t351-365 IL\t475-525 $150.00",
  "@5:460\t353-443 TOTAL THIS PERIOD\t475-515 $251.25",
  "@5:442\t65-204 PAT E - 1234: Other Credits",
  "@5:420\t65-87 03 / 02\t101-123 02 / 28\t137-157 4444\t173-336 EXAMPLE HARDWARE SPRINGFIELD\t351-365 IL\t487-525 $7.50 CR",
  "@5:410\t173-321 MERCHANDISE/SERVICE RETURN",
  "@5:396\t353-443 TOTAL THIS PERIOD\t487-525 $7.50 CR",
  "@5:362\t65-163 PAT E - 1234: Fees",
  "@5:302\t327-443 TOTAL FEES THIS PERIOD\t492-515 $0.00",
  "@5:254\t174-286 Total Fees Charged in 2026\t371-393 $0.00",
].join("\n");

const TEXT = `${PLAIN}\n\n${LAYOUT}\n`;

describe("Elan card statements", () => {
  const parsed = parseStatementText(TEXT);
  if (!parsed.ok) throw new Error(`not parsed: ${JSON.stringify(parsed)}`);
  const doc = parsed.doc;
  const section = doc.sections[0]!;
  const by = (d: string) => section.transactions.find((t) => t.description.includes(d))!;

  it("is recognized as an Elan card statement for the Fidelity Rewards Visa", () => {
    expect(parsed.parserId).toBe("elan-card");
    expect(section).toMatchObject({
      institution: "Elan",
      accountNumber: "1234",
      accountName: "Fidelity Rewards Visa Signature",
      subtype: "CREDIT_CARD",
      periodStart: "2026-02-11",
      periodEnd: "2026-03-12",
      openingBalanceCents: -8_000,
      closingBalanceCents: -24_375,
    });
  });

  it("ties out every check, including the block that spans two pages", () => {
    expect(validateDocument(doc).ok).toBe(true);
    expect(section.checks.every((c) => c.expectedCents === c.actualCents)).toBe(true);
    expect(doc.warnings).toEqual([]);
  });

  it("signs charges negative and CR rows positive, with the right sections and dates", () => {
    expect(section.transactions).toHaveLength(5);
    expect(by("PAYMENT")).toMatchObject({ date: "2026-02-20", amountCents: 8_000, section: "Payments", description: "ET PAYMENT: THANK YOU" });
    expect(by("SPRINGFIELD GROCERS")).toMatchObject({ date: "2026-02-12", amountCents: -4_125, section: undefined, cardMember: "PAT E" });
    expect(by("SAMPLE TRANSIT")).toMatchObject({ date: "2026-03-09", amountCents: -15_000 });
    const refund = section.transactions.find((t) => t.section === "Credits")!;
    expect(refund).toMatchObject({ date: "2026-02-28", amountCents: 750, detail: "MERCHANDISE/SERVICE RETURN" });
  });

  it("fails a check when a row is missing, instead of passing silently", () => {
    const short = parseStatementText(TEXT.replace(/^@5:620.*$/m, ""));
    if (!short.ok) throw new Error("not parsed");
    expect(validateDocument(short.doc).ok).toBe(false);
  });

  it("files the card's payment row as an own-account transfer", () => {
    const t = by("PAYMENT");
    const c = classifyTransaction(
      { institution: "Elan", accountSubtype: "CREDIT_CARD", section: t.section, description: t.description, amountCents: t.amountCents, date: t.date },
      { mergeDate: "2024-12-01", userRules: [] },
    );
    expect(c.lane).toBe("TRANSFER");
  });
});
