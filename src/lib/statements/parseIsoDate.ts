/**
 * Parses a "YYYY-MM-DD" string anchored at noon UTC, so the UTC calendar day always
 * matches the intended day regardless of the server's local timezone (avoids the
 * off-by-one that plain `new Date("YYYY-MM-DD")` risks in cash-flow bucketing).
 */
export function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Expected YYYY-MM-DD, got: ${value}`);
  }
  const [, year, month, day] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0),
  );
}
