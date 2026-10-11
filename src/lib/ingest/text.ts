import { ymd } from "../dates/isoDate.ts";

/**
 * Money token as printed on statements: "$1,234.56", "-$1,234.56", "- 1.00",
 * "($9,876.54)", "CR$7.13" (credit balance), "1,234.56". Matches the whole token.
 */
export const MONEY_RE = /^(CR)?(-\s?)?\(?\$?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\)?(CR)?$/;

/** Money anywhere in a string, for scanning ("-$1,234.56 ⧫", "Total $74.16"). */
export const MONEY_GLOBAL_RE = /(?:CR)?(?:-\s?)?\(?\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?(?:CR)?/g;

/**
 * Parses one money token to signed cents. Parentheses and a leading minus mean
 * negative; a "CR" marker means a credit (returned as negative — callers that treat
 * printed balances as amounts owed flip the sign themselves).
 */
export function parseMoney(token: string): number | null {
  const t = token.trim().replace(/\s+/g, " ");
  const m = MONEY_RE.exec(t.replace(/^-\s\$/, "-$"));
  if (!m) return null;
  const whole = Number(m[3].replace(/,/g, ""));
  const cents = whole * 100 + Number(m[4]);
  const negative = Boolean(m[2]) || (t.includes("(") && t.includes(")")) || Boolean(m[1] || m[5]);
  return negative ? -cents : cents;
}

/** Money value or a lone dash ("-", "--", "—") meaning zero. */
export function parseMoneyOrDash(token: string): number | null {
  const t = token.trim();
  if (/^[-–—]{1,2}$/.test(t)) return 0;
  return parseMoney(t);
}

/** All money tokens in a line, in order, as cents. */
export function moneyTokens(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY_GLOBAL_RE)) {
    const v = parseMoney(m[0]);
    if (v != null) out.push(v);
  }
  return out;
}

/**
 * Trailing money/dash tokens of a line ("Deposits 10,000.00 50,000.00" → two values,
 * "Beginning Account Value - -" → [0, 0]). Stops at the first non-money token from the
 * right, so description text containing numbers is never consumed.
 *
 * `joinSplitNegatives`: Chase prints some negatives as "- 1.00"; Fidelity prints a zero
 * column as "-" right before a value ("Additions - 20,000.00"). Only the caller knows
 * which one a lone dash means.
 */
export function trailingAmounts(
  line: string,
  opts: { joinSplitNegatives?: boolean } = {},
): { values: number[]; rest: string } {
  const tokens = line.trim().split(/\s+/);
  const values: number[] = [];
  while (tokens.length > 0) {
    let tok = tokens[tokens.length - 1]!;
    if (
      opts.joinSplitNegatives &&
      /^\$?[\d,]+\.\d{2}$/.test(tok) &&
      tokens.length > 1 &&
      tokens[tokens.length - 2] === "-"
    ) {
      tok = `-${tok}`;
      tokens.pop();
    }
    const v = parseMoneyOrDash(tok);
    if (v == null) break;
    values.unshift(v);
    tokens.pop();
  }
  return { values, rest: tokens.join(" ") };
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

/** "July 25, 2026" / "Jul 25, 2026" → "2026-07-25". */
export function parseMonthNameDate(text: string): string | null {
  const m = /([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  if (!month) return null;
  return ymd(Number(m[3]), month, Number(m[2]));
}

/** "08/21/26" or "08/21/2026" or "08-21-2026" → "2026-08-21". */
export function parseSlashDate(text: string): string | null {
  const m = /(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/.exec(text);
  if (!m) return null;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return ymd(year, Number(m[1]), Number(m[2]));
}

/**
 * "MM/DD" inside a statement period → full date. Picks the year that puts the date
 * within (or nearest to) the period, so a December row on a Dec–Jan statement resolves
 * to the earlier year.
 */
export function resolveMonthDay(mmdd: string, periodStart: string, periodEnd: string): string {
  const [mm, dd] = mmdd.split("/").map(Number) as [number, number];
  const startYear = Number(periodStart.slice(0, 4));
  const endYear = Number(periodEnd.slice(0, 4));
  const candidates = [startYear - 1, startYear, endYear, endYear + 1].map((y) => ymd(y, mm, dd));
  const inside = candidates.find((c) => c >= periodStart && c <= periodEnd);
  if (inside) return inside;
  // Outside the period (e.g. an Amex charge dated a day before the cycle): nearest wins.
  const dist = (c: string) =>
    Math.min(
      Math.abs(Date.parse(c) - Date.parse(periodStart)),
      Math.abs(Date.parse(c) - Date.parse(periodEnd)),
    );
  return candidates.sort((a, b) => dist(a) - dist(b))[0]!;
}

/** Non-empty trimmed lines. */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, " ").trim())
    .filter((l) => l.length > 0);
}

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
