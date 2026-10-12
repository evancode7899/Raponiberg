import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseMonthNameDate } from "../text.ts";

export const BILT_PARSER_ID = "bilt-card";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

export function detectBilt(text: string): boolean {
  return /servicer of the Bilt Cards/.test(text) && /New balance as of/.test(text) && /Previous balance/.test(text);
}

const MONEY_END = /(-?\$[\d,]+\.\d{2})$/;
const ROW_START = /^([A-Z][a-z]{2} \d{1,2}, \d{4})\s+(.*)$/;
/** Page furniture repeated on every page; never part of a row (the holder's name too, see parseBilt). */
const NOISE = /^(\S+@\S+$|Bilt .*Card$|[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}, \d{4}$|Cardless Inc|are issued by|issued by Column|-- \d+ of \d+ --$|Date Description Amount$|\d{10,} Page \d+ of \d+$|For information about credit counseling|See Important Disclosures)/;

/**
 * Bilt (Cardless) credit card statements. Rows are "Mon D, YYYY  description  amount"
 * with the description wrapping onto a second line and the amount last, grouped under
 * Payments and credits / Transactions (primary cardmember) / the authorized user's own
 * block. Charges are positive on the statement; the ledger stores a card owing money
 * as negative, so every sign is flipped.
 */
export function parseBilt(text: string): ParsedDocument {
  const ls = lines(text).map(collapseSpaces);
  const warnings: string[] = [];
  // Each page's header prints the cardholder's name on the line above their email address.
  const holder = new Set(ls.filter((_, i) => /^\S+@\S+$/.test(ls[i + 1] ?? "")));

  const product = ls.find((l) => /^Bilt .*Card$/.test(l)) ?? "Bilt Card";
  const period = /([A-Z][a-z]{2} \d{1,2}) – ([A-Z][a-z]{2} \d{1,2}, \d{4})/.exec(text);
  if (!period) throw new Error("Bilt: statement period not found");
  const periodEnd = parseMonthNameDate(period[2]!)!;
  const endYear = Number(periodEnd.slice(0, 4));
  let periodStart = parseMonthNameDate(`${period[1]}, ${endYear}`)!;
  if (periodStart > periodEnd) periodStart = parseMonthNameDate(`${period[1]}, ${endYear - 1}`)!;

  const identifier = /^(\d{12,})\s+Page \d+ of \d+$/m.exec(text)?.[1];
  if (!identifier) throw new Error("Bilt: account identifier not found");

  const money = (label: string): number => {
    const l = ls.find((x) => x.startsWith(label) && MONEY_END.test(x));
    if (!l) throw new Error(`Bilt: "${label}" not found`);
    return parseMoney(MONEY_END.exec(l)![1]!)!;
  };
  const previous = money("Previous balance");
  const paymentsTotal = money("Payments and credits");
  const purchasesTotal = money("Purchases");
  // "New balance as of Jun 25, 2026" is followed by the amount on its own line.
  const nbAt = ls.findIndex((l) => l.startsWith("New balance as of"));
  const newBalance = parseMoney(ls[nbAt + 1] ?? "");
  if (nbAt < 0 || newBalance == null) throw new Error("Bilt: new balance not found");

  // ---- rows ----
  const transactions: ParsedTransaction[] = [];
  let section: "Payments" | "Credits" | "Purchases" | "Fees" | "Interest" | null = null;
  let cardMember: string | undefined;
  let inPayments = false;
  let rowDate: string | null = null;
  let current: { date: string; parts: string[] } | null = null;
  const sums = { payments: 0, charges: 0, fees: 0, interest: 0 };
  const flush = () => {
    if (!current) return;
    const full = collapseSpaces(current.parts.join(" "));
    current = null;
    const m = MONEY_END.exec(full);
    if (!m) throw new Error(`Bilt: row without an amount: ${full}`);
    const printed = parseMoney(m[1]!)!;
    const description = collapseSpaces(full.slice(0, m.index));
    const date = parseMonthNameDate(rowDate!)!;
    const amountCents = -printed;
    let kind = section;
    if (inPayments) kind = /^PAYMENT\b/i.test(description) ? "Payments" : "Credits";
    if (kind === "Payments" || kind === "Credits") sums.payments += printed;
    else if (kind === "Fees") sums.fees += printed;
    else if (kind === "Interest") sums.interest += printed;
    else sums.charges += printed;
    transactions.push({
      date,
      datePrecision: "EXACT",
      description,
      amountCents,
      section: kind === "Purchases" ? undefined : kind ?? undefined,
      cardMember,
    });
  };

  for (const l of ls) {
    if (/^Payments and credits$/.test(l)) { flush(); inPayments = true; section = "Credits"; cardMember = undefined; continue; }
    if (/^(Your transactions|Transactions)$/.test(l)) { flush(); inPayments = false; section = "Purchases"; cardMember = undefined; continue; }
    const au = /^(.+?)'s transactions Authorized user$/.exec(l);
    if (au) { flush(); inPayments = false; section = "Purchases"; cardMember = au[1]; continue; }
    if (/^Fees$/.test(l)) { flush(); inPayments = false; section = "Fees"; cardMember = undefined; continue; }
    if (/^Interest charged$/.test(l)) { flush(); inPayments = false; section = "Interest"; cardMember = undefined; continue; }
    if (/^(Year-to-date summary|Interest charge calculation|Important disclosures)/.test(l)) { flush(); section = null; inPayments = false; continue; }
    if (/^Total /.test(l)) { flush(); continue; }
    if (NOISE.test(l) || holder.has(l) || section == null) continue;
    const start = ROW_START.exec(l);
    if (start) {
      flush();
      rowDate = start[1]!;
      current = { date: start[1]!, parts: [start[2]!] };
    } else if (current) {
      current.parts.push(l);
    }
    if (current && MONEY_END.test(current.parts.join(" "))) flush();
  }
  flush();

  const sumTotals = (label: string) =>
    ls.filter((l) => l.startsWith(label) && MONEY_END.test(l)).reduce((a, l) => a + parseMoney(MONEY_END.exec(l)![1]!)!, 0);

  return {
    parserId: BILT_PARSER_ID,
    parserVersion: VERSION,
    institution: "Bilt",
    kind: "STATEMENT",
    title: `${product} statement`,
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "Bilt",
        accountNumber: identifier,
        accountName: product,
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
          { label: "Payments and credits rows = statement total", expectedCents: paymentsTotal, actualCents: sums.payments },
          { label: "Purchase rows = statement purchases", expectedCents: purchasesTotal, actualCents: sums.charges + sums.fees + sums.interest },
          { label: "Charge rows = \"Total new charges\"", expectedCents: sumTotals("Total new charges"), actualCents: sums.charges },
          { label: "Previous balance + purchases + payments = new balance", expectedCents: newBalance, actualCents: previous + purchasesTotal + paymentsTotal },
        ],
      },
    ],
    warnings,
  };
}
