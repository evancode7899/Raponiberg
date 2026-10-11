/**
 * Positions an investment statement lists at its period end. The statement parsers keep
 * balances and money flows; these extractors re-read the same text for what's held, so
 * the investments page can show allocation, fees and unrealized gains. A snapshot never
 * changes a balance: the report checks that its positions add up to the statement's
 * closing value and leaves it out when they don't.
 */

/** How the statement files the position (asset class comes from the security, not this). */
export type HoldingKind = "CASH" | "FUND" | "ETF" | "STOCK" | "BOND" | "OPTION" | "OTHER";

export type Holding = {
  /** Ticker (or option symbol) when printed; null for plan funds without one. */
  symbol: string | null;
  name: string;
  kind: HoldingKind;
  /** Shares/units; null when the statement doesn't print them. */
  quantity: number | null;
  /** Price per unit in dollars (statements print 4 decimals); null when not printed. */
  price: number | null;
  valueCents: number;
  /** Total cost basis; null when unknown, not applicable (core cash) or not printed. */
  costBasisCents: number | null;
  /** Annual expense ratio when the statement prints one (0.0003 = 0.03%). */
  expenseRatio: number | null;
};

export type HoldingsFacts = {
  /** The same account number the statement's ledger section uses. */
  accountNumber: string;
  /** YYYY-MM-DD: the statement's period end. */
  asOf: string;
  positions: Holding[];
  /** The statement's own total for its holdings, when it prints one. */
  printedTotalCents: number | null;
};

export const sumPositions = (ps: Holding[]) => ps.reduce((s, p) => s + p.valueCents, 0);

/**
 * A numeric statement column: a number, "NA" ("unavailable", "not applicable") or null
 * (a dash: nothing printed).
 */
export type Num = number | "NA" | null;

/** "$1,234.56", "-$9.97", "702.384", "30%", "unavailable", "-" → a column; undefined when the token is text. */
export function parseNum(tok: string): Num | undefined {
  const t = tok.trim();
  if (/^(unavailable|n\/a|na)$/i.test(t)) return "NA";
  if (/^[-–—]{1,2}$/.test(t)) return null;
  const m = /^(-)?\(?\$?(-)?([\d,]*\d(?:\.\d+)?)\)?%?$/.exec(t);
  if (!m) return undefined;
  const v = Number(m[3]!.replace(/,/g, ""));
  return m[1] || m[2] || /^\(.*\)$/.test(t) ? -v : v;
}

const isNumTok = (tok: string) => parseNum(tok) !== undefined;
const num = (tok: string): Num => parseNum(tok) ?? null;

/**
 * Splits a row into its leading text and the run of numeric tokens that ends it
 * ("not applicable" counts as one token). "- $1.71" (a split negative) is joined.
 */
export function splitRow(line: string): { text: string; nums: Num[] } {
  const toks = line.replace(/not applicable/gi, "NA").replace(/(^|\s)-\s+\$/g, "$1-$").trim().split(/\s+/);
  let i = toks.length;
  while (i > 0 && isNumTok(toks[i - 1]!)) i--;
  return { text: toks.slice(0, i).join(" "), nums: toks.slice(i).map(num) };
}

/** Leading numeric run of a row and the text after it (Vanguard prints the name last). */
export function splitRowLeading(line: string): { nums: Num[]; text: string } {
  const toks = line.replace(/(^|\s)-\s+\$/g, "$1-$").trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && isNumTok(toks[i]!)) i++;
  return { nums: toks.slice(0, i).map(num), text: toks.slice(i).join(" ") };
}

const cents = (dollars: number) => Math.round(dollars * 100);

/**
 * Finds quantity, price and market value in a run of numbers by the one relation every
 * layout shares: quantity × price ≈ value (×100 for option contracts). The value may sit
 * right after the price or one column later (when the beginning value comes between).
 * Quantity, price and value always precede cost, gain and income, so the leftmost match
 * wins (cost × gain can happen to equal the income figure on a tiny position); within it,
 * the closest.
 */
export function locatePosition(nums: Num[]): { q: number; p: number; v: number; multiplier: number } | null {
  let best: { q: number; p: number; v: number; multiplier: number; err: number } | null = null;
  for (let q = 0; q + 2 < nums.length && !best; q++) {
    const qty = nums[q];
    const price = nums[q + 1];
    // Short positions (written options) print a negative quantity and value.
    if (typeof qty !== "number" || typeof price !== "number" || qty === 0 || price <= 0) continue;
    for (const v of [q + 2, q + 3]) {
      const val = nums[v];
      if (typeof val !== "number" || val === 0 || Math.sign(val) !== Math.sign(qty)) continue;
      for (const multiplier of [1, 100]) {
        const err = Math.abs(qty * price * multiplier - val);
        // Rounded prices: within half a cent per unit (at most 0.5% of the value), never under a cent.
        const tol = Math.max(0.01, Math.min(Math.abs(qty) * 0.005 * multiplier, Math.abs(val) * 0.005));
        if (err <= tol && (!best || err < best.err)) best = { q, p: q + 1, v, multiplier, err };
      }
    }
  }
  return best && { q: best.q, p: best.p, v: best.v, multiplier: best.multiplier };
}

export const toCents = (n: Num): number | null => (typeof n === "number" ? cents(n) : null);

/** "(VOO)" / "SHS(GLD)" → "VOO"; the last parenthesised all-caps token on the text. */
export function tickerIn(text: string): string | null {
  const all = [...text.matchAll(/\(([A-Z][A-Z0-9.]{0,19})\)/g)];
  return all.at(-1)?.[1] ?? null;
}

export const tidyName = (s: string) =>
  s
    .replace(/\(([A-Z][A-Z0-9.]{0,19})\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
