/**
 * How a ledger row is identified across re-imports: its account (institution and every
 * identifier the account goes by), date, amount and payee. Pure, with no file or database
 * access, so modules that reach the browser (book/reimbursements.ts via the spending views)
 * can use it; the stores that save fingerprints (rowDecisions.ts) import it from here.
 */

export type RowFingerprint = { institution: string; identifiers: string[]; date: string; amountCents: number; payee: string };

export const normPayee = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** The same row: same institution, a shared account identifier, same date, amount and payee. */
export const sameRow = (a: RowFingerprint, b: RowFingerprint) =>
  a.date === b.date && a.amountCents === b.amountCents && a.payee === b.payee && a.institution === b.institution && a.identifiers.some((i) => b.identifiers.includes(i));
