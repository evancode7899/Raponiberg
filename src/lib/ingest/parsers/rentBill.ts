import { endOfMonth, ymd } from "../../dates/isoDate.ts";
import type { ParsedDocument } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate } from "../text.ts";

export const RENT_BILL_PARSER_ID = "yardi-rent-bill";
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 1;

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
 * A landlord's rent bill from Yardi's RentCafe portal. It is an invoice, not a money
 * movement: the rent itself is paid from a bank or card account whose statement records
 * it, so the bill is kept as a supporting document and never adds to the ledger. It is
 * dated to the month the rent covers (the "RES RENT (MM/YYYY)" line, else the due date),
 * which is usually the month after the one it was issued in.
 */
export function parseRentBill(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];

  const due = parseSlashDate(/^DUE DATE (\S+)/m.exec(text)?.[1] ?? "");
  if (!due) throw new Error("Rent bill: due date not found");
  const totalLine = ls.find((l) => /^TOTAL: /.test(l));
  const total = totalLine ? parseMoney(totalLine.slice("TOTAL: ".length)) : null;
  if (total == null) throw new Error("Rent bill: total not found");

  // The property manager is printed right after the first "AMOUNT DUE" line.
  const amountIdx = ls.findIndex((l) => /^AMOUNT DUE \$/.test(l));
  const manager = amountIdx >= 0 ? ls[amountIdx + 1] : undefined;
  const institution = manager && !/^Dear /i.test(manager) ? collapseSpaces(manager) : "Landlord";

  const start = ls.findIndex((l) => /^Date Item Desc/i.test(l));
  const end = ls.findIndex((l, i) => i > start && /^TOTAL: /.test(l));
  let itemized = 0;
  for (const l of start >= 0 && end > start ? ls.slice(start + 1, end) : []) {
    const m = ITEM.exec(l);
    if (!m) {
      warnings.push(`Unread bill line "${l}"`);
      continue;
    }
    itemized += parseMoney(m[3]!)!;
  }
  if (itemized !== total) warnings.push(`Bill items add up to ${itemized}¢, not the printed total of ${total}¢`);

  const covered = /RES RENT \((\d{2})\/(\d{4})\)/.exec(text);
  const periodStart = covered ? ymd(Number(covered[2]), Number(covered[1]), 1) : `${due.slice(0, 7)}-01`;
  if (!covered) warnings.push("No rent line names the month covered; dated to the due date's month");

  return {
    parserId: RENT_BILL_PARSER_ID,
    parserVersion: VERSION,
    institution,
    kind: "SUPPORTING",
    title: "Rent bill",
    periodStart,
    periodEnd: endOfMonth(periodStart),
    sections: [],
    warnings,
  };
}
