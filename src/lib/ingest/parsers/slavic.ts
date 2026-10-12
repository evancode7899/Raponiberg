import { extractSlavicHoldings } from "../holdings/index.ts";
import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate } from "../text.ts";

export const SLAVIC_PARSER_ID = "slavic-401k";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

export function detectSlavic(text: string): boolean {
  return /Slavic401k/i.test(text) && /Quarterly 401\(k\) Statement for/.test(text);
}

const EMPLOYEE_SOURCES = /^(Pretax Deferral|Roth Deferral|After-?Tax|Catch-?Up)/i;
const EMPLOYER_SOURCES = /^(Profit Sharing|Safe Harbor|Match|Employer|QNEC|QMAC)/i;
const ROLLOVER_SOURCES = /Rollover/i;

/**
 * Slavic401k quarterly statements. "Contribution Activity Highlights" gives this
 * period's contributions by money source (deferrals = employee, profit sharing /
 * safe harbor = employer); the Account Summary gives balances, transfers (rollovers),
 * withdrawals and net earnings. Fees are netted into "Net Earnings" by Slavic.
 */
export function parseSlavic(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];
  const m = /Quarterly 401\(k\) Statement for (\d{2}\/\d{2}\/\d{4}) - (\d{2}\/\d{2}\/\d{4})/.exec(text)!;
  const periodStart = parseSlashDate(m[1]!)!;
  const periodEnd = parseSlashDate(m[2]!)!;
  const accountNumber = /Account #:\s*(\d+)/.exec(text)?.[1];
  if (!accountNumber) throw new Error("Slavic: account number not found");
  const employerLine = ls.find((l) => / \/ [A-Z0-9]+$/.test(l) && /LP|LLC|Inc/i.test(l));
  const employer = employerLine ? collapseSpaces(employerLine.split(" / ")[0]!) : "Slavic401k";

  const money = (l: string | undefined) => (l ? parseMoney(l.trim()) : null);
  const valueAfterLabel = (label: string): number | null => {
    const line = ls.find((l) => l.startsWith(`${label} `) && /\$|\(/.test(l));
    if (!line) return null;
    return money(line.slice(label.length).trim().split(/\s+/)[0]);
  };

  const opening = valueAfterLabel("Beginning Balance");
  const additions = valueAfterLabel("Additions") ?? 0;
  const netEarnings = valueAfterLabel("Net Earnings") ?? 0;
  const closing = valueAfterLabel("Ending Balance");
  if (opening == null || closing == null) throw new Error("Slavic: balances not found");

  // "Transfers" and "Withdrawals" labels are printed stacked, values below them.
  let transfers = 0;
  let withdrawals = 0;
  const tIdx = ls.findIndex((l) => l === "Transfers");
  if (tIdx >= 0 && ls[tIdx + 1] === "Withdrawals") {
    transfers = money(ls[tIdx + 2]) ?? 0;
    withdrawals = money(ls[tIdx + 3]) ?? 0;
  } else {
    transfers = valueAfterLabel("Transfers") ?? 0;
    withdrawals = valueAfterLabel("Withdrawals") ?? 0;
  }
  // Withdrawals leave the account even when printed without parentheses.
  withdrawals = -Math.abs(withdrawals);

  // Contributions by source, "This Period" is the first column.
  const transactions: ParsedTransaction[] = [];
  let sourcedAdditions = 0;
  for (const l of ls) {
    const sm = /^([A-Za-z][A-Za-z /&-]+?)\s+(\$[\d,]+\.\d{2})\s+\$[\d,]+\.\d{2}\s+\$[\d,]+\.\d{2}\s+[\d.]+%$/.exec(l);
    if (!sm) continue;
    const source = sm[1]!.trim();
    const amount = parseMoney(sm[2]!)!;
    if (amount === 0 || ROLLOVER_SOURCES.test(source)) continue;
    const who = EMPLOYEE_SOURCES.test(source) ? "Employee" : EMPLOYER_SOURCES.test(source) ? "Employer" : null;
    if (!who) warnings.push(`Unknown contribution source "${source}" counted as employee money`);
    sourcedAdditions += amount;
    transactions.push({
      date: periodEnd,
      datePrecision: "PERIOD",
      description: `${source} contribution`,
      amountCents: amount,
      section: `${who ?? "Employee"} contributions`,
    });
  }
  if (transfers !== 0) {
    transactions.push({
      date: periodEnd,
      datePrecision: "PERIOD",
      description: transfers > 0 ? "Transfers in (rollover)" : "Transfers out",
      amountCents: transfers,
      section: "Transfers",
    });
  }
  if (withdrawals !== 0) {
    transactions.push({
      date: periodEnd,
      datePrecision: "PERIOD",
      description: "Withdrawals",
      amountCents: withdrawals,
      section: "Withdrawals",
    });
  }

  // Balances are authoritative; Slavic's printed earnings sometimes miss by a cent of
  // rounding, so earnings are derived from the balances and checked loosely.
  const flows = transactions.reduce((a, t) => a + t.amountCents, 0);
  const derivedEarnings = closing - opening - flows;
  if (derivedEarnings !== netEarnings) {
    warnings.push(
      `Slavic's printed net earnings differ from its balances by ${derivedEarnings - netEarnings}¢; using the balance-implied figure`,
    );
  }

  return {
    parserId: SLAVIC_PARSER_ID,
    parserVersion: VERSION,
    institution: "Slavic401k",
    kind: "STATEMENT",
    title: "Slavic401k quarterly statement",
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "Slavic401k",
        accountNumber,
        accountName: `401(k) — ${employer}`,
        kind: "INVESTMENT",
        subtype: "401K",
        periodStart,
        periodEnd,
        openingBalanceCents: opening,
        closingBalanceCents: closing,
        growthCents: derivedEarnings,
        feesCents: 0,
        transactions,
        checks: [
          { label: "Contributions by source = additions", expectedCents: additions, actualCents: sourcedAdditions },
          {
            label: "Printed net earnings ≈ balance-implied earnings",
            expectedCents: netEarnings,
            actualCents: derivedEarnings,
            toleranceCents: 2,
          },
        ],
      },
    ],
    holdings: [extractSlavicHoldings(text, accountNumber)].filter((h) => h != null),
    warnings,
  };
}
