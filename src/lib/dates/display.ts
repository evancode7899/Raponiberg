/**
 * The app's one way of writing a date for people. A statement day is "Jun 30, 2026", a month
 * is "Jun 2026", a day inside a known year is "Jun 30". Machine dates (YYYY-MM-DD) stay in
 * the data, the URLs and CSV exports; on screen they are always written these ways.
 *
 * Day strings are read as calendar days, never instants, so no time zone can move them a day
 * (a Date parsed from "2026-06-30" is midnight UTC, which is the 29th in New York).
 * dates/display.test.ts holds pages to it: no page formats a date on its own.
 */

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const MONTH = /^(\d{4})-(\d{2})/;

/** "Jun 30, 2026" for a day ("2026-06-30", or a timestamp starting with one); anything else comes back as it was. */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = DAY.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** "Jun 30": a day when the year is plain from the page around it. */
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = DAY.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
}

/** "Jun 2026" for a month ("2026-06") or any day in it. */
export function monthLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = MONTH.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

/** "Jun": a month when the year is plain from the page around it. */
export function monthName(iso: string | number): string {
  const n = typeof iso === "number" ? iso : Number(MONTH.exec(iso)?.[2] ?? NaN);
  return MONTHS[n - 1] ?? String(iso);
}

/** "Tue, Jun 30, 2026": a day someone has to act on. */
export function weekdayLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = DAY.exec(iso);
  if (!m) return iso;
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${WEEKDAYS[dow]}, ${dateLabel(iso)}`;
}

/** "Jun 1 – Jun 30, 2026", or across years "Dec 1, 2025 – Jan 31, 2026". */
export function rangeLabel(start: string, end: string): string {
  if (start.slice(0, 4) === end.slice(0, 4)) return `${dayLabel(start)} – ${dateLabel(end)}`;
  return `${dateLabel(start)} – ${dateLabel(end)}`;
}
