import { addDays } from "../../dates/isoDate.ts";
import { BONDISH, MONEY_MARKET, type AccountTaxKind, type IncomeRow } from "../../tax/facts/investments.ts";
import { extractVanguardBrokerageHoldings } from "../holdings/index.ts";
import type { AccountSubtype, BrokerageFacts, ParsedAccountSection, ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseMonthNameDate, parseSlashDate, resolveMonthDay } from "../text.ts";

export const VANGUARD_BROKERAGE_PARSER_ID = "vanguard-brokerage";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

export function detectVanguardBrokerage(text: string): boolean {
  return (
    /Vanguard Brokerage Services/.test(text) &&
    /(monthly transaction statement|quarter-to-date statement|quarterly transaction statement)/.test(text) &&
    /Account overview/.test(text)
  );
}

/**
 * Transaction types that only shuffle value inside the account (cash sweep, dividend
 * reinvestment, trades): they never change what the account is worth except through
 * market change, so they are not flows.
 */
const INTERNAL_TYPES = new Set([
  "sweep in",
  "sweep out",
  "dividend",
  "reinvestment",
  "buy",
  "sell",
  "interest",
  "capital gain (lt)",
  "capital gain (st)",
  "long-term capital gain",
  "short-term capital gain",
  "return of capital",
  "foreign tax paid",
  "withholding",
  "redemption",
  "exchange",
  "conversion (fund)",
  "split",
  "merger",
]);
/** Types that put money into or take it out of the account. */
const FLOW_TYPES = new Set([
  "funds received",
  "funds sent",
  "contribution",
  "conversion",
  "distribution",
  "withdrawal",
  "transfer (incoming)",
  "transfer (outgoing)",
  "transfer (in)",
  "transfer (out)",
  "transfer",
  "journal",
  "rollover",
  "recharacterization",
  "check",
  "wire",
  "ach",
]);
const FEE_TYPES = /^(fee|account fee|service fee|advisory fee|annual fee|wire fee)/;

const KNOWN_TYPES = [...INTERNAL_TYPES, ...FLOW_TYPES, "fee", "account fee", "service fee", "advisory fee"].sort((a, b) => b.length - a.length);

type Block = { overviewIndex: number; lines: string[] };

/** "Roth IRA brokerage account" → account flavor. */
function subtypeFor(label: string): { subtype: AccountSubtype; name: string } {
  const l = label.toLowerCase();
  if (l.includes("roth")) return { subtype: "ROTH_IRA", name: "Roth IRA" };
  if (l.includes("rollover")) return { subtype: "ROLLOVER_IRA", name: "Rollover IRA" };
  if (l.includes("traditional") || l.includes("trad ira")) return { subtype: "TRADITIONAL_IRA", name: "Traditional IRA" };
  if (l.includes("529")) return { subtype: "529", name: "529" };
  return { subtype: "BROKERAGE", name: "Brokerage" };
}

const TAX_KIND: Partial<Record<AccountSubtype, AccountTaxKind>> = {
  BROKERAGE: "TAXABLE",
  ROTH_IRA: "ROTH_IRA",
  TRADITIONAL_IRA: "TRADITIONAL_IRA",
  ROLLOVER_IRA: "ROLLOVER_IRA",
  "529": "529",
};

/** Income transaction types → the kind of tax figure each one is. */
const INCOME_KINDS: Record<string, IncomeRow["kind"]> = {
  dividend: "DIVIDEND",
  interest: "INTEREST",
  "capital gain (lt)": "CAP_GAIN_LT",
  "long-term capital gain": "CAP_GAIN_LT",
  "capital gain (st)": "CAP_GAIN_ST",
  "short-term capital gain": "CAP_GAIN_ST",
  "foreign tax paid": "FOREIGN_TAX",
};

const INCOME_HEADER = "Dividends Interest Tax-exempt interest Short-term capital gains Long-term capital gains Other income";

const titleCase =(s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Vanguard Personal Investor (brokerage, IRAs). Statements are monthly, plus a
 * quarter-to-date statement at each quarter end, and cover one or more accounts. The
 * quarter-end statement opens at the quarter's start value but lists only activity since
 * the account's last monthly statement, so its sections start after any statement already
 * imported inside the quarter (startsAfterPrior). For each account the statement gives its value at the start and end of the
 * period; the only things that change a balance are market change (dividends, prices)
 * and money moving in or out, so growth is whatever the dated external flows leave
 * unexplained and everything else (cash sweep, reinvested dividends, trades) is ignored.
 *
 * An unfamiliar transaction type is an error rather than a guess: silently treating a
 * deposit as growth would hide real money.
 *
 * Tax figures: each account's Income summary prints year-to-date dividends, interest,
 * tax-exempt interest and capital gain distributions, and the dividend rows name the fund
 * (to tell money-market income, never qualified, from fund dividends). Vanguard
 * statements don't print realized gains from sales; those come from the 1099-B.
 */
export function parseVanguardBrokerage(text: string): ParsedDocument {
  const all = lines(text).map(collapseSpaces);
  const warnings: string[] = [];

  const endMatch = /([A-Z][a-z]+ \d{1,2}, \d{4}), (?:monthly transaction|quarter-to-date|quarterly transaction) statement/.exec(text);
  if (!endMatch) throw new Error("Vanguard: statement date not found");
  const periodEnd = parseMonthNameDate(endMatch[1]!)!;

  // Opening/closing dates: "Value on 07/31/2026 / Value on 08/31/2026".
  const valueDates = /Value on\s+(\d{2}\/\d{2}\/\d{4})\s+Value on\s+(\d{2}\/\d{2}\/\d{4})/.exec(text);
  if (!valueDates) throw new Error("Vanguard: value dates not found");
  const openingDate = parseSlashDate(valueDates[1]!)!;
  const closingDate = parseSlashDate(valueDates[2]!)!;
  if (closingDate !== periodEnd) throw new Error(`Vanguard: statement date ${periodEnd} differs from closing value date ${closingDate}`);
  const periodStart = addDays(openingDate, 1);
  const quarterToDate = /quarter-to-date statement/.test(text);

  // Page-2 table of accounts: label + value at the start + value at the end.
  const tableStart = all.findIndex((l) => /^Accounts Value on$/.test(l) || /^Accounts$/.test(l));
  const tableRows: { label: string; opening: number; closing: number }[] = [];
  for (let i = Math.max(0, tableStart); i < all.length; i++) {
    const l = all[i]!;
    if (/^Brokerage assets are held/.test(l)) break;
    const rm = /^(.+?(?:brokerage account|529[^$]*)) (-?\$[\d,]+\.\d{2}) (-?\$[\d,]+\.\d{2})$/i.exec(l);
    if (rm) tableRows.push({ label: rm[1]!, opening: parseMoney(rm[2]!)!, closing: parseMoney(rm[3]!)! });
  }

  // Split into per-account blocks at each "Account overview" line.
  const overviewIdx: number[] = [];
  all.forEach((l, i) => {
    if (/^Account overview\b/.test(l)) overviewIdx.push(i);
  });
  const disclosuresAt = all.findIndex((l) => l === "Disclosures");
  const blocks: Block[] = overviewIdx.map((start, n) => ({
    overviewIndex: start,
    lines: all.slice(start, overviewIdx[n + 1] ?? (disclosuresAt > start ? disclosuresAt : all.length)),
  }));
  if (blocks.length === 0) throw new Error("Vanguard: no account overview found");
  if (tableRows.length !== blocks.length) {
    throw new Error(`Vanguard: ${tableRows.length} accounts in the summary table but ${blocks.length} account sections`);
  }

  const brokerageFacts: BrokerageFacts[] = [];
  const sections: ParsedAccountSection[] = blocks.map((b, n) => {
    const row = tableRows[n]!;
    const header = b.lines.find((l) => /brokerage account—XXXX\d{4}/i.test(l)) ?? "";
    const number = /XXXX(\d{4})/.exec(header)?.[1];
    if (!number) throw new Error("Vanguard: account number not found");
    const { subtype, name } = subtypeFor(row.label + " " + header);
    // The line under the account header names the owner: "PAT EXAMPLE ROTH IRA VFTC AS CUSTODIAN".
    const headerAt = b.lines.findIndex((l) => l === header);
    const ownerLine = headerAt >= 0 ? b.lines[headerAt + 1] ?? "" : "";
    const owner = /^[A-Z][A-Z .'-]+$/.test(ownerLine)
      ? titleCase(ownerLine.replace(/\s+(?:(?:ROTH|TRAD|TRADITIONAL|ROLLOVER|SEP|SIMPLE) )?(?:IRA )?VFTC AS CUSTODIAN$/, ""))
      : "";

    const totalLine = b.lines.find((l) => /^Account overview /.test(l));
    const totalValue = totalLine ? parseMoney(/(-?\$[\d,]+\.\d{2})/.exec(totalLine)?.[1] ?? "") : null;

    // ---- Completed transactions ----
    const transactions: ParsedTransaction[] = [];
    let fees = 0;
    let inActivity = false;
    let dividendRows = 0;
    let sales = 0;
    const incomeRows: IncomeRow[] = [];
    let current: { settle: string; description: string; type: string; amount: number; detail: string[] } | null = null;
    const flush = () => {
      if (!current) return;
      const t = current;
      current = null;
      const typeKey = t.type.toLowerCase();
      if (FEE_TYPES.test(typeKey)) {
        fees += -Math.abs(t.amount);
        return;
      }
      if (INTERNAL_TYPES.has(typeKey)) {
        if (typeKey === "dividend") dividendRows += t.amount;
        if (typeKey === "sell" || typeKey === "redemption" || typeKey === "exchange") sales++;
        const incomeKind = INCOME_KINDS[typeKey];
        if (incomeKind) {
          // The fund name wraps onto the next line ("VANGUARD FEDERAL MONEY" / "MARKET FUND").
          const security = collapseSpaces([t.description, ...t.detail].join(" "));
          const moneyMarket = MONEY_MARKET.test(security);
          incomeRows.push({
            date: resolveMonthDay(t.settle, periodStart, periodEnd),
            security,
            cusip: "",
            kind: incomeKind,
            amount: t.amount,
            moneyMarket,
            nonQualified: moneyMarket || BONDISH.test(security),
          });
        }
        return;
      }
      if (!FLOW_TYPES.has(typeKey)) throw new Error(`Vanguard: unfamiliar transaction type "${t.type}" (${t.description}, ${t.amount / 100})`);
      const date = resolveMonthDay(t.settle, periodStart, periodEnd);
      transactions.push({
        date,
        datePrecision: "EXACT",
        description: collapseSpaces(t.description),
        amountCents: t.amount,
        section: t.type,
        detail: collapseSpaces(t.detail.join(" ")) || undefined,
      });
    };
    for (const raw of b.lines) {
      if (/^Completed transactions$/.test(raw) || /^Completed transactions continued$/.test(raw)) {
        inActivity = true;
        continue;
      }
      if (!inActivity) continue;
      if (/^(If you had an adjustment|Disclosures$|Account activity |Account overview )/.test(raw) || /^-- \d+ of \d+ --$/.test(raw)) {
        flush();
        if (/^(If you had an adjustment|Disclosures$)/.test(raw)) inActivity = false;
        continue;
      }
      const start = /^(\d{2}\/\d{2})\s+\d{2}\/\d{2}\s+(.*)$/.exec(raw);
      if (start) {
        flush();
        const fields = rawFields(text, raw);
        let description: string;
        let type: string;
        let amount: number | null;
        if (fields && fields.length >= 10) {
          description = fields[3]!;
          type = fields[4]!;
          amount = parseMoney(fields.at(-1)!);
        } else {
          const rest = start[2]!;
          const am = /(-?\$?[\d,]+\.\d{2})$/.exec(rest);
          amount = am ? parseMoney(am[1]!) : null;
          const lower = rest.toLowerCase();
          const known = KNOWN_TYPES.find((k) => lower.includes(` ${k} `));
          if (!known) throw new Error(`Vanguard: cannot read transaction row "${raw}"`);
          const at = lower.indexOf(` ${known} `);
          description = rest.slice(0, at).replace(/^\S+\s+/, "");
          type = rest.slice(at + 1, at + 1 + known.length);
        }
        if (amount == null) throw new Error(`Vanguard: cannot read amount on "${raw}"`);
        current = { settle: start[1]!, description, type: collapseSpaces(type), amount, detail: [] };
        continue;
      }
      // Continuation lines (fund name wraps, journal details) — skip repeated table headers.
      if (current && !/^(Settlement|date|Trade|Commissions|& fees|Page |Vanguard Personal Investor|August|[A-Z][a-z]+ \d{1,2}, \d{4},)/.test(raw) && !/^\d{8} \d+ STMT/.test(raw)) {
        current.detail.push(raw);
      }
    }
    flush();

    const flows = transactions.reduce((a, t) => a + t.amountCents, 0);
    const growth = row.closing - row.opening - flows - fees;

    // Income summary line for the month, e.g. "August $0.05 $0.00 ..." — dividends there
    // must match the dividend rows (the statement agreeing with itself).
    const checks: ParsedAccountSection["checks"] = [];
    if (totalValue != null) {
      checks.push({ label: "Account overview value = summary table closing value", expectedCents: row.closing, actualCents: totalValue });
    }
    const incomeLine = b.lines.find((l) => /^[A-Z][a-z]+ \$[\d,.]+\.\d{2}( \$?[\d,.]+\.\d{2}){5}$/.test(l));
    const periodMonthName = new Date(`${periodEnd}T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    if (incomeLine && incomeLine.startsWith(`${periodMonthName} `) && periodStart.slice(0, 7) === periodEnd.slice(0, 7)) {
      const dividends = parseMoney(incomeLine.split(" ")[1]!);
      if (dividends != null) checks.push({ label: "Dividend rows = income summary dividends", expectedCents: dividends, actualCents: dividendRows });
    }
    // Year-to-date Income summary: "Year-to-date 12.34 0.00 0.00 0.00 0.00 0.00", read
    // only under the column order it was written against.
    let income: BrokerageFacts["income"] = null;
    const summaryAt = b.lines.findIndex((l) => l === "Income summary");
    if (summaryAt >= 0) {
      const columns = b.lines[summaryAt + 1];
      const ytdLine = b.lines.slice(summaryAt + 1, summaryAt + 5).find((l) => /^Year-to-date( -?\$?[\d,]+\.\d{2}){6}$/.test(l));
      if (columns !== INCOME_HEADER) warnings.push(`${name} ••${number}: Income summary columns changed ("${columns}") — its tax figures were not read`);
      else if (!ytdLine) warnings.push(`${name} ••${number}: Income summary has no year-to-date row — its tax figures were not read`);
      else {
        const [dividends, interest, taxExempt, capGainDistShort, capGainDistLong, other] = ytdLine.split(" ").slice(1).map((v) => parseMoney(v)!);
        income = { dividends: dividends! + other!, interest: interest!, capGainDistShort: capGainDistShort!, capGainDistLong: capGainDistLong!, taxExempt: taxExempt!, taxDeferred: 0 };
        if (other) warnings.push(`${name} ••${number}: $${(other / 100).toFixed(2)} of year-to-date "Other income" is counted as ordinary dividends`);
      }
    }
    const taxKind = TAX_KIND[subtype] ?? "OTHER";
    if (sales && taxKind === "TAXABLE") warnings.push(`${name} ••${number}: securities were sold — Vanguard statements don't print realized gains, so they aren't counted until the 1099-B`);
    brokerageFacts.push({
      accountNumber: number,
      ownerLine,
      kind: taxKind,
      periodStart,
      periodEnd,
      isYearEnd: false,
      isChet: false,
      endingValue: row.closing,
      income,
      realized: null,
      incomeRows,
      distributions: [],
      contributionsYtd: null,
    });

    const funded = transactions.filter((t) => /funds received/i.test(t.section ?? "")).length > 0 && transactions.some((t) => /^contribution$/i.test(t.section ?? ""));
    if (funded) warnings.push(`${name} ••${number}: both "Funds Received" and "Contribution" rows — check they aren't the same money counted twice`);

    return {
      institution: "Vanguard",
      accountNumber: number,
      accountName: `Vanguard ${name}${owner ? ` — ${owner}` : ""}`,
      kind: "INVESTMENT",
      subtype,
      periodStart,
      periodEnd,
      openingBalanceCents: row.opening,
      closingBalanceCents: row.closing,
      growthCents: growth,
      feesCents: fees,
      transactions,
      checks,
      ...(quarterToDate ? { startsAfterPrior: true } : {}),
    };
  });

  return {
    parserId: VANGUARD_BROKERAGE_PARSER_ID,
    parserVersion: VERSION,
    institution: "Vanguard",
    kind: "STATEMENT",
    title: quarterToDate ? "Vanguard quarter-to-date statement" : "Vanguard monthly statement",
    periodStart,
    periodEnd,
    sections,
    brokerageFacts,
    holdings: extractVanguardBrokerageHoldings(text, periodEnd),
    warnings,
  };
}

/** The tab-separated cells of a row, from the untouched text (lines() flattens tabs). */
function rawFields(text: string, collapsedLine: string): string[] | null {
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.includes("\t")) continue;
    if (raw.replace(/\s+/g, " ").trim() === collapsedLine) return raw.split("\t").map((f) => f.trim());
  }
  return null;
}
