import type { Holding } from "../../ingest/holdings/types.ts";
import { isSp500Fund, isUnitTrust } from "../../investments/sp500.ts";
import { securityKey } from "../../investments/securities.ts";
import { benchmarkCandidates, fundBenchmark, type FundIncome, type FundSnapshot, type FundStep } from "./fundBenchmark.ts";

/**
 * The S&P 500's return each calendar quarter, chained from the household's own statements
 * (owner's choice, 2026-11-27: the S&P 500 back to the portfolio's inception, from the S&P 500
 * funds held over the years, account to account; no outside data). Each quarter takes the
 * best reading on file:
 *
 *  1. printed: the S&P 500 Index's own 3-month return, as a plan statement's performance
 *     table prints it at the quarter's end (Empower);
 *  2. unit-value: an S&P 500 collective trust's value per unit at both quarter ends in one
 *     account (a trust pays nothing out, so its unit value is its whole return);
 *  3. fund-months: an S&P 500 fund or ETF's monthly statements, price plus the dividends
 *     the account's statements print, chained over the quarter's three months
 *     (fundBenchmark.ts), every month's dividends on file;
 *  4. backed-out: a quarter no statement covers, from the S&P 500 Index's 1-year return a
 *     statement three quarters later prints, over the three quarters after it
 *     ((1 + 1-year) ÷ (1 + q₂)(1 + q₃)(1 + q₄) − 1), good to the printed figures' rounding;
 *  5. fund-months, price only: the fund's monthly prices when some month's dividends aren't
 *     on file (it runs a little low), only where nothing better covers the quarter.
 */

/** What the engine needs of a holdings snapshot (BookHoldings), positions with what plan statements print beside them. */
export type Sp500Snapshot = FundSnapshot & { positions: readonly Holding[] };

export type Sp500Source =
  | { kind: "printed"; fund: string; asOf: string; documentId: string }
  | { kind: "unit-value"; fund: string; from: UnitReading; to: UnitReading }
  | { kind: "fund-months"; fund: string; total: boolean; steps: FundStep[] }
  | { kind: "backed-out"; asOf: string; documentId: string; oneYear: number; after: { quarter: string; ratio: number }[] };

/** An S&P 500 trust's value and units at one statement's end. */
export type UnitReading = { asOf: string; documentId: string; valueCents: number; units: number };

export type Sp500Quarter = { quarter: string; start: string; end: string; ratio: number; source: Sp500Source };

const QUARTER_ENDS = new Set(["03-31", "06-30", "09-30", "12-31"]);
const isQuarterEnd = (iso: string) => QUARTER_ENDS.has(iso.slice(5));
/** "2024-06-30" → "2024-Q2". */
export const quarterOf = (iso: string) => `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
/** A quarter's first and last day. */
export function quarterSpan(q: string): { start: string; end: string } {
  const y = Number(q.slice(0, 4));
  const n = Number(q.slice(-1));
  const m = (n - 1) * 3 + 1;
  const last = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  return { start: `${y}-${String(m).padStart(2, "0")}-01`, end: `${y}-${String(m + 2).padStart(2, "0")}-${last}` };
}
/** The quarter `n` quarters from `q`. */
export function shiftQuarter(q: string, n: number): string {
  const i = Number(q.slice(0, 4)) * 4 + Number(q.slice(-1)) - 1 + n;
  return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;
}
const monthKey = (iso: string) => iso.slice(0, 7);
const prevMonth = (key: string) => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1;
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, "0")}`;
};

/** The S&P 500's return for each quarter in `quarters` that the statements cover, by quarter ("2024-Q2"). */
export function sp500Quarters(snapshots: readonly Sp500Snapshot[], income: readonly FundIncome[], quarters: readonly string[]): Map<string, Sp500Quarter> {
  const printed = new Map<string, { fund: string; asOf: string; documentId: string; threeMonth: number | null; oneYear: number | null }>();
  const units = new Map<string, Map<string, UnitReading & { fund: string }>>();
  for (const s of snapshots) {
    if (!isQuarterEnd(s.asOf)) continue;
    for (const p of s.positions) {
      if (!isSp500Fund(p)) continue;
      const q = quarterOf(s.asOf);
      if (p.printedIndex && !printed.has(q)) printed.set(q, { fund: p.name, asOf: s.asOf, documentId: s.documentId, threeMonth: p.printedIndex.threeMonth, oneYear: p.printedIndex.oneYear });
      if (isUnitTrust(p) && p.quantity && p.quantity > 0 && p.valueCents > 0) {
        // One account's run of the same trust: its readings by quarter.
        const key = `${s.accountId ?? s.institution}|${securityKey(p)}`;
        const m = units.get(key) ?? new Map();
        m.set(q, { fund: p.name, asOf: s.asOf, documentId: s.documentId, valueCents: p.valueCents, units: p.quantity });
        units.set(key, m);
      }
    }
  }
  // Every S&P 500 fund or ETF priced month by month, as fundBenchmark chains it.
  const funds = benchmarkCandidates(snapshots)
    .filter((c) => snapshots.some((s) => s.positions.some((p) => securityKey(p) === c.key && isSp500Fund(p))))
    .map((c) => fundBenchmark(snapshots, income, c.key))
    .filter((f) => f != null);
  const fundMonths = (q: string, total: boolean): Sp500Quarter | null => {
    const { start, end } = quarterSpan(q);
    const ms = [monthKey(start), prevMonth(monthKey(end)), monthKey(end)];
    for (const f of funds) {
      const from = f.series.months[prevMonth(ms[0]!)];
      const to = f.series.months[ms[2]!];
      if (!from || !to || !ms.every((m) => f.series.months[m])) continue;
      const steps = f.steps.filter((x) => ms.includes(x.month));
      if (steps.length !== 3) continue;
      const known = steps.every((x) => x.dividendCents != null);
      if (total && !known) continue;
      return { quarter: q, start, end, ratio: to / from - 1, source: { kind: "fund-months", fund: f.series.name, total: known, steps } };
    }
    return null;
  };

  const out = new Map<string, Sp500Quarter>();
  for (const q of quarters) {
    const { start, end } = quarterSpan(q);
    const p = printed.get(q);
    if (p?.threeMonth != null) {
      out.set(q, { quarter: q, start, end, ratio: p.threeMonth, source: { kind: "printed", fund: p.fund, asOf: p.asOf, documentId: p.documentId } });
      continue;
    }
    const trust = [...units.values()].find((m) => m.has(shiftQuarter(q, -1)) && m.has(q));
    if (trust) {
      const a = trust.get(shiftQuarter(q, -1))!;
      const b = trust.get(q)!;
      const { fund, ...from } = a;
      const { fund: _f, ...to } = b;
      out.set(q, { quarter: q, start, end, ratio: b.valueCents / b.units / (a.valueCents / a.units) - 1, source: { kind: "unit-value", fund, from, to } });
      continue;
    }
    const m = fundMonths(q, true);
    if (m) out.set(q, m);
  }
  // Backed out of a 1-year return, latest first, so one quarter backed out can back out the one before it.
  for (const q of [...quarters].sort().reverse()) {
    if (out.has(q)) continue;
    const later = printed.get(shiftQuarter(q, 3));
    const after = [1, 2, 3].map((n) => out.get(shiftQuarter(q, n)));
    if (later?.oneYear == null || after.some((x) => !x)) continue;
    const { start, end } = quarterSpan(q);
    const ratio = (1 + later.oneYear) / after.reduce((g, x) => g * (1 + x!.ratio), 1) - 1;
    out.set(q, { quarter: q, start, end, ratio, source: { kind: "backed-out", asOf: later.asOf, documentId: later.documentId, oneYear: later.oneYear, after: after.map((x) => ({ quarter: x!.quarter, ratio: x!.ratio })) } });
  }
  for (const q of quarters) {
    if (out.has(q)) continue;
    const m = fundMonths(q, false);
    if (m) out.set(q, m);
  }
  return out;
}
