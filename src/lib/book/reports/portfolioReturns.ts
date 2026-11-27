import { inclusiveDays, maxIso } from "../../dates/isoDate.ts";
import type { Book } from "../load.ts";
import { buildNetWorth, type NetWorthReport } from "./netWorth.ts";
import { quarterOf, sp500Quarters, type Sp500Quarter } from "./sp500Benchmark.ts";

/**
 * Investments › Returns: the whole portfolio (every investment account, as Net worth counts
 * it) quarter by quarter against the S&P 500 (sp500Benchmark.ts), back to the first quarter
 * on file.
 *
 * The portfolio's return is time-weighted and net of fees: each month's Modified Dietz over
 * every investment account (money put in or taken out is no return), chained over the
 * quarter, exactly as Net worth › How it was built shows it. A quarter whose figures depend
 * on missing or failing data has no return.
 *
 * The comparison runs over the latest unbroken stretch of quarters with both figures (from
 * inception when nothing breaks it): each return chained since its start, and the portfolio's
 * dollars against what the same money would have come to in the S&P 500. That second
 * portfolio starts with what the real one held and takes the same money in and out each month;
 * the S&P 500 grows it evenly through each quarter, from the middle of the month money
 * arrives (from the day an account's first statement on file begins, for the balance it
 * already held).
 */

export type ReturnsQuarter = {
  quarter: string;
  label: string;
  start: string;
  end: string;
  /** Set when the quarter is cut short at the proven-through date. */
  through: string | null;
  /** Time-weighted, net of fees; null when no investment account was measured, or the quarter is blocked. */
  portfolio: number | null;
  /** The quarter's figures depend on missing or failing data. */
  blocked: boolean;
  /** Its months' own returns, chained into the quarter's. */
  months: { label: string; start: string; ratio: number | null }[];
  sp500: (Sp500Quarter & { statements: Record<string, string | null> }) | null;
};

export type ReturnsPoint = {
  quarter: string;
  label: string;
  end: string;
  /** Since the window's start, chained. */
  portfolioCum: number;
  sp500Cum: number;
  /** Every investment account's balance at the quarter's end. */
  actualCents: number;
  /** The same money in the S&P 500 all along. */
  sp500Cents: number;
  /** On hand at the start plus every dollar in, net of every dollar out, through the quarter's end. */
  moneyInCents: number;
  /** The S&P 500 portfolio at the quarter's start, grown by the quarter's return (whole cents). */
  grownCents: number;
  /** The quarter's own money in and out (by month, or the day an account's first statement begins), what the S&P 500 grew each to by the quarter's end (whole cents), and the share of the quarter it was invested. */
  flows: { day: string; cents: number; grownCents: number; weight: number; firstOnFile: boolean }[];
};

export type PortfolioReturns = {
  quarters: ReturnsQuarter[];
  window: {
    from: string;
    to: string;
    fromQuarter: string;
    toQuarter: string;
    /** As the periods name them ("Q2 2025"). */
    fromLabel: string;
    toLabel: string;
    /** On hand when the window starts: the S&P 500 portfolio starts with the same. */
    openingCents: number;
    points: ReturnsPoint[];
    days: number;
    /** A year, once the window spans at least one. */
    annualized: { portfolio: number; sp500: number } | null;
  } | null;
};

const midMonth = (start: string) => `${start.slice(0, 8)}15`;

export function buildPortfolioReturns(book: Book, monthly?: NetWorthReport): PortfolioReturns {
  const qr = buildNetWorth(book, { granularity: "quarter" });
  const mr = monthly ?? buildNetWorth(book, { granularity: "month" });
  const investment = new Set(qr.accounts.filter((a) => a.isInvestment).map((a) => a.id));
  const firstDay = new Map(qr.accounts.map((a) => [a.id, a.firstDay]));
  const touches = (p: NetWorthReport["periods"][number]) => p.blockers.some((b) => !b.accountId || investment.has(b.accountId));
  const statementOf = (documentId: string, accountId: string | null) => book.statements.find((s) => s.documentId === documentId && (!accountId || s.accountId === accountId))?.id ?? book.statements.find((s) => s.documentId === documentId)?.id ?? null;
  const snapshotAccount = new Map(book.holdings.map((h) => [h.documentId, h.accountId]));

  const periods = qr.periods.filter((p) => p.byAccount.some((a) => investment.has(a.accountId)));
  const sp = sp500Quarters(book.holdings, book.brokerage, periods.filter((p) => !p.through).map((p) => quarterOf(p.start)));
  const quarters: ReturnsQuarter[] = periods.map((p) => {
    const quarter = quarterOf(p.start);
    const blocked = touches(p);
    const s = p.through ? null : (sp.get(quarter) ?? null);
    const docs = !s ? [] : s.source.kind === "printed" || s.source.kind === "backed-out" ? [s.source.documentId] : s.source.kind === "unit-value" ? [s.source.from.documentId, s.source.to.documentId] : s.source.steps.map((x) => x.documentId);
    return {
      quarter,
      label: p.label,
      start: p.start,
      end: p.end,
      through: p.through,
      portfolio: blocked ? null : p.household.portfolioReturn,
      blocked,
      months: mr.periods.filter((m) => m.start >= p.start && m.end <= p.end).map((m) => ({ label: m.label, start: m.start, ratio: m.household.portfolioReturn })),
      sp500: s && { ...s, statements: Object.fromEntries(docs.map((d) => [d, statementOf(d, snapshotAccount.get(d) ?? null)])) },
    };
  });

  // The latest unbroken stretch of whole quarters with both returns (a quarter still under way, without an S&P 500 figure yet, doesn't break it).
  const whole = quarters.filter((q, i) => !(i === quarters.length - 1 && q.through && !q.sp500));
  let i = whole.length;
  while (i > 0 && whole[i - 1]!.portfolio != null && whole[i - 1]!.sp500) i--;
  const run = whole.slice(i);
  if (!run.length) return { quarters, window: null };

  const qPeriods = new Map(qr.periods.map((p) => [p.start, p]));
  const opening = qPeriods.get(run[0]!.start)!.byAccount.reduce((s, a) => (investment.has(a.accountId) ? s + a.openingCents : s), 0);
  let pg = 1;
  let sg = 1;
  let hypo = opening;
  let moneyIn = opening;
  const points: ReturnsPoint[] = [];
  for (const q of run) {
    const b = q.sp500!.ratio;
    const days = inclusiveDays(q.start, q.end);
    // What the S&P 500 does to a dollar from `day` to the quarter's end, growing evenly through the quarter.
    const grow = (day: string) => (1 + b) ** (inclusiveDays(day, q.end) / days);
    const flows: ReturnsPoint["flows"] = [];
    for (const m of mr.periods.filter((x) => x.start >= q.start && x.end <= q.end)) {
      let moved = 0;
      let enteredAt: { cents: number; day: string }[] = [];
      for (const a of m.byAccount) {
        if (!investment.has(a.accountId)) continue;
        moved += a.contributionsCents;
        if (a.newlyTrackedCents) enteredAt = [...enteredAt, { cents: a.newlyTrackedCents, day: maxIso(m.start, firstDay.get(a.accountId) ?? m.start) }];
      }
      if (moved) flows.push({ day: midMonth(m.start), cents: moved, grownCents: Math.round(moved * grow(midMonth(m.start))), weight: inclusiveDays(midMonth(m.start), q.end) / days, firstOnFile: false });
      for (const e of enteredAt) flows.push({ day: e.day, cents: e.cents, grownCents: Math.round(e.cents * grow(e.day)), weight: inclusiveDays(e.day, q.end) / days, firstOnFile: true });
    }
    // Whole cents each quarter, so its proof re-adds: the start grown, plus each flow grown.
    const grownCents = Math.round(hypo * (1 + b));
    hypo = grownCents + flows.reduce((s, f) => s + f.grownCents, 0);
    moneyIn += flows.reduce((s, f) => s + f.cents, 0);
    pg *= 1 + q.portfolio!;
    sg *= 1 + b;
    const closing = qPeriods.get(q.start)!.byAccount.reduce((s, a) => (investment.has(a.accountId) ? s + a.closingCents : s), 0);
    points.push({ quarter: q.quarter, label: q.label, end: q.end, portfolioCum: pg - 1, sp500Cum: sg - 1, actualCents: closing, sp500Cents: hypo, moneyInCents: moneyIn, grownCents, flows });
  }
  const from = run[0]!.start;
  const to = run.at(-1)!.end;
  const days = inclusiveDays(from, to);
  return {
    quarters,
    window: {
      from,
      to,
      fromQuarter: run[0]!.quarter,
      toQuarter: run.at(-1)!.quarter,
      fromLabel: run[0]!.label,
      toLabel: run.at(-1)!.label,
      openingCents: opening,
      points,
      days,
      annualized: days >= 365 ? { portfolio: pg ** (365 / days) - 1, sp500: sg ** (365 / days) - 1 } : null,
    },
  };
}
