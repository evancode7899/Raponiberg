import type { Book } from "./load.ts";

/**
 * Money in and out over a set of ledger rows (by database id), in the Book's amounts: a
 * bill payment split across bank payments counts all its pieces, a confirmed bill
 * correction counts with the payment it belongs to, and a landlord's charge past the last
 * bill on file (not in the ledger yet) counts nowhere but is reported apart. Row viewers
 * total what they list with this, so their totals are the same dollars every figure counts.
 */
export function bookTotalsFor(book: Book, ids: string[]): { count: number; inCents: number; outCents: number; pending: number; notInLedger: number } {
  const want = new Set(ids);
  let inCents = 0;
  let outCents = 0;
  let pending = 0;
  const seen = new Set<string>();
  for (const r of book.rows) {
    const base = r.partOf ?? (r.id.endsWith(":correction") ? r.id.slice(0, -":correction".length) : r.id);
    if (!want.has(base)) continue;
    seen.add(base);
    if (r.pending) {
      pending++;
      continue;
    }
    if (r.amountCents > 0) inCents += r.amountCents;
    else outCents += r.amountCents;
  }
  // Rows the viewer lists that the Book doesn't hold (a held or summary statement's).
  return { count: ids.length, inCents, outCents, pending, notInLedger: ids.filter((id) => !seen.has(id)).length };
}
