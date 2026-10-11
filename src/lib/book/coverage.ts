import { dayNumber, fromDayNumber } from "../dates/isoDate.ts";
import type { AccountTimeline } from "../ledger/timeline.ts";
import type { Book, BookAccount } from "./load.ts";

/** An account's timeline, or null when it has no committed statement. */
export function timelineOf(book: Book, accountId: string): AccountTimeline | null {
  return book.ledger.accounts.find((a) => a.id === accountId)?.timeline ?? null;
}

/** True when a statement (or a gap derived from a year-end summary) covers the day. */
export function isCovered(book: Book, accountId: string, date: string): boolean {
  const t = timelineOf(book, accountId);
  if (!t) return false;
  const d = dayNumber(date);
  return t.segments.some((s) => s.start <= d && d <= s.end);
}

/** Days in [from, to] the account's statements don't cover, as ranges. */
export function uncovered(book: Book, accountId: string, from: string, to: string): { from: string; to: string }[] {
  const t = timelineOf(book, accountId);
  if (!t) return [{ from, to }];
  const out: { from: string; to: string }[] = [];
  let cursor = dayNumber(from);
  const end = dayNumber(to);
  for (const s of [...t.segments].sort((a, b) => a.start - b.start)) {
    if (s.end < cursor) continue;
    if (s.start > end) break;
    if (s.start > cursor) out.push({ from: fromDayNumber(cursor), to: fromDayNumber(Math.min(end, s.start - 1)) });
    cursor = Math.max(cursor, s.end + 1);
    if (cursor > end) break;
  }
  if (cursor <= end) out.push({ from: fromDayNumber(cursor), to: fromDayNumber(end) });
  return out;
}

/** Accounts whose institution identifier ends with these digits (pay stub deposit lines print the last four). */
export function accountsByLast4(book: Book, last4: string): BookAccount[] {
  return book.accounts.filter((a) => a.identifiers.some((i) => i.replace(/\D/g, "").endsWith(last4)) || a.name.endsWith(last4));
}

export const accountName = (book: Book, id: string) => book.accounts.find((a) => a.id === id)?.name ?? "an account";

export const money = (cents: number) =>
  `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const yearOf = (iso: string) => Number(iso.slice(0, 4));
