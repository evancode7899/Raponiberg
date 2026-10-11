import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseMonthNameDate, resolveMonthDay } from "../text.ts";

export const CAPITAL_ONE_PARSER_ID = "capital-one-card";
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 1;

export function detectCapitalOne(text: string): boolean {
  return /capitalone\.com/.test(text) && /days in Billing Cycle/.test(text) && /Account ending in \d{4}/.test(text);
}

const MONEY = String.raw`-?\s?\$[\d,]+\.\d{2}`;
/** "Sep 19 Sep 20 TRATTORIA ROMA $5.36" / "Oct 14 Oct 14 CAPITAL ONE AUTOPAY PYMT - $120.00" */
const ROW = new RegExp(String.raw`^([A-Z][a-z]{2} \d{1,2})(?: ([A-Z][a-z]{2} \d{1,2}))? (.+?) (${MONEY})$`);
const MEMBER_HEADER = /^(.+?) #(\d{4}): (Payments, Credits and Adjustments|Transactions)$/;
/** Foreign-currency rows print the original amount, currency and rate on the next lines. */
const FX_AMOUNT = /^\$[\d,]+\.\d{2}$/;
const FX_CURRENCY = /^[A-Z]{3}$/;
const FX_RATE = /^([\d.]+) Exchange Rate$/;
/** Page furniture repeated on every page; never part of a row. */
const NOISE = /^(Trans Date Post Date Description Amount$|Transactions \(Continued\)$|Additional Information on the next page$|Page \d+ of \d+$|-- \d+ of \d+ --$|Visit capitalone\.com|.+ ending in \d{4}$|[A-Z][a-z]{2} \d{1,2}, \d{4} - [A-Z][a-z]{2} \d{1,2}, \d{4} \| \d+ days in Billing Cycle$)/;

type Section = "Payments" | "Charges" | "Fees" | "Interest";

/**
 * Capital One card statements. Page 1 has the Account Summary (previous balance,
 * payments, other credits, transactions, cash advances, fees, interest, new balance);
 * the rows follow per cardholder as "Trans Date  Post Date  Description  Amount" under
 * "Payments, Credits and Adjustments" and "Transactions", then a Fees block. Interest
 * isn't itemized by date — it is printed per balance type and booked at period end.
 * The card number on the statement can change (product change / reissue) while the
 * account stays the same; resolveAccount links contiguous statements, the owner merges
 * the rest. Charges are positive on the statement; the ledger stores a card owing money
 * as negative, so every sign is flipped.
 */
export function parseCapitalOne(text: string): ParsedDocument {
  const ls = lines(text).map(collapseSpaces);
  const warnings: string[] = [];

  const period = /([A-Z][a-z]{2} \d{1,2}, \d{4}) - ([A-Z][a-z]{2} \d{1,2}, \d{4}) \| \d+ days in Billing Cycle/.exec(ls.join("\n"));
  if (!period) throw new Error("Capital One: billing cycle not found");
  const periodStart = parseMonthNameDate(period[1]!)!;
  const periodEnd = parseMonthNameDate(period[2]!)!;

  const acct = ls.map((l) => /Account ending in (\d{4})$/.exec(l)).find(Boolean);
  if (!acct) throw new Error("Capital One: account number not found");
  const accountNumber = acct[1]!;
  // "Quicksilver Credit Card | World Elite Mastercard ending in 1234" → "Capital One Quicksilver"
  const productLine = ls.find((l) => / \| .+ ending in \d{4}$/.test(l));
  const product = productLine ? productLine.split(" | ")[0]!.replace(/ (Credit )?Card$/, "") : "Card";
  const accountName = `Capital One ${product}`;

  // ---- Account Summary (first occurrence; signed as the change to the amount owed) ----
  const summary = (label: string): number => {
    const re = new RegExp(String.raw`^${label} [+=]?\s?(${MONEY})$`);
    const l = ls.find((x) => re.test(x));
    if (!l) throw new Error(`Capital One: "${label}" not found in the account summary`);
    return parseMoney(re.exec(l)![1]!)!;
  };
  const previous = summary("Previous Balance");
  const paymentsTotal = summary("Payments");
  const otherCredits = summary("Other Credits");
  const transactionsTotal = summary("Transactions");
  const cashAdvances = summary("Cash Advances");
  const feesTotal = summary("Fees Charged");
  const interestTotal = summary("Interest Charged");
  const newBalance = summary("New Balance");

  // ---- Rows ----
  const transactions: ParsedTransaction[] = [];
  const sums = { payments: 0, credits: 0, charges: 0, fees: 0, interest: 0 };
  let section: Section | null = null;
  let cardMember: string | undefined;
  let last: ParsedTransaction | null = null;
  const dateOf = (monDay: string) =>
    resolveMonthDay(parseMonthNameDate(`${monDay}, 2000`)!.slice(5).replace("-", "/"), periodStart, periodEnd);

  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const header = MEMBER_HEADER.exec(l);
    if (header) {
      cardMember = header[1];
      section = header[3] === "Transactions" ? "Charges" : "Payments";
      last = null;
      continue;
    }
    if (/^Fees$/.test(l)) { section = "Fees"; cardMember = undefined; last = null; continue; }
    if (/^Interest Charged$/.test(l)) { section = "Interest"; cardMember = undefined; last = null; continue; }
    if (/^(Totals Year-to-Date|Interest Charge Calculation)$/.test(l)) { section = null; last = null; continue; }
    if (section == null || NOISE.test(l) || /Total Transactions|^Total Fees for This Period/.test(l)) continue;

    if (section === "Interest") {
      // "Interest Charge on Purchases $1.23": one booked row per balance type, at period end.
      const m = new RegExp(String.raw`^(Interest Charge on .+?) (${MONEY})$`).exec(l);
      const printed = m ? parseMoney(m[2]!)! : 0;
      if (m && printed !== 0) {
        sums.interest += printed;
        transactions.push({ date: periodEnd, datePrecision: "EXACT", description: m[1]!.toUpperCase(), amountCents: -printed, section: "Interest" });
      }
      continue;
    }

    // Foreign-currency detail lines belong to the row just above them.
    if (last && FX_AMOUNT.test(l) && FX_CURRENCY.test(ls[i + 1] ?? "")) {
      const rate = FX_RATE.exec(ls[i + 2] ?? "");
      last.detail = `${l.slice(1)} ${ls[i + 1]}${rate ? ` @ ${rate[1]}` : ""}`;
      i += rate ? 2 : 1;
      continue;
    }

    const row = ROW.exec(l);
    if (!row) {
      warnings.push(`Unrecognized line in ${section}: ${l}`);
      continue;
    }
    const printed = parseMoney(row[4]!)!;
    // Payments carry their authorization stamp glued on: "CAPITAL ONE MOBILE PYMTAuthDate 21-Dec".
    const auth = /\s?(AuthDate .+)$/.exec(row[3]!);
    const description = collapseSpaces(auth ? row[3]!.slice(0, auth.index) : row[3]!);
    let kind: string;
    if (section === "Payments") {
      kind = /PYMT|PAYMENT/i.test(description) ? "Payments" : "Credits";
      if (kind === "Payments") sums.payments += printed;
      else sums.credits += printed;
    } else if (section === "Fees") {
      kind = "Fees";
      sums.fees += printed;
    } else {
      kind = "Charges";
      sums.charges += printed;
    }
    last = {
      date: dateOf(row[1]!),
      datePrecision: "EXACT",
      description,
      amountCents: -printed,
      section: kind === "Charges" ? undefined : kind,
      detail: auth?.[1],
      cardMember,
    };
    transactions.push(last);
  }

  const printedTotal = ls.map((l) => /^Total Transactions for This Period (\$[\d,]+\.\d{2})$/.exec(l)).find(Boolean);

  return {
    parserId: CAPITAL_ONE_PARSER_ID,
    parserVersion: VERSION,
    institution: "Capital One",
    kind: "STATEMENT",
    title: `${accountName} statement`,
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "Capital One",
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
          { label: "Transaction rows = summary transactions + cash advances", expectedCents: transactionsTotal + cashAdvances, actualCents: sums.charges },
          ...(printedTotal
            ? [{ label: "Transaction rows = \"Total Transactions for This Period\"", expectedCents: parseMoney(printedTotal[1]!)!, actualCents: sums.charges }]
            : []),
          { label: "Fee rows = summary fees", expectedCents: feesTotal, actualCents: sums.fees },
          { label: "Interest rows = summary interest", expectedCents: interestTotal, actualCents: sums.interest },
          {
            label: "Previous balance + activity = new balance",
            expectedCents: newBalance,
            actualCents: previous + paymentsTotal + otherCredits + transactionsTotal + cashAdvances + feesTotal + interestTotal,
          },
        ],
      },
    ],
    warnings,
  };
}
