import type { Lane } from "../classifier/taxonomy.ts";
import type { Ledger } from "../ledger/loadLedger.ts";
import { clipTimeline, type AccountTimeline } from "../ledger/timeline.ts";
import type { HouseholdViewMode } from "../ledger/householdSettings.ts";
import type { Book, BookRow } from "./load.ts";
import { isPartnerAccount } from "./owners.ts";

/**
 * Whose money the figures count: the one household view every page reads (Settings ›
 * Household). The statements and the checks on them always read every statement as
 * printed (book.ledger, book.rows); the view decides what the household's figures count
 * from them, once, so every page agrees.
 *
 *  - STRICT (the default): the household starts at the merge. A partner's own accounts join
 *    on the merge date with what they held then (as a balance first on file); before it their
 *    rows aren't the household's. What they paid into the household's accounts before it was
 *    their share of its bills: a credit against spending (rent when it landed in a bank
 *    account, the card's charges when it paid a card), not outside money. Their pay counts
 *    from the merge. Before the merge their money was theirs, as it would be again, split at
 *    a divorce's date, if the household ever came apart.
 *  - PRO_FORMA: as if the finances had been merged all along. Every account counts from its
 *    first statement and every paycheck from the first stub; a partner's pay that only reached
 *    their own (untracked) accounts is taken back out, and what they moved in is outside money.
 */
export type HouseholdView = {
  mode: HouseholdViewMode;
  mergeDate: string;
  /** Each partner account's join day, when it's after the account's first statement (STRICT only). */
  joins: ReadonlyMap<string, string>;
  /** The ledger as the household counts it: a partner's account starts on its join day, and their share is spending. */
  ledger: Ledger;
  /** The rows as the household counts them: none on a partner's account before it joined, their share as spending credits. */
  rows: BookRow[];
};

/** The category the classifier gives a partner's money into a household account before the merge. */
export const PARTNER_PRE_MERGE = "Partner contributions (pre-merge)";
/** A partner's pre-merge share, as the strict view counts it: a credit against the household's spending. */
export const PARTNER_SHARE_RENT = "Partner's share of rent (pre-merge)";
export const PARTNER_SHARE_CARDS = "Partner's share of cards (pre-merge)";
const SHARE_GROUP = "Essentials";

const memo = new WeakMap<Book, HouseholdView>();

/** The Book's household view (worked out once per Book). */
export function household(book: Book): HouseholdView {
  let v = memo.get(book);
  if (v) return v;
  const mode = book.viewMode ?? "STRICT";
  const mergeDate = book.ledger.mergeDate;
  const joins = new Map<string, string>();
  const share = new Map<string, string>();
  if (mode === "STRICT" && mergeDate) {
    for (const a of book.ledger.accounts) if (a.timeline.firstDay && a.timeline.firstDay < mergeDate && isPartnerAccount(book, a.id)) joins.set(a.id, mergeDate);
    const cards = new Set(book.ledger.accounts.filter((a) => a.group === "Credit cards").map((a) => a.id));
    // Only money in: what the household sent the partner stays outside money, and a payment on
    // the partner's own account (their own card) never reached the household.
    for (const r of book.rows) {
      const own = joins.get(r.accountId);
      if (r.category !== PARTNER_PRE_MERGE || r.lane !== "EXTERNAL_TRANSFER" || r.amountCents <= 0 || r.date >= mergeDate || (own && r.date < own)) continue;
      share.set(r.id, cards.has(r.accountId) ? PARTNER_SHARE_CARDS : PARTNER_SHARE_RENT);
    }
  }
  const relane = (t: AccountTimeline): AccountTimeline => {
    if (!share.size || !t.segments.some((s) => s.exact.some((f) => f.id && share.has(f.id)) || s.spread.some((f) => f.id && share.has(f.id)))) return t;
    const lane = <F extends { id?: string; lane: Lane }>(f: F): F => (f.id && share.has(f.id) ? { ...f, lane: "EXPENSE" } : f);
    return { ...t, segments: t.segments.map((s) => ({ ...s, exact: s.exact.map(lane), spread: s.spread.map(lane) })) };
  };
  const ledger: Ledger =
    joins.size || share.size
      ? {
          ...book.ledger,
          accounts: book.ledger.accounts.flatMap((a) => {
            const j = joins.get(a.id);
            const timeline = relane(j ? clipTimeline(a.timeline, j) : a.timeline);
            return !timeline.firstDay ? [] : timeline === a.timeline ? [a] : [{ ...a, timeline }];
          }),
        }
      : book.ledger;
  const rows =
    joins.size || share.size
      ? book.rows.flatMap((r) => {
          const own = joins.get(r.accountId);
          if (own && r.date < own) return [];
          const category = share.get(r.id);
          return [category ? { ...r, lane: "EXPENSE" as const, category, categoryGroup: SHARE_GROUP } : r];
        })
      : book.rows;
  v = { mode, mergeDate, joins, ledger, rows };
  memo.set(book, v);
  return v;
}

/** On a partner's own account before it joined the household: kept out of every figure (STRICT). */
export function beforeJoining(book: Book, r: Pick<BookRow, "accountId" | "date">): boolean {
  const j = household(book).joins.get(r.accountId);
  return j != null && r.date < j;
}

/** The first day a person's pay counts as the household's: a partner's from the merge (STRICT); null from the start. */
export function payJoins(book: Book, personId: string): string | null {
  const v = household(book);
  return v.mode === "STRICT" && personId !== book.persons[0]?.id && v.mergeDate ? v.mergeDate : null;
}
