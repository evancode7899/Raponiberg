import { addDays, dayNumber, ymd } from "./isoDate.ts";

/**
 * Tax due dates. A due date on a Saturday, a Sunday or a legal holiday in the District of
 * Columbia moves to the next day that is none of those (IRC §7503), so the date a page shows
 * is the one that counts. Connecticut and New York follow the same days.
 */

/** 0 is Sunday … 6 is Saturday. */
const weekday = (iso: string) => (dayNumber(iso) + 4) % 7;

/** A holiday on a fixed day: kept on Friday when it falls on a Saturday, on Monday when on a Sunday. */
const observed = (iso: string) => (weekday(iso) === 6 ? addDays(iso, -1) : weekday(iso) === 0 ? addDays(iso, 1) : iso);

/** The `n`th Monday of a month. */
function nthMonday(year: number, month1: number, n: number): string {
  const first = ymd(year, month1, 1);
  return addDays(first, ((8 - weekday(first)) % 7) + (n - 1) * 7);
}

/** The holidays that can touch a due date here: Martin Luther King Jr. Day, Emancipation Day (D.C.) and Juneteenth. */
function holidays(year: number): Set<string> {
  return new Set([nthMonday(year, 1, 3), observed(ymd(year, 4, 16)), observed(ymd(year, 6, 19))]);
}

/** The day a deadline really falls on. */
export function taxDueDate(iso: string): string {
  const off = holidays(Number(iso.slice(0, 4)));
  let d = iso;
  while (weekday(d) === 0 || weekday(d) === 6 || off.has(d)) d = addDays(d, 1);
  return d;
}

/** When a year's return is due. */
export const filingDate = (year: number): string => taxDueDate(ymd(year + 1, 4, 15));

export type EstimateInstallment = { quarter: 1 | 2 | 3 | 4; date: string };

/** A year's four estimated-tax due dates. */
export function estimateInstallments(year: number): EstimateInstallment[] {
  return [
    { quarter: 1, date: taxDueDate(ymd(year, 4, 15)) },
    { quarter: 2, date: taxDueDate(ymd(year, 6, 15)) },
    { quarter: 3, date: taxDueDate(ymd(year, 9, 15)) },
    { quarter: 4, date: taxDueDate(ymd(year + 1, 1, 15)) },
  ];
}
