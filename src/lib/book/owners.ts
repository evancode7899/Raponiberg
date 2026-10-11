import type { Book } from "./load.ts";

/**
 * Who an account belongs to: a household member's id, "JOINT", or null when nothing says.
 * The owner's setting on the Taxes page wins; otherwise the holder the statements print
 * (a brokerage statement's owner line, or the holder's name the parser put in the
 * account's name, e.g. "Amex High Yield Savings — Sam"), when exactly one member matches.
 */
export function accountOwner(book: Pick<Book, "accounts" | "brokerage" | "persons" | "taxProfile">, accountId: string): string | null {
  const acct = book.accounts.find((a) => a.id === accountId);
  if (!acct) return null;
  for (const idn of acct.identifiers) {
    const o = book.taxProfile.accountOwners[idn];
    if (o) return o;
  }
  const line = (book.brokerage.find((b) => acct.identifiers.includes(b.accountNumber))?.ownerLine ?? acct.name).toUpperCase();
  const matches = book.persons.filter((p) => p.match.some((m) => line.includes(m)));
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * A partner's own account: one that belongs to a household member other than the first.
 * The first member's accounts and the joint ones are the household's books from the start;
 * every other member's own money joins them at the merge date (see householdSettings.ts).
 */
export function isPartnerAccount(book: Pick<Book, "accounts" | "brokerage" | "persons" | "taxProfile">, accountId: string): boolean {
  const owner = accountOwner(book, accountId);
  return owner !== null && owner !== "JOINT" && owner !== book.persons[0]?.id;
}
