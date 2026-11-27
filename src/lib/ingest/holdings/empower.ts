import { isSp500Fund } from "../../investments/sp500.ts";
import { collapseSpaces, lines } from "../text.ts";
import { splitRow, toCents, type Holding, type HoldingsFacts, type PrintedIndex } from "./types.ts";

/**
 * Holdings from an Empower quarterly 401(k) statement: "How is my account invested?" lists
 * each fund under its category heading, its name often wrapped over two lines, then a row of
 * columns (beginning balance, deposits, dividends/change in value, transfers, withdrawals,
 * ending balance, units/shares) with blank columns left out, so only the last two are sure:
 * the ending balance and the units. The table ends at "Totals", whose last figure is the
 * holdings' ending total (its blank ending left out when every fund ends at nothing). A
 * statement whose funds were all sold during the quarter lists no holdings.
 *
 * Where the statement also prints its performance table, the S&P 500 Index's own row
 * ("S & P 500 Index 1,3,4 N/A 7.56 -18.11 -18.11 …": footnotes, no code, then 3-month,
 * year-to-date and 1-year returns in percent) is kept on the S&P 500 fund's position.
 */
export function extractEmpowerHoldings(text: string, accountNumber: string, asOf: string): HoldingsFacts | null {
  const ls = lines(text).map(collapseSpaces);
  const start = ls.findIndex((l) => /^How is my account invested\?/.test(l));
  if (start < 0) return null;
  const positions: Holding[] = [];
  let printedTotalCents: number | null = null;
  let name: string[] = [];
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]!;
    if (/^Totals\b/.test(l)) {
      const { nums } = splitRow(l);
      // A blank column is left out, so an emptied account (every ending 0.00) ends its Totals on the withdrawals.
      const last = toCents(nums.at(-1) ?? null);
      printedTotalCents = last != null && last < 0 ? 0 : last;
      break;
    }
    // Headings (a category, the table's column titles, its continuation on the next page) start a new name.
    if (/Funds$|^Asset Allocation$|^How is my account invested|^Dividends Ending$|^Beginning \/Change|^Balance Deposits|^Stable Value$|^Specialty$|^Target Date$/.test(l)) {
      name = [];
      continue;
    }
    const toks = l.split(" ");
    const units = toks.at(-1)!;
    const ending = toks.at(-2) ?? "";
    if (!/^\d[\d,]*\.\d{3}$/.test(units) || !/^-?\$?\d[\d,]*\.\d{2}$/.test(ending)) {
      name.push(l);
      // A page's footer lines land here too; the next heading drops them.
      if (name.length > 4) name = name.slice(-4);
      continue;
    }
    const { text: lead, nums } = splitRow(l);
    const full = collapseSpaces([...name, lead].join(" "));
    name = [];
    const quantity = Number(units.replace(/,/g, ""));
    const valueCents = toCents(nums.at(-2) ?? null);
    // A fund sold out of during the quarter ends at nothing: no position.
    if (!full || valueCents == null || (valueCents === 0 && quantity === 0)) continue;
    positions.push({ symbol: null, name: full, kind: "FUND", quantity, price: null, valueCents, costBasisCents: null, expenseRatio: null });
  }
  if (!positions.length) return null;
  const index = printedSp500(ls);
  if (index) {
    const fund = positions.find((p) => isSp500Fund(p));
    if (fund) fund.printedIndex = index;
  }
  return { accountNumber, asOf, positions, printedTotalCents };
}

/** "-18.11" / ".01" / "N/A" → a ratio (−0.1811), or null for N/A. */
const pct = (tok: string | undefined): number | null => (tok && /^-?\d*\.\d+$|^-?\d+$/.test(tok) ? Math.round(Number(tok) * 100) / 10_000 : null);

/** The performance table's S&P 500 Index row, when the statement prints one. */
function printedSp500(ls: string[]): PrintedIndex | null {
  for (const l of ls) {
    const m = /^S ?& ?P 500 Index\s+[\d,]*\s*N\/A\s+(\S+)\s+(\S+)\s+(\S+)/.exec(l);
    if (!m) continue;
    const [threeMonth, yearToDate, oneYear] = [pct(m[1]), pct(m[2]), pct(m[3])];
    if (threeMonth == null && oneYear == null) continue;
    return { name: "S&P 500 Index", threeMonth, yearToDate, oneYear };
  }
  return null;
}
