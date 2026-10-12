import { addDays, ymd } from "../../dates/isoDate.ts";
import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate } from "../text.ts";

export const RENT_BILL_PARSER_ID = "yardi-rent-bill";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 3;

/**
 * Yardi's monthly rent invoice: a due date, an amount due and the month's charges under
 * its "Date Item Desciption Amount" header (Yardi's spelling), with a payment coupon. Only
 * some landlords print a RentCafe link, so the template is what's recognized.
 */
export function detectRentBill(text: string): boolean {
  return (
    /^DUE DATE \d/m.test(text) &&
    /AMOUNT DUE \$/.test(text) &&
    /Invoice For:/.test(text) &&
    /^Date Item Descr?iption Amount$/m.test(text) &&
    /DETACH AND RETURN COUPON/.test(text)
  );
}

const ITEM = /^(\d{1,2}\/\d{1,2}\/\d{4}) (.+?) (\(?[\d,]+\.\d{2}\)?)$/;

/**
 * A landlord's rent bill from Yardi's RentCafe portal, read as a statement of the
 * household's account with the landlord — the same as a card: each charge on it (rent,
 * fees, utilities, parking) is spending, and the bank payments that pay it are transfers
 * to it. What it prints is the charges still open as of "payments processed through"
 * (next month's charges are already posted, dated the 1st they cover), so:
 *
 * - the period ends on that date, and the balance then is the amount due;
 * - the charges are the rows, on the dates printed (rent counts in the month it covers);
 * - payments aren't listed once they've been applied, so the bill alone can't say what
 *   was paid: at commit the previous bill supplies the opening and one "Payments and
 *   credits" row explains the difference (see `paymentsFromPrior`).
 */
export function parseRentBill(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];

  const due = parseSlashDate(/^DUE DATE (\S+)/m.exec(text)?.[1] ?? "");
  if (!due) throw new Error("Rent bill: due date not found");
  const totalLine = ls.find((l) => /^TOTAL: /.test(l));
  const total = totalLine ? parseMoney(totalLine.slice("TOTAL: ".length)) : null;
  if (total == null) throw new Error("Rent bill: total not found");
  const accountNumber = /^ACCT NO\. (\S+)/m.exec(text)?.[1] ?? "unknown";

  // The property manager is printed right after the first "AMOUNT DUE" line.
  const amountIdx = ls.findIndex((l) => /^AMOUNT DUE \$/.test(l));
  const manager = amountIdx >= 0 ? ls[amountIdx + 1] : undefined;
  const institution = manager && !/^Dear /i.test(manager) ? collapseSpaces(manager) : "Landlord";

  const through = /Reflects payments processed through (\d{2})-(\d{2})-(\d{4})/.exec(text);
  const periodEnd = through ? ymd(Number(through[3]), Number(through[1]), Number(through[2])) : addDays(due, -1);
  if (!through) warnings.push("No \"payments processed through\" date; the bill is dated the day before it's due");

  const start = ls.findIndex((l) => /^Date Item Desc/i.test(l));
  const end = ls.findIndex((l, i) => i > start && /^TOTAL: /.test(l));
  const transactions: ParsedTransaction[] = [];
  // A line printed twice (a charge billed twice by mistake) is told apart as "#2", so a
  // decision about one copy (it was reversed) can name it and survive re-imports.
  const seen = new Map<string, number>();
  for (const l of start >= 0 && end > start ? ls.slice(start + 1, end) : []) {
    const m = ITEM.exec(l);
    const date = m ? parseSlashDate(m[1]!) : null;
    if (!m || !date) {
      warnings.push(`Unread bill line "${l}"`);
      continue;
    }
    // Printed as owed: a charge is positive, a payment or credit in parentheses.
    const printed = parseMoney(m[3]!)!;
    const description = collapseSpaces(m[2]!);
    const copy = `${date}|${description}|${printed}`;
    const n = (seen.get(copy) ?? 0) + 1;
    seen.set(copy, n);
    transactions.push({
      date,
      datePrecision: "EXACT",
      description: n > 1 ? `${description} #${n}` : description,
      amountCents: -printed,
      section: printed < 0 ? "Payments and credits" : "Charges",
    });
  }
  const itemized = -transactions.reduce((s, t) => s + t.amountCents, 0);

  return {
    parserId: RENT_BILL_PARSER_ID,
    parserVersion: VERSION,
    institution,
    kind: "STATEMENT",
    title: "Rent bill",
    periodStart: periodEnd,
    periodEnd,
    sections: [
      {
        institution,
        accountNumber,
        accountName: "Rent bill",
        kind: "OTHER",
        subtype: "BILL",
        // Until commit puts it after the previous bill: owing nothing before this one.
        periodStart: transactions.reduce((m, t) => (t.date < m ? t.date : m), periodEnd),
        periodEnd,
        openingBalanceCents: -total + itemized,
        closingBalanceCents: -total,
        growthCents: 0,
        feesCents: 0,
        transactions,
        paymentsFromPrior: true,
        checks: [{ label: "Bill items add up to the amount due", expectedCents: total, actualCents: itemized }],
      },
    ],
    warnings,
  };
}
