/**
 * All user-facing dates and clock times use US Eastern (NYC), including EST/EDT.
 * APIs, aggregations, and stored ISO timestamps remain UTC.
 */
export const DISPLAY_TIME_ZONE = "America/New_York";

const dateMedium = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
});

const dateTimeMedium = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/** Calendar date in Eastern (for an absolute `Date`). */
export function formatDisplayDate(d: Date): string {
  return dateMedium.format(d);
}

/** Date + time in Eastern (for an absolute `Date`). */
export function formatDisplayDateTime(d: Date): string {
  return dateTimeMedium.format(d);
}

/**
 * Format a ledger-style `YYYY-MM-DD` (stored with noon UTC anchor) for display in Eastern.
 */
export function formatDisplayDateFromYmd(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd.trim())) {
    return ymd;
  }
  return formatDisplayDate(new Date(`${ymd.trim()}T12:00:00.000Z`));
}
