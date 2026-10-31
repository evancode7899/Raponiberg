import { inclusiveDays, maxIso, minIso } from "../dates/isoDate.ts";

/**
 * Where the ledger books a row. A statement sometimes lists a purchase dated a day or two
 * before its period (it posted after the previous statement closed), and a quarterly
 * statement may give some activity only as a period total. The timeline books an exact
 * row on its date clamped into its statement's period, and spreads a period total evenly
 * across the period. Every figure that buckets rows by date books them the same way, so
 * cash flow, net worth and the profile's bridge can never put one dollar in two periods.
 */

export type Booked = {
  date: string;
  precision: "EXACT" | "PERIOD";
  /** The statement period the row came from. */
  statement: { start: string; end: string };
  /** The day the Book booked it on, when known (a landlord's bill books rows on their own days: ledger/billBooking.ts). */
  bookedOn?: string;
};

/** The day an exact row is booked on: its date, clamped into its statement's period. */
export const bookedOn = (r: Pick<Booked, "date" | "statement">) => minIso(r.statement.end, maxIso(r.statement.start, r.date));

/** The share of a row the ledger books inside [from, to] (inclusive): 0 or 1 for an exact row, a fraction of a period total. */
export function bookedShare(r: Booked, from: string, to: string): number {
  if (r.precision === "EXACT") {
    const d = r.bookedOn ?? bookedOn(r);
    return d >= from && d <= to ? 1 : 0;
  }
  const lo = maxIso(from, r.statement.start);
  const hi = minIso(to, r.statement.end);
  return lo > hi ? 0 : inclusiveDays(lo, hi) / inclusiveDays(r.statement.start, r.statement.end);
}

/**
 * The whole cents of a row the ledger books inside [from, to]: its amount for an exact row
 * booked there (else 0); for a period total, the cents its days hold when the total is
 * spread day by day and rounded cumulatively (day i holds round(A·(i+1)/n) − round(A·i/n)).
 * Each day's cents are fixed by the row alone, so any set of periods splits it into whole
 * cents that add back to it exactly: categories add to their period's total, and a year to
 * its months, to the cent. Each period is within a cent of bookedShare's exact share.
 */
export function bookedCents(r: Booked & { amountCents: number }, from: string, to: string): number {
  if (r.precision === "EXACT") return bookedShare(r, from, to) === 1 ? r.amountCents : 0;
  const lo = maxIso(from, r.statement.start);
  const hi = minIso(to, r.statement.end);
  if (lo > hi) return 0;
  const n = inclusiveDays(r.statement.start, r.statement.end);
  const before = inclusiveDays(r.statement.start, lo) - 1;
  const through = inclusiveDays(r.statement.start, hi);
  const at = (k: number) => Math.round((r.amountCents * k) / n);
  return at(through) - at(before);
}
