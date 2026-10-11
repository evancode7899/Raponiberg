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
};

/** The day an exact row is booked on: its date, clamped into its statement's period. */
export const bookedOn = (r: Pick<Booked, "date" | "statement">) => minIso(r.statement.end, maxIso(r.statement.start, r.date));

/** The share of a row the ledger books inside [from, to] (inclusive): 0 or 1 for an exact row, a fraction of a period total. */
export function bookedShare(r: Booked, from: string, to: string): number {
  if (r.precision === "EXACT") {
    const d = bookedOn(r);
    return d >= from && d <= to ? 1 : 0;
  }
  const lo = maxIso(from, r.statement.start);
  const hi = minIso(to, r.statement.end);
  return lo > hi ? 0 : inclusiveDays(lo, hi) / inclusiveDays(r.statement.start, r.statement.end);
}
