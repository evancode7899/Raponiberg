import { collapseSpaces, lines, parseMonthNameDate, resolveMonthDay, trailingAmounts } from "../../ingest/text.ts";

/**
 * Tax figures from a Fidelity investment report, per account: the year-to-date Income
 * Summary and Realized Gains blocks, this period's individual dividend payments (to tell
 * qualified fund/stock dividends from money-market and bond income), IRA distributions
 * (rollover vs Roth conversion vs taxable withdrawal), and contributions (IRA basis,
 * CHET 529 deduction). The ledger's parser only keeps balances and money flows; this
 * re-reads the same stored text for what a tax return needs.
 */

/**
 * CUSTODIAL: a UTMA/UGMA account. The money is the child's, and so is its income (kiddie tax).
 * TRUMP_ACCOUNT: a child's §530A account. The money is the child's, but its income is
 * tax-deferred: on nobody's return until it's withdrawn.
 */
export type AccountTaxKind = "TAXABLE" | "ROTH_IRA" | "TRADITIONAL_IRA" | "ROLLOVER_IRA" | "529" | "HSA" | "CUSTODIAL" | "TRUMP_ACCOUNT" | "OTHER";

export const ACCOUNT_KIND_LABEL: Record<AccountTaxKind, string> = {
  TAXABLE: "Brokerage",
  ROTH_IRA: "Roth IRA",
  TRADITIONAL_IRA: "Traditional IRA",
  ROLLOVER_IRA: "Rollover IRA",
  "529": "529",
  HSA: "HSA",
  CUSTODIAL: "UTMA/UGMA",
  TRUMP_ACCOUNT: "Trump Account",
  OTHER: "Account",
};

export const ACCOUNT_TAX_KINDS: readonly AccountTaxKind[] = ["TAXABLE", "ROTH_IRA", "TRADITIONAL_IRA", "ROLLOVER_IRA", "529", "HSA", "CUSTODIAL", "TRUMP_ACCOUNT", "OTHER"];

/** Kinds whose money is a child's, not a parent's. */
export const CHILD_KINDS: readonly AccountTaxKind[] = ["CUSTODIAL", "TRUMP_ACCOUNT"];

export type IncomeRow = {
  date: string;
  security: string;
  cusip: string;
  kind: "DIVIDEND" | "INTEREST" | "CAP_GAIN_ST" | "CAP_GAIN_LT" | "FOREIGN_TAX" | "OTHER";
  amount: number;
  /** Money-market or bond income: never a qualified dividend. */
  nonQualified: boolean;
  moneyMarket: boolean;
};

export type DistributionRow = {
  date: string;
  description: string;
  amount: number;
  kind: "ROLLOVER" | "ROTH_CONVERSION" | "DISTRIBUTION";
};

export type AccountTaxSnapshot = {
  accountNumber: string;
  ownerLine: string;
  kind: AccountTaxKind;
  periodStart: string;
  periodEnd: string;
  isYearEnd: boolean;
  endingValue: number | null;
  /** Year-to-date Income Summary. */
  income: {
    dividends: number;
    interest: number;
    capGainDistShort: number;
    capGainDistLong: number;
    taxExempt: number;
    taxDeferred: number;
  } | null;
  /** Year-to-date net realized gain/loss from sales (null: block absent = none). */
  realized: { shortTerm: number; longTerm: number } | null;
  incomeRows: IncomeRow[];
  distributions: DistributionRow[];
  contributionsYtd: number | null;
};

const PAGE_BREAK = /^-- \d+ of \d+ --$/;

export function extractFidelityTax(text: string): AccountTaxSnapshot[] {
  const all = lines(text);
  const isYearEnd = /YEAR-END INVESTMENT REPORT/.test(text);
  const periodLine = all.find((l) => /^[A-Z][a-z]+ \d{1,2}, \d{4} - [A-Z][a-z]+ \d{1,2}, \d{4}$/.test(l));
  if (!periodLine) return [];
  const [s, e] = periodLine.split(" - ");
  const periodStart = parseMonthNameDate(s!)!;
  const periodEnd = parseMonthNameDate(e!)!;

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
  const page1Number = pages[0]?.find((l) => /^Account Number: [A-Z0-9]{3}-\d{6}$/.test(l))?.slice("Account Number: ".length);
  if (page1Number && byAccount.size <= 1) byAccount.set(page1Number, [...(byAccount.get(page1Number) ?? []), ...pages[0]!]);

  return [...byAccount].map(([accountNumber, ls]) => parseAccount(accountNumber, ls, periodStart, periodEnd, isYearEnd));
}

function lastValue(line: string | undefined): number {
  if (!line) return 0;
  return trailingAmounts(line.replace(/\$/g, "")).values.at(-1) ?? 0;
}

function accountKind(ownerLine: string): AccountTaxKind {
  const o = ownerLine.toUpperCase();
  if (/\(529\)|BENEFICIARY|COLLEGE/.test(o)) return "529";
  if (/\bUTMA\b|\bUGMA\b|CUSTODIAN|\bCUST\b/.test(o)) return "CUSTODIAL";
  if (/ROTH/.test(o)) return "ROTH_IRA";
  if (/ROLLOVER/.test(o)) return "ROLLOVER_IRA";
  if (/TRADITIONAL|\bIRA\b|SEP|SIMPLE/.test(o)) return "TRADITIONAL_IRA";
  if (/HSA|HEALTH SAVINGS/.test(o)) return "HSA";
  if (/INDIVIDUAL|JOINT|TOD|TRUST/.test(o)) return "TAXABLE";
  return "OTHER";
}

function parseAccount(accountNumber: string, ls: string[], periodStart: string, periodEnd: string, isYearEnd: boolean): AccountTaxSnapshot {
  const hdrIdx = ls.findIndex((l) => l === `Account # ${accountNumber}`);
  const ownerLine = collapseSpaces(
    ((hdrIdx >= 0 ? ls[hdrIdx + 1] : undefined) ?? ls.find((l) => /BENEFICIARY|PARTICIPANT|INDIVIDUAL|IRA/.test(l)) ?? "").replace(
      /\s+(Account Summary|Holdings|Activity|Additional Information.*|Estimated Cash Flow.*)$/,
      "",
    ),
  );
  const endingLine = ls.find((l) => /^Ending Account Value\b/.test(l) && !/Incl/.test(l));
  const endingTokens = endingLine ? endingLine.replace(/^Ending Account Value\s*/, "").split(/\s+/) : [];
  const endingValue = endingTokens.length ? (trailingAmounts(endingTokens[0]!.replace(/\$/g, "")).values[0] ?? null) : null;

  // Account-level Income Summary (the portfolio-level one has "This Period" on its line).
  let income: AccountTaxSnapshot["income"] = null;
  const incIdx = ls.findIndex((l) => l === "Income Summary");
  if (incIdx >= 0) {
    income = { dividends: 0, interest: 0, capGainDistShort: 0, capGainDistLong: 0, taxExempt: 0, taxDeferred: 0 };
    for (let i = incIdx + 1; i < ls.length && i < incIdx + 15; i++) {
      const l = ls[i]!;
      if (/^Total\b/.test(l)) break;
      const v = lastValue(l);
      if (/^Dividends\b/.test(l)) income.dividends += v;
      else if (/^Interest\b/.test(l)) income.interest += v;
      else if (/^Short-term Cap/i.test(l)) income.capGainDistShort += v;
      else if (/^Long-term Cap/i.test(l)) income.capGainDistLong += v;
      else if (/^Tax-(exempt|free)\b/i.test(l)) income.taxExempt += v;
      else if (/^Tax-deferred\b/i.test(l)) income.taxDeferred += v;
    }
  }

  let realized: AccountTaxSnapshot["realized"] = null;
  const rgIdx = ls.findIndex((l) => l === "Realized Gains and Losses from Sales");
  if (rgIdx >= 0) {
    const block = ls.slice(rgIdx + 1, rgIdx + 12);
    realized = {
      shortTerm: lastValue(block.find((l) => /^Net Short-term Gain\/Loss\b/.test(l))),
      longTerm: lastValue(block.find((l) => /^Net Long-term Gain\/Loss\b/.test(l))),
    };
  }

  const contribLine = ls.find((l) => /^(\d{4} )?Contributions \$?[\d,]+\.\d{2}/.test(l));
  return {
    accountNumber,
    ownerLine,
    kind: accountKind(ownerLine),
    periodStart,
    periodEnd,
    isYearEnd,
    endingValue,
    income,
    realized,
    incomeRows: isYearEnd ? [] : incomeRows(ls, periodStart, periodEnd),
    distributions: isYearEnd ? [] : distributionRows(ls, periodStart, periodEnd),
    contributionsYtd: contribLine ? lastValue(contribLine) : null,
  };
}

export const MONEY_MARKET = /MONEY MARKET|MMKT|CASH RESERVES|TREASURY ONLY|GOVT? CASH|SPAXX|FDRXX|FZFXX/i;
export const BONDISH = /\bBOND|TREASURY|AGGREGATE|T-BILL|FIXED INCOME|INCOME FUND|\bTIPS\b|MUNI/i;
const ROW_SKIP = /^(Settlement|Date Security Name|Symbol\/|CUSIP Description|\(Includes dividend|TRADE DATE|MR_CE|INVESTMENT REPORT|S$|\d+ of \d+$|Account # |[A-Z][a-z]+ \d{1,2}, \d{4} - )/;

function incomeRows(ls: string[], periodStart: string, periodEnd: string): IncomeRow[] {
  const out: IncomeRow[] = [];
  let inSection = false;
  let row: { mmdd: string; parts: string[] } | null = null;
  for (const l of ls) {
    if (/^Dividends, Interest & Other Income( \(continued\))?$/.test(l)) {
      inSection = true;
      row = null;
      continue;
    }
    if (!inSection) continue;
    if (/^Total Dividends, Interest/.test(l)) {
      inSection = false;
      row = null;
      continue;
    }
    // Page furniture repeated when the section continues on the next page.
    if (ROW_SKIP.test(l) || /\s(Activity|Holdings)$/.test(l)) continue;
    const start = /^(\d{2}\/\d{2})\s+(.*)$/.exec(l);
    if (start) row = { mmdd: start[1]!, parts: [start[2]!] };
    else if (row) row.parts.push(l);
    if (!row) continue;
    const joined = collapseSpaces(row.parts.join(" "));
    const m = /^(.*?)\s([0-9A-Z]{9})\s(.+?)(?:\s+(?:-|[\d.,]+)){0,2}\s+(-?\$?-?[\d,]+\.\d{2})$/.exec(joined);
    if (!m) continue;
    const [, security, cusip, desc, amt] = m;
    const date = resolveMonthDay(row.mmdd, periodStart, periodEnd);
    row = null;
    if (/Reinvestment/i.test(desc!)) continue;
    const amount = trailingAmounts(amt!.replace(/\$/g, "")).values[0] ?? 0;
    const kind: IncomeRow["kind"] = /Dividend/i.test(desc!)
      ? "DIVIDEND"
      : /Interest/i.test(desc!)
        ? "INTEREST"
        : /Long-Term Cap/i.test(desc!)
          ? "CAP_GAIN_LT"
          : /Short-Term Cap/i.test(desc!)
            ? "CAP_GAIN_ST"
            : /Foreign Tax/i.test(desc!)
              ? "FOREIGN_TAX"
              : "OTHER";
    const moneyMarket = MONEY_MARKET.test(security!);
    out.push({
      date,
      security: collapseSpaces(security!),
      cusip: cusip!,
      kind,
      amount,
      moneyMarket,
      nonQualified: moneyMarket || BONDISH.test(security!),
    });
  }
  return out;
}

function distributionRows(ls: string[], periodStart: string, periodEnd: string): DistributionRow[] {
  const out: DistributionRow[] = [];
  let inSection = false;
  let row: { mmdd: string; parts: string[] } | null = null;
  for (const l of ls) {
    if (l === "Distributions" || l === "Distributions (continued)") {
      inSection = true;
      row = null;
      continue;
    }
    if (!inSection) continue;
    if (/^Total Distributions/.test(l)) {
      inSection = false;
      continue;
    }
    if (/^Date Reference Description Amount$/.test(l)) continue;
    const start = /^(\d{2}\/\d{2})\s+(.*)$/.exec(l);
    if (start) row = { mmdd: start[1]!, parts: [start[2]!] };
    else if (row) row.parts.push(l);
    if (!row) continue;
    const joined = collapseSpaces(row.parts.join(" "));
    const { values, rest } = trailingAmounts(joined.replace(/\$/g, ""));
    if (!values.length || !/\d\.\d{2}$/.test(joined)) continue;
    const description = rest;
    out.push({
      date: resolveMonthDay(row.mmdd, periodStart, periodEnd),
      description,
      amount: Math.abs(values.at(-1)!),
      kind: /Roll To Qual|Dir Roll|Rollover|Trustee to Trustee|Transfer of Assets/i.test(description)
        ? "ROLLOVER"
        : /Roth/i.test(description)
          ? "ROTH_CONVERSION"
          : "DISTRIBUTION",
    });
    row = null;
  }
  return out;
}
