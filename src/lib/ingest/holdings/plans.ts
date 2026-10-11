import { collapseSpaces, lines, parseSlashDate } from "../text.ts";
import { splitRow, toCents, type Holding, type HoldingsFacts } from "./types.ts";

/**
 * Holdings from plan statements: Slavic401k's "INVESTMENT FUNDS" table (with each
 * fund's symbol and expense ratio from the plan's fund menu) and a HealthEquity HSA's
 * cash plus its "Investment Portfolio".
 */

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * Slavic: "Fidelity 500 Index $10,000.00 $1,000.00 $0.00 $5,000.00 $500.00
 * $16,500.00 100.000" (begin, contributions, withdrawals, transfers, earnings, ending,
 * shares) until "TOTAL BALANCE". The fund menu ("FUND NAME Symbol Category … Total Annual
 * Operating Expenses") gives each fund's ticker and expense ratio.
 */
export function extractSlavicHoldings(text: string, accountNumber: string): HoldingsFacts | null {
  const ls = lines(text).map(collapseSpaces);
  const asOf = /\(as of (\d{2}\/\d{2}\/\d{4})\)/.exec(text)?.[1];
  const start = ls.indexOf("INVESTMENT FUNDS");
  if (!asOf || start < 0) return null;

  const positions: Holding[] = [];
  let printedTotalCents: number | null = null;
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]!;
    const { text: name, nums } = splitRow(l);
    if (/^TOTAL BALANCE\b/.test(l)) {
      printedTotalCents = toCents(nums[5] ?? null);
      break;
    }
    if (!name || nums.length !== 7) continue;
    positions.push({
      symbol: null,
      name,
      kind: "FUND",
      quantity: nums[6] as number,
      price: null,
      valueCents: toCents(nums[5]!)!,
      costBasisCents: null,
      expenseRatio: null,
    });
  }

  // The fund menu: entries end on a line "… <expense ratio>% $<cost per $1k>".
  const menu: { name: string; symbol: string; expenseRatio: number }[] = [];
  const menuAt = ls.findIndex((l) => /^FUND NAME Symbol Category/.test(l));
  let buf: string[] = [];
  for (let i = menuAt + 1; menuAt >= 0 && i < ls.length; i++) {
    const l = ls[i]!;
    // The menu's own column headings come before the first fund.
    if (/^(Total Annual|Operating|Expenses\*?|Cost|Per \$1k)$/.test(l)) continue;
    buf.push(l);
    const end = /(\d+\.\d{3})% \$\d+\.\d{2}$/.exec(l);
    if (!end) continue;
    const joined = buf.join(" ");
    buf = [];
    const sym = /\b([A-Z]{4}X)\b/.exec(joined);
    if (sym) menu.push({ name: norm(joined.slice(0, sym.index)), symbol: sym[1]!, expenseRatio: Number(end[1]) / 100 });
  }
  for (const p of positions) {
    const m = menu.find((f) => f.name.startsWith(norm(p.name)));
    if (m) {
      p.symbol = m.symbol;
      p.expenseRatio = m.expenseRatio;
    }
  }
  return positions.length ? { accountNumber, asOf: parseSlashDate(asOf)!, positions, printedTotalCents } : null;
}

/**
 * HealthEquity: the cash account's ending balance plus each fund in the "Investment
 * Portfolio" ("VTSAX VANGUARD … / IDX ADMIRAL 10.00 100.00 1,000.00": shares, closing
 * price, closing value; the name may wrap).
 */
export function extractHealthEquityHoldings(text: string, accountNumber: string, periodEnd: string, cashCents: number): HoldingsFacts {
  const ls = lines(text).map(collapseSpaces);
  const positions: Holding[] = [{ symbol: null, name: "HSA cash", kind: "CASH", quantity: null, price: null, valueCents: cashCents, costBasisCents: null, expenseRatio: null }];
  const total = /Closing Account Value\s+\$?\s*([\d,]+\.\d{2})/.exec(text);
  const start = ls.findIndex((l) => /^Investment Portfolio$/.test(l));
  let name: string[] = [];
  let symbol: string | null = null;
  for (let i = start + 1; start >= 0 && i < ls.length; i++) {
    const l = ls[i]!;
    if (/^(Fund Category|Closing Account Value)/.test(l)) continue;
    const head = /^([A-Z]{3,5}X?) (.+)$/.exec(l);
    const { text: rest, nums } = splitRow(head && !symbol ? head[2]! : l);
    if (head && !symbol) symbol = head[1]!;
    if (!symbol) break;
    if (nums.length >= 3 && typeof nums.at(-3) === "number") {
      name.push(rest);
      positions.push({
        symbol,
        name: collapseSpaces(name.join(" ")),
        kind: "FUND",
        quantity: nums.at(-3) as number,
        price: nums.at(-2) as number,
        valueCents: toCents(nums.at(-1)!)!,
        costBasisCents: null,
        expenseRatio: null,
      });
      name = [];
      symbol = null;
      continue;
    }
    if (name.length >= 3) break;
    name.push(rest);
  }
  const invested = positions.slice(1).reduce((s, p) => s + p.valueCents, 0);
  return {
    accountNumber,
    asOf: periodEnd,
    positions: positions.filter((p) => p.valueCents !== 0 || p.kind === "CASH"),
    printedTotalCents: total ? cashCents + Math.round(Number(total[1]!.replace(/,/g, "")) * 100) : invested ? null : cashCents,
  };
}
