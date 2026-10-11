import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, moneyTokens, parseMoney, parseMonthNameDate, parseSlashDate } from "../text.ts";

export const AMEX_SAVINGS_PARSER_ID = "amex-high-yield-savings";
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 1;

export function detectAmexSavings(text: string): boolean {
  return /American Express National Bank/.test(text) && /High Yield Savings Account: x+\d{4}/.test(text) && /Account Activity/.test(text);
}

const ROW_START = /^(\d{2}\/\d{2}\/\d{4})\s+(.*)$/;

/**
 * American Express High Yield Savings statements. Each activity row prints its amount
 * and the running balance but not which column it belongs to, so — as with Chase — the
 * direction of every row comes from the balance change, and the printed amount is only
 * a cross-check. The summary's total debits and credits tie the rows to the statement.
 */
export function parseAmexSavings(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];

  const period = /Statement Period: (.+?) - (.+?)$/m.exec(text);
  if (!period) throw new Error("Amex savings: statement period not found");
  const periodStart = parseMonthNameDate(period[1]!)!;
  const periodEnd = parseMonthNameDate(period[2]!)!;
  const accountNumber = /High Yield Savings Account: x+(\d{4})/.exec(text)![1]!;
  const owner = /Account Owner\(s\): (.+)$/m.exec(text)?.[1]?.trim();

  const activityAt = ls.findIndex((l) => l === "Account Activity");
  if (activityAt < 0) throw new Error("Amex savings: account activity not found");

  // Rows: a date, then text and money, possibly spread over several lines.
  type Raw = { date: string; text: string[]; money: number[] };
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (const l of ls.slice(activityAt + 1)) {
    if (/^-- \d+ of \d+ --$/.test(l) || /^\d{8} /.test(l)) continue;
    const start = ROW_START.exec(l);
    if (start) {
      cur = { date: start[1]!, text: [], money: [] };
      raws.push(cur);
      absorb(cur, start[2]!);
    } else if (cur) {
      absorb(cur, l);
    }
  }
  function absorb(r: Raw, s: string): void {
    const money = moneyTokens(s);
    // Strip the money tokens so the remainder is the description.
    const words = s.replace(/-?\$[\d,]+\.\d{2}/g, " ").trim();
    if (words) r.text.push(words);
    r.money.push(...money);
  }

  const begin = raws.find((r) => /^Beginning Balance/.test(r.text[0] ?? ""));
  const end = raws.find((r) => /^Ending Balance/.test(r.text[0] ?? ""));
  if (!begin || !end || begin.money.length < 1 || end.money.length < 1) throw new Error("Amex savings: beginning/ending balance not found");
  const opening = begin.money.at(-1)!;
  const closing = end.money.at(-1)!;

  const transactions: ParsedTransaction[] = [];
  let balance = opening;
  for (const r of raws) {
    if (r === begin || r === end) continue;
    if (r.money.length < 2) {
      warnings.push(`Row without amount and balance dropped: ${r.date} ${r.text.join(" ")}`);
      continue;
    }
    const printed = r.money.at(-2)!;
    const after = r.money.at(-1)!;
    const delta = after - balance;
    if (Math.abs(delta) !== Math.abs(printed)) {
      throw new Error(`Amex savings: balance after ${r.date} moves by ${delta}¢ but the row prints ${printed}¢`);
    }
    balance = after;
    transactions.push({
      date: parseSlashDate(r.date)!,
      datePrecision: "EXACT",
      description: collapseSpaces(r.text.join(" ")),
      amountCents: delta,
    });
  }
  if (balance !== closing) throw new Error("Amex savings: rows do not reach the ending balance");

  const checks = [];
  const debits = /Total Debits This Period (\$[\d,]+\.\d{2})/.exec(text)?.[1];
  const credits = /Total Credits This Period (\$[\d,]+\.\d{2})/.exec(text)?.[1];
  if (debits) checks.push({ label: "Total debits", expectedCents: parseMoney(debits)!, actualCents: -transactions.filter((t) => t.amountCents < 0).reduce((a, t) => a + t.amountCents, 0) });
  if (credits) checks.push({ label: "Total credits", expectedCents: parseMoney(credits)!, actualCents: transactions.filter((t) => t.amountCents > 0).reduce((a, t) => a + t.amountCents, 0) });
  const interest = /Interest Credited This Period (\$[\d,]+\.\d{2})/.exec(text)?.[1];
  if (interest) {
    checks.push({
      label: "Interest credited",
      expectedCents: parseMoney(interest)!,
      actualCents: transactions.filter((t) => /^Interest/i.test(t.description)).reduce((a, t) => a + t.amountCents, 0),
    });
  }

  return {
    parserId: AMEX_SAVINGS_PARSER_ID,
    parserVersion: VERSION,
    institution: "American Express",
    kind: "STATEMENT",
    title: "Amex High Yield Savings statement",
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "American Express",
        accountNumber,
        accountName: `Amex High Yield Savings${owner ? ` — ${owner.split(" ").slice(0, 1).join(" ")}` : ""}`,
        kind: "SAVINGS",
        subtype: "SAVINGS",
        periodStart,
        periodEnd,
        openingBalanceCents: opening,
        closingBalanceCents: closing,
        growthCents: 0,
        feesCents: 0,
        transactions,
        checks,
      },
    ],
    warnings,
  };
}
