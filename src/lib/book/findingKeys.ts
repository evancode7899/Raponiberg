import type { Book, BookRow, BookStub } from "./load.ts";

/**
 * Pieces of finding ids that survive a database rebuild. Database ids (accounts, stubs,
 * statements, rows) are regenerated whenever documents are imported again, so a finding
 * id built from them would stop matching the owner's accepted exceptions. These name the
 * real-world thing instead: an account by its number at the institution, a pay stub by
 * employer + pay date + net pay, a row by account + date + amount.
 */

const upper = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

/** Every identifier of an account, as INSTITUTION#identifier (or NAME#… when it has none). */
export function accountAliases(book: Book, accountId: string): string[] {
  const a = book.accounts.find((x) => x.id === accountId);
  const inst = upper(a?.institution ?? "");
  const ids = (a?.identifiers ?? []).map((i) => `${inst}#${upper(i)}`);
  if (ids.length > 0) return [...new Set(ids)].sort();
  const name = a?.name ?? book.ledger.accounts.find((x) => x.id === accountId)?.name ?? accountId;
  return [`NAME#${upper(name)}`];
}

/**
 * An account reference for a finding id (`@{INSTITUTION#identifier}`, its first alias),
 * plus every alias for the finding's `accounts`.
 */
export function accountRef(book: Book, accountId: string): { ref: string; accounts: string[] } {
  const accounts = accountAliases(book, accountId);
  return { ref: `@{${accounts[0]}}`, accounts };
}

/** A finding id with its account reference blanked: matched together with `accounts`. */
export const withoutAccount = (id: string) => id.replace(/@\{[^}]*\}/g, "@*");

/** A pay stub: employer + pay date + net pay (unique, as in the database). */
export const stubRef = (s: BookStub) => `${s.employerKey}:${s.payDate}:${s.printed.netCurrent}`;

/** A household member by name (ids live in a setting a rebuild resets). */
export function personRef(book: Book, personId: string | null | undefined): string {
  const p = personId ? book.persons.find((x) => x.id === personId) : undefined;
  return p ? upper(p.name) : "UNKNOWN";
}

/**
 * A ledger row: account + date + amount, numbered among the rows that share them (two
 * identical transfers on one day), counting only rows `among` accepts so the number
 * doesn't shift when a sibling pairs up.
 */
export function rowRefs(book: Book, among: (r: BookRow) => boolean): Map<string, string> {
  const seen = new Map<string, number>();
  const refs = new Map<string, string>();
  for (const r of book.rows) {
    if (!among(r)) continue;
    const base = `${accountRef(book, r.accountId).ref}:${r.date}:${r.amountCents}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    refs.set(r.id, `${base}#${n}`);
  }
  return refs;
}
