import { addDays, endOfMonth, periodsBetween, periodLabel, startOfMonth } from "../../dates/isoDate.ts";
import { household } from "../householdView.ts";
import type { Book } from "../load.ts";

/**
 * Investments › Dividends: every dividend the brokerage statements print, line by line
 * (BrokerageTaxFacts' income rows, never a year-to-date total), as a calendar: each security's
 * payments in each of the twelve months through the latest complete month the data is proven
 * through, and the months it paid in, which say when it pays next (a pattern, not an amount:
 * nothing is forecast). Money-market income counts too: the statement prints it as a dividend.
 */

export type DividendPayment = { date: string; cents: number; documentId: string; statementId: string | null };

export type DividendSecurity = {
  /** Account and security: one row of the calendar. */
  key: string;
  security: string;
  accountId: string;
  accountName: string;
  moneyMarket: boolean;
  /** Cents paid in each month of the window (YYYY-MM), only months with a payment. */
  byMonth: Record<string, number>;
  totalCents: number;
  payments: DividendPayment[];
  /** How often it paid in the window, in words; and the next month it paid in last time round. */
  cadence: string;
  next: string | null;
};

export type DividendCalendar = {
  /** The window's months, oldest first (YYYY-MM), and their labels. */
  months: { key: string; label: string; cents: number }[];
  from: string;
  through: string;
  securities: DividendSecurity[];
  totalCents: number;
};

const CADENCE: Record<number, string> = { 12: "monthly", 4: "quarterly", 2: "twice a year", 1: "yearly" };

/** The latest complete month the data is proven through: its last day. */
const windowEnd = (through: string) => (endOfMonth(through) === through ? through : addDays(startOfMonth(through), -1));

export function buildDividendCalendar(book: Book): DividendCalendar {
  const through = windowEnd(book.horizon.netWorth);
  const months = periodsBetween(startOfMonth(addDays(startOfMonth(through), -330)), through, "month").slice(-12);
  const from = months[0]?.start ?? through;
  const inView = new Set(household(book).ledger.accounts.map((a) => a.id));
  const names = new Map(book.accounts.map((a) => [a.id, a.name]));
  const statementOf = new Map(book.statements.map((s) => [s.documentId, s]));
  const seen = new Set<string>();
  const rows = new Map<string, DividendSecurity>();
  for (const b of book.brokerage) {
    if (b.isYearEnd) continue;
    const st = statementOf.get(b.documentId);
    if (!st || !inView.has(st.accountId) || b.periodEnd > book.horizon.netWorth) continue;
    for (const x of b.incomeRows) {
      if (x.kind !== "DIVIDEND" || !x.amount || x.date < from || x.date > through) continue;
      // The same payment on two statements (a re-issued one, an overlapping period) counts once.
      const dup = `${b.accountNumber}|${x.date}|${x.security}|${x.amount}`;
      if (seen.has(dup)) continue;
      seen.add(dup);
      const key = `${st.accountId}|${x.security}`;
      const s = rows.get(key) ?? { key, security: x.security, accountId: st.accountId, accountName: names.get(st.accountId) ?? b.accountNumber, moneyMarket: x.moneyMarket, byMonth: {}, totalCents: 0, payments: [], cadence: "", next: null };
      const m = x.date.slice(0, 7);
      s.byMonth[m] = (s.byMonth[m] ?? 0) + x.amount;
      s.totalCents += x.amount;
      s.payments.push({ date: x.date, cents: x.amount, documentId: b.documentId, statementId: st.id });
      rows.set(key, s);
    }
  }
  const nextMonths = periodsBetween(addDays(through, 1), endOfMonth(addDays(through, 365)), "month").map((p) => p.start.slice(0, 7)).slice(0, 12);
  const securities = [...rows.values()]
    .map((s) => {
      const paid = Object.keys(s.byMonth);
      const moy = new Set(paid.map((m) => m.slice(5)));
      return { ...s, payments: s.payments.sort((a, b) => a.date.localeCompare(b.date)), cadence: CADENCE[paid.length] ?? `${paid.length} months of 12`, next: nextMonths.find((m) => moy.has(m.slice(5))) ?? null };
    })
    .sort((a, b) => b.totalCents - a.totalCents || a.key.localeCompare(b.key));
  return {
    months: months.map((p) => {
      const key = p.start.slice(0, 7);
      return { key, label: periodLabel(p.start, "month"), cents: securities.reduce((s, x) => s + (x.byMonth[key] ?? 0), 0) };
    }),
    from,
    through,
    securities,
    totalCents: securities.reduce((s, x) => s + x.totalCents, 0),
  };
}
