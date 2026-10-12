/**
 * Relabels the transfer matcher applies on top of the classifier. Each stores the row's
 * original classification in `memo` (see RelabelStash) and is undone at the start of
 * every matching run, so the outcome always reflects the current set of statements.
 */
export const RELABEL = {
  /** An unknown-source deposit that is the other leg of a transfer. */
  PROMOTED: "transfer-match:",
  /** A card payment no tracked card received: paid a card we don't have statements for. */
  UNTRACKED_CARD: "untracked-card:",
  /** A payment on the partner's card that no tracked bank account sent: the partner's own money. */
  PARTNER_PAID: "partner-paid:",
  /** A bank rent payment that paid a landlord's bill on file: a transfer to the bill, whose charges are the spending. */
  PAID_BILL: "paid-bill:",
  /** A payment line on a landlord's first bill no bank payment made: credit from money already counted as housing. */
  BILL_CREDIT: "bill-credit:",
} as const;

export const isRelabel = (by: string | null | undefined) => !!by && Object.values(RELABEL).some((p) => by.startsWith(p));

/** What a relabelled row was before the matcher relabelled it (older stashes lack counterpartyKind). */
export type RelabelStash = {
  lane?: string | null;
  categoryId?: string | null;
  classifiedBy?: string | null;
  needsReview?: boolean;
  counterpartyKind?: string | null;
};

/** The stash in a relabelled row's memo, or null when it has none (or it's unreadable). */
export function readStash(memo: string | null | undefined): RelabelStash | null {
  if (!memo) return null;
  try {
    const v = JSON.parse(memo) as unknown;
    return v && typeof v === "object" ? (v as RelabelStash) : null;
  } catch {
    return null;
  }
}
