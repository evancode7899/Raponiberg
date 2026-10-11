import { collapseSpaces, lines, parseSlashDate } from "../text.ts";
import { locatePosition, splitRow, splitRowLeading, toCents, type Holding, type HoldingKind, type HoldingsFacts } from "./types.ts";

/**
 * Holdings from Vanguard brokerage statements ("Balances and holdings for Vanguard
 * Brokerage Account—XXXX1234": the sweep money market, then ETFs, stocks, mutual funds)
 * and Vanguard 401(k) statements (the "Investment Activity" table of plan funds).
 */

const SECTIONS: [RegExp, HoldingKind][] = [
  [/^Sweep program$/, "CASH"],
  [/^ETFs$/, "ETF"],
  [/^Stocks$/, "STOCK"],
  [/^(Vanguard )?[Mm]utual funds$/, "FUND"],
  [/^(Certificates of deposit|Bonds|Treasur(y|ies).*)$/, "BOND"],
  [/^Options$/, "OPTION"],
];

/** Lines that end a row's name (the next row, its income estimate, a total, page furniture). */
const NAME_END = /^(Est\. annual income|7-day SEC Yield|Total |Account activity for|Balances and holdings for|-- \d+ of \d+ --)/;

export function extractVanguardBrokerageHoldings(text: string, periodEnd: string): HoldingsFacts[] {
  const ls = lines(text).map(collapseSpaces);
  const byAccount = new Map<string, Holding[]>();
  let account: string | null = null;
  let kind: HoldingKind = "FUND";

  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const hdr = /^Balances and holdings for Vanguard Brokerage Account—XXXX(\d{4})/.exec(l);
    if (hdr) {
      account = hdr[1]!;
      if (!byAccount.has(account)) byAccount.set(account, []);
      continue;
    }
    if (/^Account activity for/.test(l)) {
      account = null;
      continue;
    }
    if (!account) continue;
    const section = SECTIONS.find(([re]) => re.test(l));
    if (section) {
      kind = section[1];
      continue;
    }

    // ETF/stock rows open with the symbol; sweep rows open with the quantity.
    const sym = /^([A-Z][A-Z0-9.]{0,9}) (?=[-$\d])/.exec(l);
    const { nums, text } = splitRowLeading(sym ? l.slice(sym[0].length) : l);
    const at = nums.length >= 4 ? locatePosition(nums) : null;
    if (!at) continue;
    const name = [text];
    for (let j = i + 1; j < ls.length && name.length < 4; j++) {
      const n = ls[j]!;
      if (NAME_END.test(n) || /^[A-Z][A-Z0-9.]{0,9} [-$\d]/.test(n) || /^[\d,]+\.\d+ \$/.test(n)) break;
      name.push(n);
    }
    // Symbol rows: unrealized gain, cost basis, then quantity and price.
    const cost = sym && at.q >= 1 ? nums[at.q - 1] : null;
    byAccount.get(account)!.push({
      symbol: sym?.[1] ?? null,
      name: collapseSpaces(name.join(" ")),
      kind,
      quantity: nums[at.q] as number,
      price: nums[at.p] as number,
      valueCents: toCents(nums[at.v])!,
      costBasisCents: typeof cost === "number" ? toCents(cost) : null,
      expenseRatio: null,
    });
  }
  return [...byAccount]
    .filter(([, ps]) => ps.length)
    .map(([accountNumber, positions]) => ({ accountNumber, asOf: periodEnd, positions, printedTotalCents: null }));
}

/**
 * Vanguard 401(k): "Beginning Balance | Contributions | Other Transactions | Market
 * Gain/Loss | Shares/Units | Ending Balance | fund name" rows, then "Total Invested".
 */
export function extractVanguard401kHoldings(text: string, plan: string): HoldingsFacts | null {
  const ls = lines(text).map(collapseSpaces);
  const period = /ACCOUNT SUMMARY: \d{2}\/\d{2}\/\d{4} - (\d{2}\/\d{2}\/\d{4})/.exec(text);
  const start = ls.findIndex((l) => /^Balance Contributions Transactions\*? Gain\/Loss Units Balance$/.test(l));
  if (!period || start < 0) return null;
  const positions: Holding[] = [];
  let printedTotalCents: number | null = null;
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]!;
    if (/^Total Invested\b/.test(l)) {
      printedTotalCents = toCents(splitRow(l).nums.at(-1) ?? null);
      break;
    }
    const { nums, text } = splitRowLeading(l);
    if (nums.length < 6 || !text) continue;
    const next = ls[i + 1] ?? "";
    // A fund name wraps onto one more line unless that line starts the next row.
    // ("2065 Tr P" continues a name; a row has six figures before its name.)
    const wrap = splitRowLeading(next).nums.length >= 6 || /^(Take |Total |Beneficiary)/.test(next) ? "" : ` ${next}`;
    positions.push({
      symbol: null,
      name: collapseSpaces(`${text}${wrap}`).replace(/®/g, ""),
      kind: "FUND",
      quantity: nums.at(-2) as number,
      price: null,
      valueCents: toCents(nums.at(-1)!)!,
      costBasisCents: null,
      expenseRatio: null,
    });
  }
  return positions.length ? { accountNumber: plan, asOf: parseSlashDate(period[1]!)!, positions, printedTotalCents } : null;
}
