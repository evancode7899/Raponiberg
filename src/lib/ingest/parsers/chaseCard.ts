import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, resolveMonthDay } from "../text.ts";

export const CHASE_CARD_PARSER_ID = "chase-card";
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 1;

export function detectChaseCard(text: string): boolean {
  return /chase\.com\/cardhelp/.test(text) && /Opening\/Closing Date \d{2}\/\d{2}\/\d{2} - \d{2}\/\d{2}\/\d{2}/.test(text) && /Previous Balance/.test(text);
}

/** "07/13 MAPLE CAFE OTTAWA ON 30.13", "07/14 FOREIGN TRANSACTION FEE .90" */
const ROW = /^(\d{2}\/\d{2}) (.+?) (-?[\d,]*\.\d{2})$/;
/** Foreign-currency detail under a purchase: "07/14 CANADIAN DOLLAR", "41.00 X 0.734878048 (EXCHG RATE)". */
const FX_RATE = /^[\d,]+\.\d{2} X [\d.]+ \(EXCHG RATE\)$/;

const toIso = (mmddyy: string) => {
  const [m, d, y] = mmddyy.split("/");
  return `20${y}-${m}-${d}`;
};

/**
 * Chase credit card statements (Freedom Unlimited and other Chase cards). Page 1 has
 * the Account Summary — previous balance, payments & credits, purchases, cash advances,
 * balance transfers, fees, interest, new balance — and the Opening/Closing Date; Account
 * Activity lists dated rows ("MM/DD description amount"), payments negative. Foreign
 * purchases carry their currency and rate on the following lines, and the foreign
 * transaction fee is its own row. Charges are positive on the statement; the ledger
 * stores a card owing money as negative, so every sign is flipped.
 */
export function parseChaseCard(text: string): ParsedDocument {
  const ls = lines(text.split("[pdf-layout]")[0]!).map(collapseSpaces);
  const warnings: string[] = [];

  const period = /Opening\/Closing Date (\d{2}\/\d{2}\/\d{2}) - (\d{2}\/\d{2}\/\d{2})/.exec(ls.join("\n"));
  if (!period) throw new Error("Chase card: opening/closing date not found");
  const periodStart = toIso(period[1]!);
  const periodEnd = toIso(period[2]!);
  const acct = ls.map((l) => /^Account Number: (?:[X\d]{4} ){3}(\d{4})$/i.exec(l)).find(Boolean);
  if (!acct) throw new Error("Chase card: account number not found");
  const accountNumber = acct[1]!;
  const productLine = ls.find((l) => /^CHASE [A-Z ]+$/.test(l) && !/CARD SERVICES/.test(l));
  const accountName = productLine ? productLine.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : "Chase Card";

  const summary = (label: string): number => {
    const re = new RegExp(String.raw`^${label} ([+-]?\$[\d,]+\.\d{2})$`);
    const l = ls.find((x) => re.test(x));
    if (!l) throw new Error(`Chase card: "${label}" not found in the account summary`);
    return parseMoney(re.exec(l)![1]!.replace(/^\+/, ""))!;
  };
  const previous = summary("Previous Balance");
  const paymentsCredits = summary("Payment, Credits");
  const purchases = summary("Purchases");
  const cashAdvances = summary("Cash Advances");
  const balanceTransfers = summary("Balance Transfers");
  const feesCharged = summary("Fees Charged");
  const interestCharged = summary("Interest Charged");
  const newBalance = summary("New Balance");

  // ---- Rows: everything dated between the activity header and the year-to-date totals ----
  const start = ls.findIndex((l) => /^Transaction Merchant Name or Transaction Description \$ Amount$/.test(l));
  const end = ls.findIndex((l, i) => i > start && /^Total fees charged in \d{4}/.test(l));
  if (start < 0) throw new Error("Chase card: account activity not found");
  const transactions: ParsedTransaction[] = [];
  const sums = { payments: 0, purchases: 0, fees: 0, interest: 0 };
  let last: ParsedTransaction | null = null;
  for (const l of ls.slice(start + 1, end < 0 ? undefined : end)) {
    if (FX_RATE.test(l)) {
      if (last) last.detail = `${last.detail ? `${last.detail} ` : ""}${l}`;
      continue;
    }
    const row = ROW.exec(l);
    if (!row) {
      // A currency line ("07/14 CANADIAN DOLLAR") belongs to the purchase above it.
      if (last && /^\d{2}\/\d{2} [A-Z ]+$/.test(l)) last.detail = l.slice(6);
      continue;
    }
    const printed = parseMoney(row[3]!.startsWith(".") || row[3]!.startsWith("-.") ? row[3]!.replace(".", "0.") : row[3]!)!;
    const description = row[2]!;
    let kind: "Payments" | "Credits" | "Fees" | "Interest" | undefined;
    if (printed < 0) {
      kind = /PAYMENT/i.test(description) ? "Payments" : "Credits";
      sums.payments += printed;
    } else if (/INTEREST CHARGE/i.test(description)) {
      kind = "Interest";
      sums.interest += printed;
    } else if (/\bFEE\b/i.test(description)) {
      kind = "Fees";
      sums.fees += printed;
    } else sums.purchases += printed;
    last = { date: resolveMonthDay(row[1]!, periodStart, periodEnd), datePrecision: "EXACT", description, amountCents: -printed, section: kind };
    transactions.push(last);
  }
  if (transactions.length === 0 && previous !== newBalance) warnings.push("No activity rows found, but the balance changed.");

  return {
    parserId: CHASE_CARD_PARSER_ID,
    parserVersion: VERSION,
    institution: "Chase",
    kind: "STATEMENT",
    title: `${accountName} statement`,
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "Chase",
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
          { label: "Payment and credit rows = summary payments, credits", expectedCents: paymentsCredits, actualCents: sums.payments },
          { label: "Purchase rows = summary purchases + cash advances + balance transfers", expectedCents: purchases + cashAdvances + balanceTransfers, actualCents: sums.purchases },
          { label: "Fee rows = summary fees", expectedCents: feesCharged, actualCents: sums.fees },
          { label: "Interest rows = summary interest", expectedCents: interestCharged, actualCents: sums.interest },
          {
            label: "Previous balance + activity = new balance",
            expectedCents: newBalance,
            actualCents: previous + paymentsCredits + purchases + cashAdvances + balanceTransfers + feesCharged + interestCharged,
          },
        ],
      },
    ],
    warnings,
  };
}
