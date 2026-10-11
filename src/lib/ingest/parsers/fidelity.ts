import { extractFidelityTax } from "../../tax/facts/investments.ts";
import { extractFidelityHoldings } from "../holdings/index.ts";
import type {
  AccountSubtype,
  BrokerageFacts,
  ParsedAccountSection,
  ParsedDocument,
  ParsedTransaction,
} from "../types.ts";
import {
  collapseSpaces,
  lines,
  parseMoneyOrDash,
  parseMonthNameDate,
  resolveMonthDay,
  trailingAmounts,
} from "../text.ts";

export const FIDELITY_PARSER_ID = "fidelity-investment-report";
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 2;

export function detectFidelity(text: string): boolean {
  return /INVESTMENT REPORT/.test(text) && /Fidelity/.test(text) && /(Account #|Account Number:) [A-Z0-9]{3}-\d{6}/.test(text);
}

/**
 * Sections whose rows move money into or out of the account. Fidelity's own summary
 * counts exactly these as Additions/Subtractions; "Other Activity In/Out" (journals,
 * expirations, promos) is folded into Change in Investment Value, so it stays growth.
 */
const FLOW_SECTIONS = [
  "Deposits",
  "Withdrawals",
  "Exchanges In",
  "Exchanges Out",
  "Contributions",
  "Distributions",
] as const;
/** Cash rows here are moved out of growth (see parseAccount); non-cash rows are skipped. */
const OTHER_ACTIVITY_SECTIONS = ["Other Activity In", "Other Activity Out"] as const;

const PAGE_BREAK = /^-- \d+ of \d+ --$/;

/**
 * Fidelity investment reports: one PDF, many accounts (brokerage, IRAs, 529...). Each
 * account becomes its own section with its own balances, market change, fees, and
 * dated external flows. Monthly reports are STATEMENTs; year-end reports carry only
 * annual totals and become PERIOD_SUMMARY documents used solely to fill gaps.
 */
export function parseFidelity(text: string): ParsedDocument {
  const all = lines(text);
  const warnings: string[] = [];
  const isYearEnd = /YEAR-END INVESTMENT REPORT/.test(text);

  const periodLine = all.find((l) => /^[A-Z][a-z]+ \d{1,2}, \d{4} - [A-Z][a-z]+ \d{1,2}, \d{4}$/.test(l));
  if (!periodLine) throw new Error("Fidelity: report period not found");
  const [s, e] = periodLine.split(" - ");
  const periodStart = parseMonthNameDate(s!)!;
  const periodEnd = parseMonthNameDate(e!)!;

  // Split into pages and attribute each page to the account in its header.
  const pages: string[][] = [[]];
  for (const l of all) {
    if (PAGE_BREAK.test(l)) pages.push([]);
    else pages.at(-1)!.push(l);
  }
  const byAccount = new Map<string, string[]>();
  const firstPage = pages[0] ?? [];
  for (const page of pages) {
    const hdr = page.find((l) => /^Account # [A-Z0-9]{3}-\d{6}$/.test(l));
    if (!hdr) continue;
    const num = hdr.slice("Account # ".length);
    byAccount.set(num, [...(byAccount.get(num) ?? []), ...page]);
  }
  // Single-account reports (529, early year-end reports) may only summarize on page 1;
  // it goes last so the account's own pages win when both have a summary.
  const page1Number = firstPage.find((l) => /^Account Number: [A-Z0-9]{3}-\d{6}$/.test(l))?.slice("Account Number: ".length);
  if (page1Number && byAccount.size <= 1) {
    byAccount.set(page1Number, [...(byAccount.get(page1Number) ?? []), ...firstPage]);
  }

  const sections: ParsedAccountSection[] = [];
  for (const [accountNumber, ls] of byAccount) {
    sections.push(parseAccount(accountNumber, ls, periodStart, periodEnd, isYearEnd, warnings));
  }
  if (sections.length === 0) throw new Error("Fidelity: no account sections found");

  return {
    parserId: FIDELITY_PARSER_ID,
    parserVersion: VERSION,
    institution: "Fidelity",
    kind: isYearEnd ? "PERIOD_SUMMARY" : "STATEMENT",
    title: isYearEnd ? `Fidelity year-end report ${periodEnd.slice(0, 4)}` : "Fidelity investment report",
    periodStart,
    periodEnd,
    sections,
    brokerageFacts: fidelityTaxFacts(text),
    // Year-end reports repeat December's holdings.
    holdings: isYearEnd ? [] : extractFidelityHoldings(text),
    warnings,
  };
}

/** The report's tax figures per account (income, realized gains, distributions...). */
export function fidelityTaxFacts(text: string): BrokerageFacts[] {
  const isChet = /CHET|Connecticut Higher Education Trust/i.test(text);
  return extractFidelityTax(text).map((a) => ({ ...a, isChet: isChet && a.kind === "529" }));
}

function parseAccount(
  accountNumber: string,
  ls: string[],
  periodStart: string,
  periodEnd: string,
  isYearEnd: boolean,
  warnings: string[],
): ParsedAccountSection {
  const hdrIdx = ls.findIndex((l) => l === `Account # ${accountNumber}`);
  const ownerLine = (hdrIdx >= 0 ? ls[hdrIdx + 1] : undefined) ??
    ls.find((l) => /BENEFICIARY|PARTICIPANT|INDIVIDUAL|IRA/.test(l)) ?? "";
  const { subtype, name } = classifyAccount(ownerLine, ls);

  // The account summary block: first value column is "This Period" (or the year, for
  // year-end reports, which print a single column).
  const summaryStart = ls.findIndex((l) => /^Beginning Account Value\b/.test(l));
  if (summaryStart < 0) throw new Error(`Fidelity: no account summary for ${accountNumber}`);
  const summaryEnd = ls.findIndex((l, i) => i > summaryStart && /^Ending Account Value\b/.test(l));
  const block = ls.slice(summaryStart, summaryEnd + 1);
  // First value after the label; reads left-to-right because the text layer sometimes
  // appends unrelated words to the end of a summary line ("$0.07 $0.07 Top Holdings").
  const first = (re: RegExp): number => {
    const line = block.find((l) => re.test(l));
    if (!line) return 0;
    const afterLabel = line.replace(re, "").replace(/^\s*(as of [A-Z][a-z]+ \d{1,2}, \d{4})?/, "");
    for (const tok of afterLabel.replace(/\*+/g, " ").trim().split(/\s+/)) {
      const v = parseMoneyOrDash(tok);
      if (v != null) return v;
    }
    return 0;
  };
  const opening = first(/^Beginning Account Value\b/);
  const additions = first(/^Additions\b/);
  const subtractions = first(/^Subtractions\b/);
  const fees = first(/^Transaction Costs, Fees & Charges\b/);
  const change = first(/^Change in Investment Value\b/);
  const closing = first(/^Ending Account Value\b/);

  const transactions: ParsedTransaction[] = [];
  if (isYearEnd) {
    // Annual totals only: one PERIOD row per flow type, from the summary breakdown
    // (and, for other activity, the core-account cash flow).
    for (const name of [...FLOW_SECTIONS, ...OTHER_ACTIVITY_SECTIONS]) {
      const source = (OTHER_ACTIVITY_SECTIONS as readonly string[]).includes(name) ? ls : block;
      const line = source.find((l) => new RegExp(`^${name} [\\d,.-]`).test(l));
      const amount = line ? trailingAmounts(line).values[0] ?? 0 : 0;
      if (amount !== 0) {
        transactions.push({
          date: periodEnd,
          datePrecision: "PERIOD",
          description: `${name} (year total)`,
          amountCents: name === "Other Activity Out" ? -Math.abs(amount) : amount,
          section: name,
        });
      }
    }
  } else {
    transactions.push(...parseFlowRows(ls, periodStart, periodEnd, warnings));
  }

  // Fidelity folds cash "other activity" (promotional bonuses, adjustments) into Change
  // in Investment Value. It isn't market performance, so it becomes its own row and
  // leaves growth — otherwise a $100 account-opening bonus on a $101 balance reads as a
  // 99% monthly return.
  const isOther = (t: ParsedTransaction) => (OTHER_ACTIVITY_SECTIONS as readonly string[]).includes(t.section ?? "");
  const otherActivity = transactions.filter(isOther).reduce((a, t) => a + t.amountCents, 0);
  const flowSum = transactions.filter((t) => !isOther(t)).reduce((a, t) => a + t.amountCents, 0);
  return {
    institution: "Fidelity",
    accountNumber,
    accountName: name,
    kind: "INVESTMENT",
    subtype,
    periodStart,
    periodEnd,
    openingBalanceCents: opening,
    closingBalanceCents: closing,
    growthCents: change - otherActivity,
    feesCents: fees,
    transactions,
    checks: [
      {
        label: "Beginning + additions + subtractions + change = ending",
        expectedCents: closing,
        actualCents: opening + additions + subtractions + change,
      },
      {
        // Subtractions include fees, which are reported separately from flows.
        label: "Itemized deposits/withdrawals/transfers = additions + subtractions − fees",
        expectedCents: additions + subtractions - fees,
        actualCents: flowSum,
      },
    ],
  };
}

function parseFlowRows(
  ls: string[],
  periodStart: string,
  periodEnd: string,
  warnings: string[],
): ParsedTransaction[] {
  const out: ParsedTransaction[] = [];
  let section: string | null = null;
  let pending: { mmdd: string; parts: string[] } | null = null;

  const flush = (amount: number | null) => {
    if (pending && amount != null && amount !== 0 && section) {
      out.push({
        date: resolveMonthDay(pending.mmdd, periodStart, periodEnd),
        datePrecision: "EXACT",
        description: collapseSpaces(pending.parts.join(" ").replace(/\s+-\s+-(\s+-)?$/, "")),
        amountCents: amount,
        section,
      });
    }
    pending = null;
  };

  for (const raw of ls) {
    const l = raw.replace(/^[a-z]\s+(?=\d{2}\/\d{2})/, ""); // stray footnote markers ("f 03/27")
    const header = [...FLOW_SECTIONS, ...OTHER_ACTIVITY_SECTIONS].find((n) => l === n || l === `${n} (continued)`);
    if (header) {
      section = header;
      pending = null;
      continue;
    }
    if (!section) continue;
    if (new RegExp(`^Total ${section}\\b`).test(l) || /^(Core Fund Activity|Securities Bought|Dividends, Interest|Holdings|Estimated Cash Flow|Net Adjustments|Additional Information)/.test(l)) {
      if (pending) warnings.push(`Unterminated ${section} row: ${(pending as { parts: string[] }).parts.join(" ")}`);
      section = null;
      pending = null;
      continue;
    }
    const start = /^(\d{2}\/\d{2})\s+(.*)$/.exec(l);
    if (start) {
      if (pending) warnings.push(`Unterminated ${section} row: ${pending.parts.join(" ")}`);
      pending = { mmdd: start[1]!, parts: [] };
      const { values, rest } = trailingAmounts(start[2]!);
      if (values.length > 0 && /\d\.\d{2}$/.test(start[2]!.trim())) {
        pending.parts.push(rest);
        flush(values.at(-1)!);
      } else if (values.length > 0) {
        // Row ends in dashes only (non-cash journal/expiration): no flow.
        pending.parts.push(rest);
        flush(null);
      } else {
        pending.parts.push(start[2]!);
      }
      continue;
    }
    if (pending) {
      const { values, rest } = trailingAmounts(l);
      if (values.length > 0 && /\d\.\d{2}$/.test(l)) {
        if (rest) pending.parts.push(rest);
        flush(values.at(-1)!);
      } else {
        pending.parts.push(l);
      }
    }
  }
  return out;
}

function classifyAccount(ownerLine: string, ls: string[]): { subtype: AccountSubtype; name: string } {
  const u = `${ownerLine} ${ls.slice(0, 40).join(" ")}`.toUpperCase();
  const owner = ownerLine.toUpperCase();
  if (/\(529\)|BENEFICIARY|COLLEGE/.test(owner) || /\(529\)/.test(u)) {
    const bene = /^(.*?) - BENEFICIARY/i.exec(ownerLine)?.[1];
    return { subtype: "529", name: `Fidelity 529${bene ? ` (${titleCase(bene)})` : ""}` };
  }
  if (/ROTH IRA/.test(owner)) return { subtype: "ROTH_IRA", name: "Fidelity Roth IRA" };
  if (/ROLLOVER IRA/.test(owner)) return { subtype: "ROLLOVER_IRA", name: "Fidelity Rollover IRA" };
  if (/TRADITIONAL IRA/.test(owner)) return { subtype: "TRADITIONAL_IRA", name: "Fidelity Traditional IRA" };
  if (/HSA|HEALTH SAVINGS/.test(owner)) return { subtype: "HSA", name: "Fidelity HSA" };
  if (/INDIVIDUAL|JOINT/.test(owner)) return { subtype: "BROKERAGE", name: "Fidelity Brokerage" };
  return { subtype: "OTHER", name: `Fidelity ${collapseSpaces(ownerLine.split("\t")[0] ?? "account")}` };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
