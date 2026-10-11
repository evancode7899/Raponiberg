import type { Book, BookBrokerage } from "./load.ts";

/** Dividends, interest and fund distributions in a brokerage snapshot's year-to-date summary. */
export const ytdIncome = (b: BookBrokerage) =>
  b.income ? b.income.dividends + b.income.interest + b.income.capGainDistShort + b.income.capGainDistLong + b.income.taxExempt : 0;

/**
 * Each account's year-to-date investment income through `through` (default: year end):
 * the largest year-to-date figure among its snapshots dated in the year by then.
 */
export function investmentIncomeByAccount(book: Book, year: number, through = `${year}-12-31`): Map<string, { accountNumber: string; kind: BookBrokerage["kind"]; cents: number; asOf: string }> {
  const out = new Map<string, { accountNumber: string; kind: BookBrokerage["kind"]; cents: number; asOf: string }>();
  for (const b of book.brokerage) {
    if (!b.periodEnd.startsWith(String(year)) || b.periodEnd > through || !b.income) continue;
    const cur = out.get(b.accountNumber);
    if (!cur || ytdIncome(b) > cur.cents) out.set(b.accountNumber, { accountNumber: b.accountNumber, kind: b.kind, cents: ytdIncome(b), asOf: b.periodEnd });
  }
  return out;
}

/** Ledger account id for a brokerage account number, via the account's identifiers. */
export function accountIdForNumber(book: Book, accountNumber: string): string | null {
  return book.accounts.find((a) => a.identifiers.includes(accountNumber))?.id ?? null;
}
