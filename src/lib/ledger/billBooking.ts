import type { Lane } from "../classifier/taxonomy.ts";
import type { SegmentInput } from "./timeline.ts";

/**
 * How the ledger books a landlord's bill account (ingest/parsers/rentBill.ts): every row
 * on the day it happened, never clamped into a bill's cycle or spread across it, so the
 * account is exact on every day its bills cover and nothing is counted twice:
 *
 *  - A charge is booked on the day it prints: the 1st of the month it covers. A bill is
 *    cut a few days before month end and already lists next month's charges, so those
 *    belong to the next bill's days, not this one's. Charges dated after the last bill on
 *    file are pending: in the ledger once a bill covers their date.
 *  - What was paid ("Payments and credits", or a printed payment line) is booked on the
 *    days the bank payments that made it left the bank (transfers/billPayments.ts), so the
 *    two sides of each rent payment move on the same day. Rent paid before the 1st makes
 *    the account owe less than nothing (rent paid ahead) until the month's charges post.
 *    A payment no bank row is paired with stays on the day the bill prints it.
 *  - A confirmed difference between the bill and the bank (the landlord changed the bill
 *    without itemizing it) is spending on the day the bill prints it.
 *
 * Each bill still covers its own cycle; its opening and closing are restated for the rows
 * moved across its boundaries, so every segment ties.
 */

export type BillRow = { id: string; date: string; precision: "EXACT" | "PERIOD"; amountCents: number; lane: Lane };

export type BillStatement = {
  periodStart: string;
  periodEnd: string;
  openingCents: number;
  closingCents: number;
  rows: BillRow[];
};

/** One dated piece of a row as booked. The pieces of a row add up to its amount. */
export type BookedPart = { date: string; amountCents: number; lane: Lane };

export type BillRowBooking =
  /** Dated after the last bill on file: not in the ledger yet. */
  | { pending: true }
  | {
      pending: false;
      /** Its transfer (or charge), one piece per bank payment that paid it. */
      parts: BookedPart[];
      /** The confirmed difference from the bank, booked as spending. */
      correction?: BookedPart;
    };

export type BookedBill = { segments: SegmentInput[]; rows: Map<string, BillRowBooking> };

/**
 * @param paidBy each paired bill row's bank legs (bank-side amounts, so negative).
 * @param differences each bill row's confirmed difference from the bank (transferFees.ts).
 */
export function bookBill(
  accountId: string,
  statements: BillStatement[],
  paidBy: ReadonlyMap<string, { date: string; amountCents: number }[]>,
  differences: ReadonlyMap<string, number>,
): BookedBill {
  const bills = [...statements].sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0));
  const rows = new Map<string, BillRowBooking>();
  if (bills.length === 0) return { segments: [], rows };
  const lastEnd = bills.at(-1)!.periodEnd;
  const windowOf = (date: string) => bills.findIndex((b) => b.periodStart <= date && date <= b.periodEnd);
  const clamp = (date: string, b: BillStatement) => (date < b.periodStart ? b.periodStart : date > b.periodEnd ? b.periodEnd : date);

  // Every booked piece: which bill printed it, which bill's days it falls in.
  const placed: { from: number; to: number; part: BookedPart }[] = [];
  /** Where a piece goes: the bill whose days hold it, else (a gap between bills) clamped into its own. */
  const place = (from: number, part: BookedPart): BookedPart => {
    const to = windowOf(part.date);
    const booked = to >= 0 ? part : { ...part, date: clamp(part.date, bills[from]!) };
    placed.push({ from, to: to >= 0 ? to : from, part: booked });
    return booked;
  };

  bills.forEach((b, i) => {
    for (const r of b.rows) {
      const difference = differences.get(r.id) ?? 0;
      const legs = paidBy.get(r.id) ?? [];
      if (legs.length === 0 && difference === 0 && r.date > lastEnd) {
        rows.set(r.id, { pending: true });
        placed.push({ from: i, to: Infinity, part: { date: r.date, amountCents: r.amountCents, lane: r.lane } });
        continue;
      }
      const paid = r.amountCents - difference;
      const pieces = legs.length ? legs.map((l) => ({ date: l.date, amountCents: -l.amountCents, lane: r.lane })) : [{ date: r.date, amountCents: paid, lane: r.lane }];
      // The pairing nets to the difference by construction; anything else stays on the first piece.
      pieces[0]!.amountCents += paid - pieces.reduce((s, p) => s + p.amountCents, 0);
      rows.set(r.id, {
        pending: false,
        parts: pieces.map((p) => place(i, p)),
        ...(difference !== 0 ? { correction: place(i, { date: r.date, amountCents: difference, lane: "EXPENSE" }) } : {}),
      });
    }
  });

  const segments = bills.map((b, k): SegmentInput => {
    const flows = placed.filter((p) => p.to === k);
    // Restate the printed closing for what moved across the bill's end (either way).
    const leftAfter = placed.filter((p) => p.from <= k && p.to > k).reduce((s, p) => s + p.part.amountCents, 0);
    const cameBefore = placed.filter((p) => p.from > k && p.to <= k).reduce((s, p) => s + p.part.amountCents, 0);
    const closingCents = b.closingCents - leftAfter + cameBefore;
    return {
      accountId,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      openingCents: closingCents - flows.reduce((s, p) => s + p.part.amountCents, 0),
      closingCents,
      growthCents: 0,
      feesCents: 0,
      flows: flows.map((p) => ({ date: p.part.date, precision: "EXACT", amountCents: p.part.amountCents, lane: p.part.lane })),
    };
  });
  return { segments, rows };
}
