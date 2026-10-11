import { lines, parseMonthNameDate } from "../text.ts";
import { locatePosition, splitRow, tickerIn, tidyName, toCents, type Holding, type HoldingKind, type HoldingsFacts } from "./types.ts";

/**
 * Holdings from a Fidelity investment report, per account: the "Holdings" block (core
 * cash, ETPs, stocks, mutual funds, bonds, options) through its "Total Holdings" line, or
 * a 529's portfolio table through "Total Market Value". Layouts differ by year and
 * account type (no cost columns, a percent column first, options priced per share), so
 * columns are found by quantity × price = value rather than by position.
 */

const PAGE_BREAK = /^-- \d+ of \d+ --$/;

const SECTIONS: [RegExp, HoldingKind][] = [
  [/^Core Account( \(continued\))?$/, "CASH"],
  [/^Exchange Traded Products( \(continued\))?$/, "ETF"],
  [/^Mutual Funds( \(continued\))?$/, "FUND"],
  [/^Stocks( \(continued\))?$/, "STOCK"],
  [/^Bonds( \(continued\))?$/, "BOND"],
  [/^Options( \(continued\))?$/, "OPTION"],
  [/^Other( Holdings)?( \(continued\))?$/, "OTHER"],
];

/** Column headings, page furniture and subsection titles: never part of a security's name. */
const FURNITURE = [
  /^(Description|Beginning|Market Value|Quantity|Price|Per Unit|per Unit|Ending|Total|Cost Basis|Unrealized|Gain\/Loss|EAI \(\$\) \/|EY \(%\)|Percent of|Total Value|Contributions)$/,
  /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,
  /^[A-Z][a-z]+ \d{1,2}, \d{4} - [A-Z][a-z]+ \d{1,2}, \d{4}$/,
  /^MR_CE /,
  /^S$/,
  /^\d+ of \d+$/,
  /^INVESTMENT REPORT$/,
  /^Account # /,
  /Holdings$/,
  /^Includes exchange-traded/,
  /ETPs( \(continued\))?$/,
  /^(Common|Preferred) Stock( \(continued\))?$/,
  /\(continued\)$/,
];

/** Lines inside a row that aren't its name: yields, ISIN/SEDOL, a lone EY figure. */
const SKIP = [/^-- /, /^ISIN #/, /^(-|[\d.]+%?)$/];

export function extractFidelityHoldings(text: string): HoldingsFacts[] {
  const all = lines(text);
  const periodLine = all.find((l) => /^[A-Z][a-z]+ \d{1,2}, \d{4} - [A-Z][a-z]+ \d{1,2}, \d{4}$/.test(l));
  if (!periodLine) return [];
  const asOf = parseMonthNameDate(periodLine.split(" - ")[1]!)!;

  const pages: string[][] = [[]];
  for (const l of all) {
    if (PAGE_BREAK.test(l)) pages.push([]);
    else pages.at(-1)!.push(l);
  }
  const byAccount = new Map<string, string[]>();
  for (const page of pages) {
    const hdr = page.find((l) => /^Account # [A-Z0-9]{3}-\d{6}$/.test(l));
    if (!hdr) continue;
    const num = hdr.slice("Account # ".length);
    byAccount.set(num, [...(byAccount.get(num) ?? []), ...page]);
  }

  const out: HoldingsFacts[] = [];
  for (const [accountNumber, ls] of byAccount) {
    const facts = accountHoldings(ls);
    if (facts) out.push({ accountNumber, asOf, ...facts });
  }
  return out;
}

function accountHoldings(ls: string[]): Pick<HoldingsFacts, "positions" | "printedTotalCents"> | null {
  // The block's title is its own line, or (older reports) ends the owner line:
  // "PAT EXAMPLE - INDIVIDUAL Holdings". Not the summary page's "Account/Top Holdings".
  const start = ls.findIndex((l) => l === "Holdings" || (/ Holdings$/.test(l) && !/^(Account|Top) Holdings$/.test(l)));
  if (start < 0) return null;
  const positions: Holding[] = [];
  let kind: HoldingKind = "FUND";
  let name: string[] = [];
  /** Inside a "Total …" row whose figures may wrap onto the next lines. */
  let inTotal = false;
  let printedTotalCents: number | null = null;

  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]!;
    if (/^Total (Holdings|Market Value)\b/.test(l)) {
      const values = splitRow(l).nums.map(toCents).filter((v): v is number => v != null);
      const sum = positions.reduce((s, p) => s + p.valueCents, 0);
      printedTotalCents = values.find((v) => v === sum) ?? values[0] ?? null;
      return { positions, printedTotalCents };
    }
    // Headings first: "Total Value" is a column heading, not a totals row.
    if (FURNITURE.some((re) => re.test(l))) {
      name = [];
      continue;
    }
    if (/^Total /.test(l)) {
      name = [];
      inTotal = splitRow(l).nums.length < 2;
      continue;
    }
    if (inTotal) {
      if (splitRow(l).nums.length >= 2) inTotal = false;
      continue;
    }
    const section = SECTIONS.find(([re]) => re.test(l));
    if (section) {
      kind = section[1];
      name = [];
      continue;
    }
    if (SKIP.some((re) => re.test(l))) continue;

    const { text, nums } = splitRow(l);
    const at = nums.length >= 4 ? locatePosition(nums) : null;
    if (!at) {
      name.push(l);
      continue;
    }
    const desc = [...name, text].join(" ").replace(/^M (?=\S)/, "");
    name = [];
    const value = toCents(nums[at.v])!;
    const cost = nums[at.v + 1];
    const gain = nums[at.v + 2];
    // Cost basis only when the next column is the unrealized gain that goes with it.
    const costBasisCents =
      typeof cost === "number" && typeof gain === "number" && Math.abs(value - toCents(cost)! - toCents(gain)!) <= 2 ? toCents(cost) : null;
    positions.push({
      symbol: tickerIn(desc),
      name: tidyName(desc),
      kind,
      quantity: nums[at.q] as number,
      price: nums[at.p] as number,
      valueCents: value,
      costBasisCents,
      expenseRatio: null,
    });
  }
  return positions.length ? { positions, printedTotalCents } : null;
}
