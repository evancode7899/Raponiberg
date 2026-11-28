import { LAYOUT_HEADER, parseLayout, type LayoutCell } from "../../statements/pdfLayout.ts";
import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate, resolveMonthDay } from "../text.ts";

export const ELAN_CARD_PARSER_ID = "elan-card";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

/** Elan Financial Services issues co-branded cards (the Fidelity Rewards Visa among them). */
export const ELAN_INSTITUTION = "Elan";

export function detectElanCard(text: string): boolean {
  return /Elan Financial Services/.test(text) && /Closing Date: \d{2}\/\d{2}\/\d{4}/.test(text) && /Account ending in: \d{4}/.test(text);
}

const MONEY = String.raw`\$[\d,]+\.\d{2}`;
const AMOUNT_CELL = new RegExp(String.raw`^(${MONEY})( CR)?$`);
/** "09 / 18": the positioned layout keeps the spaces pdf.js puts around the slash. */
const DATE_CELL = /^(\d{2}) \/ (\d{2})$/;
/** Columns, in points from the left edge: post date, transaction date, then reference number and description. */
const POST_DATE_MAX_X = 95;
const DESCRIPTION_MIN_X = 165;

type Section = "Payments" | "Charges" | "Credits" | "Fees" | "Interest";

/**
 * Elan card statements (the Fidelity Rewards Visa Signature, among others). Page 1 has the
 * Activity Summary (previous balance, payments, other credits, purchases, balance transfers,
 * advances, other debits, fees, interest, new balance). The rows follow under "Account
 * Payments and Credits", then per cardholder ("PAT E - 1234: Purchases and Other Debits",
 * ": Other Credits", ": Fees"), each block closed by its own "TOTAL THIS PERIOD".
 *
 * The plain text is unusable for the rows: pdf.js emits the headings, totals and rows of a
 * page in separate runs, and a credit's "CR" marker lands lines away from its amount. So the
 * rows are read from the positioned layout (extractPdfText appends it for this issuer),
 * where each row keeps its cells: post date, transaction date (blank on some payments),
 * reference number, description, amount ("$12.34" or "$12.34 CR"). The summary and the
 * period come from the plain text, which reads them fine.
 *
 * Charges are positive on the statement; the ledger stores a card owing money as negative,
 * so a charge is booked negative and a CR row positive.
 */
export function parseElanCard(text: string): ParsedDocument {
  const layoutAt = text.indexOf(LAYOUT_HEADER);
  if (layoutAt < 0) throw new Error("Elan: the statement's positioned layout is missing");
  const ls = lines(text.slice(0, layoutAt)).map(collapseSpaces);
  const warnings: string[] = [];

  const head = ls.map((l) => /Open Date: (\d{2}\/\d{2}\/\d{4}) Closing Date: (\d{2}\/\d{2}\/\d{4}) Account ending in: (\d{4})/.exec(l)).find(Boolean);
  if (!head) throw new Error("Elan: open date, closing date and account number not found");
  const periodStart = parseSlashDate(head[1]!)!;
  const periodEnd = parseSlashDate(head[2]!)!;
  const accountNumber = head[3]!;

  // "Fidelity® Rewards Visa Signature® Card Elan Financial" → "Fidelity Rewards Visa Signature"
  const product = ls.map((l) => /^(.+?) Card Elan Financial/.exec(l)).find(Boolean)?.[1];
  const accountName = product ? collapseSpaces(product.replace(/[®™]/g, "")) : "Elan Visa";

  // ---- Activity Summary (first occurrence; every figure printed unsigned) ----
  const summary = (label: string): number => {
    const re = new RegExp(String.raw`^${label} (?:[+=-] )?(${MONEY})$`);
    const l = ls.find((x) => re.test(x));
    if (!l) throw new Error(`Elan: "${label}" not found in the activity summary`);
    return parseMoney(re.exec(l)![1]!)!;
  };
  const previous = summary("Previous Balance");
  const paymentsTotal = summary("Payments");
  const otherCredits = summary("Other Credits");
  const purchases = summary("Purchases");
  const balanceTransfers = summary("Balance Transfers");
  const advances = summary("Advances");
  const otherDebits = summary("Other Debits");
  const feesTotal = summary("Fees Charged");
  const interestTotal = summary("Interest Charged");
  const newBalance = summary("New Balance");

  // ---- Rows (positioned layout) ----
  const transactions: ParsedTransaction[] = [];
  const sums = { payments: 0, credits: 0, charges: 0, fees: 0, interest: 0 };
  const blockTotals: { label: string; expectedCents: number; actualCents: number }[] = [];
  let section: Section | null = null;
  let blockSum = 0;
  let cardMember: string | undefined;
  let last: { tx: ParsedTransaction; page: number; y: number } | null = null;

  const openSection = (s: Section, member?: string) => {
    // A block running onto the next page repeats its heading: it's still the same block.
    if (section === s && cardMember === member) { last = null; return; }
    section = s;
    cardMember = member;
    blockSum = 0;
    last = null;
  };

  for (const row of parseLayout(text.slice(layoutAt))) {
    const cells = row.cells;
    const first = cells[0]?.text ?? "";
    const joined = cells.map((c) => c.text).join(" ");

    if (first === "Account Payments and Credits") { openSection("Payments"); continue; }
    if (first === "Account Fees") { openSection("Fees"); continue; }
    const member = /^(.+?) - \d{4}: (Purchases and Other Debits|Other Credits|Fees|Interest Charged)$/.exec(first);
    if (member) {
      const kind = member[2]!;
      openSection(kind === "Other Credits" ? "Credits" : kind === "Fees" ? "Fees" : kind === "Interest Charged" ? "Interest" : "Charges", member[1]);
      continue;
    }
    if (section == null) continue;

    const amountCell = cells.at(-1);
    const amount = amountCell ? AMOUNT_CELL.exec(amountCell.text) : null;

    // "TOTAL THIS PERIOD $442.13" / "TOTAL FEES THIS PERIOD $0.00" closes the block.
    if (/^TOTAL (FEES |INTEREST )?THIS PERIOD$/.test(cells.find((c) => /^TOTAL /.test(c.text))?.text ?? "")) {
      if (amount) blockTotals.push({ label: `${section} rows = the block's "TOTAL THIS PERIOD"`, expectedCents: parseMoney(amount[1]!)!, actualCents: blockSum });
      section = null;
      last = null;
      continue;
    }

    const post = DATE_CELL.exec(first);
    if (post && cells[0]!.x0 < POST_DATE_MAX_X && amount) {
      const trans = cells.slice(1).find((c) => c.x0 < DESCRIPTION_MIN_X - 30 && DATE_CELL.test(c.text));
      const [, mm, dd] = DATE_CELL.exec((trans ?? cells[0]!).text)!;
      const description = descriptionOf(cells.slice(1, -1));
      const printed = parseMoney(amount[1]!)!;
      const credit = amount[2] != null;
      // `section` is set inside openSection, which narrowing can't see: widen it back.
      let kind = section as Section;
      if (/INTEREST CHARGE/i.test(description)) kind = "Interest";
      else if (section === "Payments" && !/PAYMENT/i.test(description)) kind = "Credits";
      const signed = credit ? printed : -printed;
      if (kind === "Payments") sums.payments += signed;
      else if (kind === "Credits") sums.credits += signed;
      else if (kind === "Fees") sums.fees -= signed;
      else if (kind === "Interest") sums.interest -= signed;
      else sums.charges -= signed;
      blockSum += printed;
      const tx: ParsedTransaction = {
        date: resolveMonthDay(`${mm}/${dd}`, periodStart, periodEnd),
        datePrecision: "EXACT",
        description,
        amountCents: signed,
        section: kind === "Charges" ? undefined : kind,
        cardMember,
      };
      transactions.push(tx);
      last = { tx, page: row.page, y: row.y };
      continue;
    }

    // A second description line ("MERCHANDISE/SERVICE RETURN") right under its row.
    if (last && row.page === last.page && last.y - row.y < 16 && !amount && cells.every((c) => c.x0 >= DESCRIPTION_MIN_X)) {
      last.tx.detail = collapseSpaces([last.tx.detail, joined].filter(Boolean).join(" "));
      last.y = row.y;
      continue;
    }
    last = null;
    if (amount && !/^\$0\.00$/.test(joined)) warnings.push(`Unrecognized line in ${section}: ${joined}`);
  }

  return {
    parserId: ELAN_CARD_PARSER_ID,
    parserVersion: VERSION,
    institution: ELAN_INSTITUTION,
    kind: "STATEMENT",
    title: `${accountName} statement`,
    periodStart,
    periodEnd,
    sections: [
      {
        institution: ELAN_INSTITUTION,
        accountNumber,
        accountName,
        kind: "CREDIT_CARD",
        subtype: "CREDIT_CARD",
        periodStart,
        periodEnd,
        openingBalanceCents: -previous || 0,
        closingBalanceCents: -newBalance || 0,
        growthCents: 0,
        feesCents: 0,
        transactions,
        checks: [
          { label: "Payment rows = summary payments", expectedCents: paymentsTotal, actualCents: sums.payments },
          { label: "Credit rows = summary other credits", expectedCents: otherCredits, actualCents: sums.credits },
          { label: "Purchase rows = summary purchases + balance transfers + advances + other debits", expectedCents: purchases + balanceTransfers + advances + otherDebits, actualCents: sums.charges },
          { label: "Fee rows = summary fees", expectedCents: feesTotal, actualCents: sums.fees },
          { label: "Interest rows = summary interest", expectedCents: interestTotal, actualCents: sums.interest },
          ...blockTotals,
          {
            label: "Previous balance + activity = new balance",
            expectedCents: newBalance,
            actualCents: previous - paymentsTotal - otherCredits + purchases + balanceTransfers + advances + otherDebits + feesTotal + interestTotal,
          },
        ],
      },
    ],
    warnings,
  };
}

/** Description cells after the dates: drops the reference number ("2688", "ET"), keeps the merchant and its city/state. */
function descriptionOf(cells: LayoutCell[]): string {
  const rest = cells.filter((c) => !DATE_CELL.test(c.text));
  const body = rest.filter((c) => c.x0 >= DESCRIPTION_MIN_X);
  const ref = rest.find((c) => c.x0 < DESCRIPTION_MIN_X);
  // Electronic payments print "ET" in the reference column; it reads as part of the description.
  const prefix = ref && !/^\d+$/.test(ref.text) ? `${ref.text} ` : "";
  return collapseSpaces(prefix + body.map((c) => c.text).join(" "));
}
