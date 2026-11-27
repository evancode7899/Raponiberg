import type { Holding } from "../../ingest/holdings/types.ts";
import { securityKey } from "../../investments/securities.ts";
import type { IndexSeries } from "../../priceIndexMath.ts";
import type { IncomeRow } from "../../tax/facts/investments.ts";

/**
 * Investment returns' benchmark, from a broad index fund the household already holds (owner's
 * decision, 2026-11-26: no outside data). The fund's own statements give its price at each
 * statement's end, and the taxable account's statements its dividends; each step from one
 * statement to the next is a month of Modified Dietz on one share with no money in or out,
 * (price at the end + dividends a share) ÷ price at the start − 1, chained into a level like
 * a published total-return index's. Without the dividends on file (a retirement account's
 * statements print none) the series is the fund's price alone, and says so.
 */

/** What the benchmark needs of a holdings snapshot (BookHoldings). */
export type FundSnapshot = { documentId: string; accountId: string | null; institution: string; accountNumber: string; asOf: string; positions: readonly Holding[] };
/** What it needs of a brokerage statement's tax facts (BookBrokerage). */
export type FundIncome = { documentId: string; institution: string; accountNumber: string; periodStart: string; periodEnd: string; incomeRows: readonly IncomeRow[] };

/** A step of the fund's series: the statement it ends on, its price, and the dividends a share since the one before. */
export type FundStep = { month: string; asOf: string; documentId: string; price: number; prevPrice: number; quantity: number; dividendCents: number | null; level: number };

export type FundBenchmark = {
  /** The fund's security key (lib/investments/securities.ts), as the settings name it. */
  key: string;
  name: string;
  symbol: string | null;
  /** Its level at each month a statement prices it (YYYY-MM), from 100 at the first. */
  series: IndexSeries;
  steps: FundStep[];
};

/** Tickers of broad US (total-market or S&P 500) index funds and ETFs. */
const BROAD_TICKERS = new Set(["VTI", "VTSAX", "VTSMX", "VITSX", "VOO", "VFIAX", "VFINX", "IVV", "SPY", "SPLG", "ITOT", "SCHB", "SCHX", "SWTSX", "SWPPX", "FSKAX", "FXAIX", "FZROX", "FSTMX", "FUSEX", "IWV", "VV", "SCHK"]);
/** A broad US index fund by its name: total (stock) market, S&P 500, or the whole US market. */
const BROAD_NAME = /\bTOTAL (US |U\.S\. )?(STOCK )?MARKET\b|\bTOTAL STOCK\b|\bTOTAL MKT\b|\bS&P ?500\b|\b500 INDEX\b|\bUS TOTAL\b|\bBROAD MARKET\b|\bEXTENDED MARKET\b/i;
/** Not a broad US stock fund, whatever else its name says. */
const NARROW = /\bINT(?:ERNATIONA)?L\b|\bINTL\b|\bEX[- ]US\b|\bWORLD\b|\bGLOBAL\b|\bBOND\b|\bTREASURY\b|\bEMERGING\b|\bDEVELOPED\b|\bGROWTH\b|\bVALUE\b|\bDIVIDEND\b|\bSMALL\b|\bMID\b|\bTARGET\b|\b20\d0\b/i;

/** Whether a holding is a broad US index fund (by ticker or name), the kind the benchmark uses. */
export function isBroadUsIndex(h: Pick<Holding, "symbol" | "name" | "kind">): boolean {
  if (h.kind !== "FUND" && h.kind !== "ETF") return false;
  if (h.symbol && BROAD_TICKERS.has(h.symbol.toUpperCase())) return true;
  return BROAD_NAME.test(h.name) && !NARROW.test(h.name);
}

/** The broad index funds held, each with how many statement months price it: the most first. */
export function benchmarkCandidates(snapshots: readonly FundSnapshot[]): { key: string; name: string; symbol: string | null; months: number }[] {
  const by = new Map<string, { key: string; name: string; symbol: string | null; months: Set<string> }>();
  for (const s of snapshots)
    for (const p of s.positions) {
      if (!isBroadUsIndex(p) || !p.price || !p.quantity) continue;
      const key = securityKey(p);
      const x = by.get(key) ?? { key, name: p.name, symbol: p.symbol, months: new Set<string>() };
      x.months.add(s.asOf.slice(0, 7));
      by.set(key, x);
    }
  return [...by.values()].map((x) => ({ key: x.key, name: x.name, symbol: x.symbol, months: x.months.size })).sort((a, b) => b.months - a.months || a.key.localeCompare(b.key));
}

const sameFund = (row: Pick<IncomeRow, "security">, p: Pick<Holding, "symbol" | "name">) => {
  const s = row.security.toUpperCase().replace(/\s+/g, " ").trim();
  return s === p.name.toUpperCase().replace(/\s+/g, " ").trim() || (!!p.symbol && s.split(" ").includes(p.symbol.toUpperCase()));
};

/**
 * The benchmark fund's series: `pick` (a security key the owner chose) when it's held, else
 * the broad index fund the statements price in the most months. Read off one account's
 * statements (the one pricing it most often), so each step's dividends are that account's.
 */
export function fundBenchmark(snapshots: readonly FundSnapshot[], income: readonly FundIncome[], pick: string | null): FundBenchmark | null {
  const candidates = benchmarkCandidates(snapshots);
  const chosen = candidates.find((c) => c.key === pick) ?? candidates[0];
  if (!chosen) return null;
  // The account whose statements price it in the most months.
  const byAccount = new Map<string, FundSnapshot[]>();
  for (const s of snapshots) if (s.positions.some((p) => securityKey(p) === chosen.key && p.price && p.quantity)) byAccount.set(s.accountId ?? s.institution, [...(byAccount.get(s.accountId ?? s.institution) ?? []), s]);
  const run = [...byAccount.values()].sort((a, b) => b.length - a.length)[0]!.sort((a, b) => a.asOf.localeCompare(b.asOf));
  // One statement a month: the latest that month.
  const monthly = [...new Map(run.map((s) => [s.asOf.slice(0, 7), s])).values()];
  // The fund as the statement holds it: a statement can print one fund on several lines (Fidelity
  // splits a cash-account lot from a margin-account sliver), and the dividends are for every share.
  const at = (s: FundSnapshot) => {
    const lines = s.positions.filter((p) => securityKey(p) === chosen.key && p.price && p.quantity);
    return { ...lines[0]!, quantity: lines.reduce((n, p) => n + p.quantity!, 0) };
  };
  // Dividends the account's own statements print for the fund.
  const { institution, accountNumber } = monthly[0]!;
  const mine = income.filter((i) => i.institution === institution && i.accountNumber === accountNumber).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const rows = mine.flatMap((i) => i.incomeRows.filter((r) => r.kind === "DIVIDEND" && sameFund(r, at(monthly[0]!))).map((r) => ({ ...r, periodEnd: i.periodEnd })));
  // Whether the account's statements cover every day after `from` through `to`, so no dividend is missed.
  const covered = (from: string, to: string) => {
    let next = addDay(from);
    for (const i of mine) if (i.periodStart <= next && i.periodEnd >= next) next = addDay(i.periodEnd);
    return next > to;
  };
  const steps: FundStep[] = [];
  let level = 100;
  const months: Record<string, number> = { [monthly[0]!.asOf.slice(0, 7)]: level };
  let total = true;
  for (let i = 1; i < monthly.length; i++) {
    const a = at(monthly[i - 1]!);
    const b = at(monthly[i]!);
    const from = monthly[i - 1]!.asOf;
    const to = monthly[i]!.asOf;
    // Dividends paid after the step's start, through its end; none known when no tax facts cover it.
    const known = covered(from, to);
    const dividendCents = known ? rows.filter((r) => r.date > from && r.date <= to).reduce((s, r) => s + r.amount, 0) : null;
    if (!known) total = false;
    const perShare = dividendCents ? dividendCents / 100 / a.quantity! : 0;
    level *= (b.price! + perShare) / a.price!;
    months[to.slice(0, 7)] = level;
    steps.push({ month: to.slice(0, 7), asOf: to, documentId: monthly[i]!.documentId, price: b.price!, prevPrice: a.price!, quantity: a.quantity!, dividendCents, level });
  }
  const latest = monthly.at(-1)!.asOf;
  return {
    key: chosen.key,
    name: chosen.name,
    symbol: chosen.symbol,
    steps,
    series: {
      name: chosen.symbol ? `${chosen.name} (${chosen.symbol})` : chosen.name,
      source: total ? "your own statements: its price at each statement's end, and its dividends" : "your own statements: its price at each statement's end (no dividends on file for some months)",
      url: "",
      fetchedOn: latest,
      kind: total ? "total-return" : "price",
      months,
    },
  };
}

const addDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
