import type { ParsedDocument, ParsedTransaction } from "../../types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate } from "../../text.ts";

/**
 * A template for a new statement parser: a whole, working parser for the made-up "Example
 * Bank" checking statement that fixture.ts writes. To add an institution:
 *
 *  1. Copy this file and fixture.ts next to the other parsers (src/lib/ingest/parsers/<bank>.ts),
 *     rename EXAMPLE_* and the functions, and change the patterns to the real layout. Work from
 *     the text pdf-parse gives (scripts can print it), never from a real statement pasted in.
 *  2. Make fixture.ts write that layout with made-up names, numbers and amounts, and keep
 *     exampleBank.test.ts's checks: every generated statement parses, its rows are exactly the
 *     ones written, and its checks tie to the cent.
 *  3. Register it in parsers/index.ts (id, VERSION, detect, parse). Detection must be narrow:
 *     a phrase only this institution prints, so no other statement is read by it.
 *  4. Bump VERSION whenever a change would read an imported statement differently: the app
 *     reads those again on the next folder scan or launch.
 *
 * The parser's checks are what makes an import trustworthy: each printed total the statement
 * gives is compared with the rows read, and a statement that doesn't tie is held for review.
 * This template is not registered: no real statement is ever read by it.
 */
export const EXAMPLE_PARSER_ID = "example-bank-checking";
export const VERSION = 1;

/** Narrow: the bank's name and a phrase from its summary box, both required. */
export function detectExampleBank(text: string): boolean {
  return /Example Bank, N\.A\./.test(text) && /Beginning balance on/.test(text);
}

const MONEY_END = /(-?\$[\d,]+\.\d{2})$/;
/** A row: "03/04 SPRINGFIELD DINER -$12.34" (the year comes from the statement period). */
const ROW = /^(\d{2}\/\d{2})\s+(.+?)\s+(-?\$[\d,]+\.\d{2})$/;

export function parseExampleBank(text: string): ParsedDocument {
  const ls = lines(text).map(collapseSpaces);
  const find = (re: RegExp, what: string) => {
    for (const l of ls) {
      const m = re.exec(l);
      if (m) return m;
    }
    throw new Error(`Example Bank: ${what} not found`);
  };
  const period = find(/^Statement period (\d{2}\/\d{2}\/\d{4}) to (\d{2}\/\d{2}\/\d{4})$/, "statement period");
  const periodStart = parseSlashDate(period[1]!)!;
  const periodEnd = parseSlashDate(period[2]!)!;
  const accountNumber = find(/^Account number \S*(\d{4})$/, "account number")[1]!;
  const money = (label: string) => parseMoney(MONEY_END.exec(find(new RegExp(`^${label}.*\\$[\\d,]+\\.\\d{2}$`), label)[0])![1]!)!;
  const opening = money("Beginning balance on");
  const deposits = money("Deposits and credits");
  const withdrawals = money("Withdrawals and debits");
  const closing = money("Ending balance on");

  const transactions: ParsedTransaction[] = [];
  let section: "Deposits" | "Withdrawals" | null = null;
  const sums = { Deposits: 0, Withdrawals: 0 };
  for (const l of ls) {
    if (l === "Deposits and other credits") section = "Deposits";
    else if (l === "Withdrawals and other debits") section = "Withdrawals";
    else if (/^Total /.test(l)) section = null;
    const m = section && ROW.exec(l);
    if (!m) continue;
    // The row's month and day, in the period's year (or the year before, for a period across a new year).
    const [mm, dd] = m[1]!.split("/").map(Number);
    let year = Number(periodEnd.slice(0, 4));
    if (`${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}` > periodEnd) year--;
    const amountCents = parseMoney(m[3]!)!;
    sums[section!] += amountCents;
    transactions.push({ date: `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`, datePrecision: "EXACT", description: m[2]!, amountCents, section: section! });
  }

  return {
    parserId: EXAMPLE_PARSER_ID,
    parserVersion: VERSION,
    institution: "Example Bank",
    kind: "STATEMENT",
    title: "Example Bank checking statement",
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "Example Bank",
        accountNumber,
        accountName: `EXAMPLE BANK CHECKING ••${accountNumber}`,
        kind: "CHECKING",
        subtype: "CHECKING",
        periodStart,
        periodEnd,
        openingBalanceCents: opening,
        closingBalanceCents: closing,
        growthCents: 0,
        feesCents: 0,
        transactions,
        checks: [
          { label: "Deposit rows = \"Deposits and credits\"", expectedCents: deposits, actualCents: sums.Deposits },
          { label: "Withdrawal rows = \"Withdrawals and debits\"", expectedCents: withdrawals, actualCents: sums.Withdrawals },
          { label: "Beginning balance + rows = ending balance", expectedCents: closing, actualCents: opening + sums.Deposits + sums.Withdrawals },
        ],
      },
    ],
    warnings: [],
  };
}
