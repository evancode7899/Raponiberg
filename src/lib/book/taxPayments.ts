import { taxAuthority, type TaxAuthority } from "../tax/facts/payments.ts";
import type { Book, BookRow } from "./load.ts";

/**
 * The one definition of a tax payment or refund: a bank-account row whose payee is a
 * tax authority (IRS / EFTPS, CT DRS, NY), whatever lane or category it was filed under.
 * The profile's "taxes paid" and the tax page's estimates both come from here.
 */
export type TaxRow = BookRow & { authority: TaxAuthority };

export function taxRows(book: Book, from: string, to: string): TaxRow[] {
  const bank = new Set(book.accounts.filter((a) => a.group === "Cash").map((a) => a.id));
  const out: TaxRow[] = [];
  for (const r of book.rows) {
    if (r.date < from || r.date > to || !bank.has(r.accountId)) continue;
    const authority = taxAuthority(r.payee);
    if (authority) out.push({ ...r, authority });
  }
  return out;
}
