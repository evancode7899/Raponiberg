import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import {
  collapseSpaces,
  lines,
  moneyTokens,
  parseMonthNameDate,
  resolveMonthDay,
  trailingAmounts,
} from "../text.ts";

export const CHASE_PARSER_ID = "chase-checking";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

export function detectChase(text: string): boolean {
  return /JPMorgan Chase Bank, N\.A\./.test(text) && /\bthrough\b/.test(text) && /Beginning Balance/.test(text);
}

const ROW_START = /^(\d{2}\/\d{2})\s+(?:\d{2}\/\d{2}\s+)?(.*)$/;

/**
 * Chase's PDF text layer detaches the amount column from many rows (the amounts end up
 * listed elsewhere on the page), but every row keeps its running balance. So the amount
 * of each row is derived as balance − previous balance, which is exact and order-checked;
 * a printed amount, when one survived, is only used as a cross-check.
 */
export function parseChase(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];

  const periodLine = ls.find((l) => /^[A-Z][a-z]+ \d{1,2}, \d{4} through [A-Z][a-z]+ \d{1,2}, \d{4}/.test(l));
  if (!periodLine) throw new Error("Chase: statement period not found");
  const [startText, endText] = periodLine.split(" through ");
  const periodStart = parseMonthNameDate(startText!)!;
  const periodEnd = parseMonthNameDate(endText!)!;

  const begin = ls.find((l) => /^Beginning Balance \$?-?[\d,]+\.\d{2}$/.test(l));
  const end = ls.find((l) => /^Ending Balance \$?-?[\d,]+\.\d{2}$/.test(l));
  if (!begin || !end) throw new Error("Chase: beginning/ending balance not found");
  const openingBalanceCents = trailingAmounts(begin).values.at(-1)!;
  const closingBalanceCents = trailingAmounts(end).values.at(-1)!;

  // Account number: the 15-digit statement id line ends with the account's last 4.
  const idLine = ls.find((l) => /^\d{15}$/.test(l));
  const accountNumber = idLine ? idLine.slice(-4) : "unknown";
  const productLine = ls.find((l) => /^Chase .*(Checking|Savings)$/.test(l)) ?? "Chase Checking";

  // Gather rows: a row starts with MM/DD and runs until a line ending in money.
  const rawRows: { mmdd: string; body: string }[] = [];
  let pending: { mmdd: string; body: string } | null = null;
  for (const l of ls) {
    const start = ROW_START.exec(l);
    if (start && !pending) {
      pending = { mmdd: start[1]!, body: start[2]! };
    } else if (pending) {
      if (start) {
        // A new row began before the previous one found its balance.
        warnings.push(`Row without balance dropped: ${pending.mmdd} ${pending.body}`);
        pending = { mmdd: start[1]!, body: start[2]! };
      } else {
        pending.body += ` ${l}`;
      }
    } else {
      continue;
    }
    if (pending && endsWithMoney(pending.body)) {
      rawRows.push(pending);
      pending = null;
    } else if (pending && pending.body.length > 400) {
      pending = null; // runaway: not a transaction row
    }
  }

  const transactions: ParsedTransaction[] = [];
  let prevBalance = openingBalanceCents;
  let printedMismatches = 0;
  for (const r of rawRows) {
    const { values, rest } = trailingAmounts(r.body, { joinSplitNegatives: true });
    const balance = values.at(-1)!;
    const amount = balance - prevBalance;
    if (values.length >= 2 && values.at(-2) !== amount) {
      printedMismatches++;
      warnings.push(
        `Printed amount ${values.at(-2)} disagrees with balance delta ${amount} on ${r.mmdd} ${rest}`,
      );
    }
    prevBalance = balance;
    if (amount === 0) continue;
    transactions.push({
      date: resolveMonthDay(r.mmdd, periodStart, periodEnd),
      datePrecision: "EXACT",
      description: cleanDescription(rest),
      amountCents: amount,
      section: amount > 0 ? "Deposits and Additions" : "Withdrawals",
    });
  }

  // Summary lines printed by Chase (deposits total, withdrawals totals) as cross-checks.
  const checks = [
    {
      label: "Last row balance = ending balance",
      expectedCents: closingBalanceCents,
      actualCents: prevBalance,
    },
  ];
  const depositsLine = ls.find((l) => /^Deposits and Additions [\d,]+\.\d{2}$/.test(l));
  if (depositsLine) {
    checks.push({
      label: "Deposits and Additions",
      expectedCents: moneyTokens(depositsLine).at(-1)!,
      actualCents: transactions.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0),
    });
  }
  if (printedMismatches > 0) {
    checks.push({ label: "Printed row amounts agree with balances", expectedCents: 0, actualCents: printedMismatches });
  }

  return {
    parserId: CHASE_PARSER_ID,
    parserVersion: VERSION,
    institution: "Chase",
    kind: "STATEMENT",
    title: `${productLine} statement`,
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "Chase",
        accountNumber,
        accountName: productLine,
        kind: /Savings/.test(productLine) ? "SAVINGS" : "CHECKING",
        subtype: /Savings/.test(productLine) ? "SAVINGS" : "CHECKING",
        periodStart,
        periodEnd,
        openingBalanceCents,
        closingBalanceCents,
        growthCents: 0,
        feesCents: 0,
        transactions,
        checks,
      },
    ],
    warnings,
  };
}

function endsWithMoney(body: string): boolean {
  return /(?:-\s?)?\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/.test(body.trim());
}

function cleanDescription(s: string): string {
  return collapseSpaces(s.replace(/\s-\s*$/, ""));
}
