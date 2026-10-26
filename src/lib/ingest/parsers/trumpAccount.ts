import type { BrokerageFacts, HoldingsFacts, ParsedAccountSection, ParsedCheck, ParsedDocument, ParsedTransaction } from "../types.ts";
import type { Holding } from "../holdings/types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate } from "../text.ts";

export const TRUMP_ACCOUNT_PARSER_ID = "trump-account";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

const INSTITUTION = "Trump Account";

export function detectTrumpAccount(text: string): boolean {
  return /Trump Account #:/.test(text) && /section 530A/.test(text) && /Account Summary/.test(text);
}

/**
 * Transaction codes that only shuffle value inside the account (the automatic investment
 * of each contribution, dividends): they never change what it's worth except through
 * market change, so they are not flows.
 */
const INTERNAL_CODES = new Set(["BUY", "SELL", "CDIV", "DIV"]);
/** Contribution codes ("OCON" other, "PPCON" pilot program, ...): money arriving, always a credit. */
const CONTRIBUTION_CODE = /^[A-Z]*CON$/;

const MONEY = String.raw`\$[\d,]+\.\d{2}`;
/** "<description> Cash <code> <date> [qty price] <amount>": the amount is always the last column. */
const ROW = /^(.*?) Cash ([A-Za-z]+) (\d{2}\/\d{2}\/\d{4})((?: \S+)+)$/;

/**
 * A Trump Account (IRC §530A): a child's tax-deferred account, held by Robinhood
 * Securities as trustee, statements monthly. The money is the child's (the account is
 * "FBO" them), so the section names them and its tax figures carry the TRUMP_ACCOUNT
 * kind: Taxes shows it as theirs and leaves its income off every return until it's
 * withdrawn. It is filed as an "Other" investment, like a UTMA, never as an IRA, so its
 * deposits never count against a parent's IRA limit.
 *
 * Contributions are the only flows; the automatic investment that follows each one is
 * internal, and growth is what the balances leave after the contributions. The first
 * statement prints "N/A" for the opening balance: the account opened inside the period,
 * at zero. An unfamiliar transaction code is an error rather than a guess.
 */
export function parseTrumpAccount(text: string): ParsedDocument {
  const all = lines(text).map(collapseSpaces);
  const warnings: string[] = [];

  const number = /Trump Account #: \**(\d{4})\b/.exec(text)?.[1];
  if (!number) throw new Error("Trump Account: account number not found");
  const beneficiary = collapseSpaces(/Trump Account FBO ([^\n]+)/.exec(text)?.[1] ?? "");
  if (!beneficiary) throw new Error("Trump Account: beneficiary (FBO) not found");

  const period = all.map((l) => /^(\d{2}\/\d{2}\/\d{4}) to (\d{2}\/\d{2}\/\d{4})$/.exec(l)).find(Boolean);
  if (!period) throw new Error("Trump Account: statement period not found");
  const periodStart = parseSlashDate(period[1]!)!;
  const periodEnd = parseSlashDate(period[2]!)!;

  // "Portfolio Value N/A $1,005.15": opening (N/A on the first statement) and closing.
  const value = all.map((l) => new RegExp(String.raw`^Portfolio Value (N/A|-?${MONEY}) (-?${MONEY})$`).exec(l)).find(Boolean);
  if (!value) throw new Error("Trump Account: portfolio value not found");
  const firstStatement = value[1] === "N/A";
  const opening = firstStatement ? 0 : parseMoney(value[1]!)!;
  const closing = parseMoney(value[2]!)!;

  // ---- Transactions (page 3) ----
  const transactions: ParsedTransaction[] = [];
  let credits = 0;
  let debits = 0;
  const activityAt = all.findIndex((l) => /^Description Symbol Acct Type Transaction Date Qty Price Debit Credit$/.test(l));
  const totalAt = all.findIndex((l, i) => i > activityAt && /^Total Funds Paid and Received/.test(l));
  if (activityAt >= 0 && totalAt < 0) throw new Error("Trump Account: transaction table has no total");
  for (const l of activityAt >= 0 ? all.slice(activityAt + 1, totalAt) : []) {
    const m = ROW.exec(l);
    if (!m) continue; // security name, CUSIP and "Automatic Investment" lines above a trade
    const [, description, rawCode, date, columns] = m;
    const code = rawCode!.toUpperCase();
    const amount = parseMoney(columns!.trim().split(" ").at(-1)!);
    if (amount == null) throw new Error(`Trump Account: cannot read amount on "${l}"`);
    if (INTERNAL_CODES.has(code)) {
      if (code === "BUY") debits += amount;
      else credits += amount;
      continue;
    }
    if (!CONTRIBUTION_CODE.test(code)) throw new Error(`Trump Account: unfamiliar transaction code "${rawCode}" (${description}, ${amount / 100})`);
    credits += amount;
    // "Other Contribution: Debit Card Deposit" → section "Other Contribution", detail "Debit Card Deposit".
    const [section, detail] = description!.split(/:\s*/, 2);
    transactions.push({
      date: parseSlashDate(date!)!,
      datePrecision: "EXACT",
      description: description!,
      amountCents: amount,
      section: section!,
      detail: detail || undefined,
    });
  }

  const checks: ParsedCheck[] = [];
  const total = totalAt >= 0 ? new RegExp(String.raw`^Total Funds Paid and Received (${MONEY}) (${MONEY})$`).exec(all[totalAt]!) : null;
  if (total) {
    checks.push({ label: "Debit rows = total funds paid", expectedCents: parseMoney(total[1]!)!, actualCents: debits });
    checks.push({ label: "Credit rows = total funds received", expectedCents: parseMoney(total[2]!)!, actualCents: credits });
  }

  // Contribution summary: "Pilot Program $1,000.00 $1,000.00" = the "Pilot Program Contribution" rows.
  const summaryAt = all.findIndex((l) => l === "Contribution Summary This Period Year to Date");
  let contributionsYtd: number | null = null;
  if (summaryAt >= 0) {
    contributionsYtd = 0;
    for (const l of all.slice(summaryAt + 1)) {
      const m = new RegExp(String.raw`^(.+?) (${MONEY}) (${MONEY})$`).exec(l);
      if (!m) break;
      const label = m[1]!;
      const rows = transactions.filter((t) => t.section === `${label} Contribution`).reduce((s, t) => s + t.amountCents, 0);
      checks.push({ label: `${label} contributions = contribution summary`, expectedCents: parseMoney(m[2]!)!, actualCents: rows });
      contributionsYtd += parseMoney(m[3]!)!;
    }
  } else if (transactions.length) {
    warnings.push(`Trump Account ••${number}: no contribution summary to check the contributions against`);
  }

  const holdings = readHoldings(all, number, periodEnd);
  if (holdings) {
    checks.push({
      label: "Securities + cash = portfolio value",
      expectedCents: closing,
      actualCents: holdings.positions.reduce((s, p) => s + p.valueCents, 0),
    });
  }

  const flows = transactions.reduce((s, t) => s + t.amountCents, 0);
  const brokerageFacts: BrokerageFacts = {
    accountNumber: number,
    ownerLine: `Trump Account FBO ${beneficiary}`,
    kind: "TRUMP_ACCOUNT",
    periodStart,
    periodEnd,
    isYearEnd: false,
    isChet: false,
    endingValue: closing,
    // Tax-deferred: nothing earned inside it is anyone's income until it's withdrawn.
    income: null,
    realized: null,
    incomeRows: [],
    distributions: [],
    contributionsYtd,
  };

  const section: ParsedAccountSection = {
    institution: INSTITUTION,
    accountNumber: number,
    accountName: `Trump Account — ${beneficiary}`,
    kind: "INVESTMENT",
    subtype: "OTHER",
    periodStart,
    periodEnd,
    openingBalanceCents: opening,
    closingBalanceCents: closing,
    growthCents: closing - opening - flows,
    // The statement prints values, not a change-in-value line: growth is what the contributions leave.
    growthFromBalances: true,
    feesCents: 0,
    transactions,
    checks,
  };

  return {
    parserId: TRUMP_ACCOUNT_PARSER_ID,
    parserVersion: VERSION,
    institution: INSTITUTION,
    kind: "STATEMENT",
    title: "Trump Account statement",
    periodStart: section.periodStart,
    periodEnd,
    sections: [section],
    brokerageFacts: [brokerageFacts],
    holdings: holdings ? [holdings] : [],
    warnings,
  };
}

/**
 * "Securities Held in Account": one row per position,
 * "<name> <SYMBOL> Cash <qty> $<price> $<value> <pct>%", then the brokerage cash balance.
 */
function readHoldings(all: string[], accountNumber: string, asOf: string): HoldingsFacts | null {
  const at = all.findIndex((l) => /^Securities Held in Account /.test(l));
  if (at < 0) return null;
  const positions: Holding[] = [];
  let printedTotalCents: number | null = null;
  for (const l of all.slice(at + 1)) {
    if (/^Page of/.test(l)) break;
    const p = new RegExp(String.raw`^(.+) ([A-Z][A-Z0-9.]{0,9}) Cash ([\d.]+) \$([\d,]*\.\d+) (${MONEY}) [\d.]+%$`).exec(l);
    if (p) {
      positions.push({
        symbol: p[2]!,
        name: p[1]!,
        kind: /\bETF\b/.test(p[1]!) ? "ETF" : "OTHER",
        quantity: Number(p[3]),
        price: Number(p[4]!.replace(/,/g, "")),
        valueCents: parseMoney(p[5]!)!,
        costBasisCents: null,
        expenseRatio: null,
      });
      continue;
    }
    const cash = new RegExp(String.raw`^Brokerage Cash Balance (-?${MONEY})`).exec(l);
    if (cash) {
      const cents = parseMoney(cash[1]!)!;
      if (cents) positions.push({ symbol: null, name: "Brokerage cash", kind: "CASH", quantity: null, price: null, valueCents: cents, costBasisCents: null, expenseRatio: null });
      continue;
    }
    const tot = new RegExp(String.raw`^Total Priced Portfolio (${MONEY})$`).exec(l);
    if (tot) printedTotalCents = parseMoney(tot[1]!)!;
  }
  return { accountNumber, asOf, positions, printedTotalCents };
}