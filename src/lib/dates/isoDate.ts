/**
 * Calendar-day arithmetic on "YYYY-MM-DD" strings. Statements speak in calendar days,
 * never instants, so the ledger engine works in day strings end-to-end and only converts
 * to Date (noon UTC, see parseIsoDate) at the database boundary.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Days since 1970-01-01 for a calendar date. */
export function dayNumber(iso: string): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got: ${iso}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

export function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days);
}

/** b - a in days. */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** Inclusive day count of [start, end]. */
export function inclusiveDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

export function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}

export function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

/**
 * Today on this computer's calendar. The Book, its cache and every "as of today" figure
 * use it, so they agree on the date (an ISO timestamp's date is UTC's, a day ahead on a US
 * evening).
 */
export function localToday(now = new Date()): string {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function ymd(year: number, month1: number, day: number): string {
  return `${year}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Last calendar day of the month containing `iso`. */
export function endOfMonth(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return toIsoDate(new Date(Date.UTC(y, m, 0)));
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export type Granularity = "month" | "quarter" | "year";

/** First day of the month/quarter/year containing `iso`. */
export function startOfPeriod(iso: string, g: Granularity): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (g === "year") return ymd(y, 1, 1);
  if (g === "quarter") return ymd(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  return ymd(y, m, 1);
}

/** Last day of the month/quarter/year containing `iso`. */
export function endOfPeriod(iso: string, g: Granularity): string {
  const start = startOfPeriod(iso, g);
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const months = g === "year" ? 12 : g === "quarter" ? 3 : 1;
  return toIsoDate(new Date(Date.UTC(y, m - 1 + months, 0)));
}

/** Consecutive calendar periods covering [from, to]. */
export function periodsBetween(
  from: string,
  to: string,
  g: Granularity,
): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let cursor = startOfPeriod(from, g);
  while (cursor <= to) {
    const end = endOfPeriod(cursor, g);
    out.push({ start: cursor, end });
    cursor = addDays(end, 1);
  }
  return out;
}

export function periodLabel(start: string, g: Granularity): string {
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  if (g === "year") return String(y);
  if (g === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}
