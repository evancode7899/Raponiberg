import { endOfPeriod, periodLabel, periodsBetween, startOfPeriod, type Granularity } from "../../dates/isoDate.ts";
import { decompose } from "../../ledger/timeline.ts";
import { blockersFor } from "../blockers.ts";
import { bookedShare } from "../booking.ts";
import type { Book } from "../load.ts";
import { countsOn } from "../rent.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";

export type CategoryAmount = { category: string; group: string | null; cents: number };

export type CashFlowPeriod = {
  label: string;
  start: string;
  end: string;
  /** Set when the period is cut short at the proven-through date (figures run through it). */
  through: string | null;
  incomeCents: number;
  /** Positive number: spending net of refunds/credits. */
  spendingCents: number;
  netCents: number;
  savingsRate: number | null;
  incomeByCategory: CategoryAmount[];
  spendingByCategory: CategoryAmount[];
  /** Partner money, untracked accounts, international transfers (signed). */
  externalByCategory: CategoryAmount[];
  /** Payroll deferrals and employer money that went straight to retirement accounts. */
  retirementEmployeeCents: number;
  retirementEmployerCents: number;
  /** Findings that make this period unprovable; when non-empty its figures must not be shown. */
  blockers: BlockerRef[];
};

export type CashFlowReport = {
  granularity: Granularity;
  from: string;
  to: string;
  /** Last day every open bank and card account has a statement for. */
  provenThrough: string;
  mergeDate: string;
  periods: CashFlowPeriod[];
};

/**
 * Income and spending by calendar period, from the Book's rows. Rows count where the
 * ledger books them (their date, clamped into their statement's period), so every period
 * agrees with net worth, except rent, which counts in the month it pays for (rent.ts);
 * internal transfers never appear; payments to untracked cards count as spending.
 * Periods run only through the proven-through date, and each one lists whatever makes it
 * unprovable (a missing statement, an unpaired transfer...).
 */
export function buildCashFlowReport(book: Book, opts: { granularity: Granularity; from?: string; to?: string; accountIds?: string[] }): CashFlowReport {
  const g = opts.granularity;
  const ledger = book.ledger;
  const provenThrough = book.horizon.cashFlow;
  // Nothing past the proven-through date: the period containing it ends there (partial).
  const from = startOfPeriod(opts.from ?? ledger.firstDay ?? provenThrough, g);
  const toWanted = opts.to ? endOfPeriod(opts.to, g) : provenThrough;
  const to = toWanted > provenThrough ? provenThrough : toWanted;
  const accountFilter = opts.accountIds?.length ? new Set(opts.accountIds) : null;

  const periods = (from <= to ? periodsBetween(from, to, g) : []).map(({ start, end: fullEnd }) => {
    const end = fullEnd > to ? to : fullEnd;
    const p: CashFlowPeriod = {
      label: periodLabel(start, g),
      start,
      end,
      through: end < fullEnd ? end : null,
      incomeCents: 0,
      spendingCents: 0,
      netCents: 0,
      savingsRate: null,
      incomeByCategory: [],
      spendingByCategory: [],
      externalByCategory: [],
      retirementEmployeeCents: 0,
      retirementEmployerCents: 0,
      blockers: refs(blockersFor(book, { affects: "CASH_FLOW", from: start, to: end, accountIds: opts.accountIds })),
    };
    return { p, income: new Map<string, CategoryAmount>(), spending: new Map<string, CategoryAmount>(), external: new Map<string, CategoryAmount>() };
  });
  const idx = (iso: string) => periods.findIndex(({ p }) => p.start <= iso && iso <= p.end);
  const dayOf = countsOn(book.rows, book.accounts, book.household.merchantRules);

  for (const r of book.rows) {
    if (r.lane !== "INCOME" && r.lane !== "EXPENSE" && r.lane !== "EXTERNAL_TRANSFER") continue;
    if (accountFilter && !accountFilter.has(r.accountId)) continue;
    // Booked where net worth books it: an exact row on its (clamped) date, a period total
    // spread across its statement's period (see booking.ts). Rent: the month it covers.
    const portions =
      r.precision === "EXACT"
        ? [{ i: idx(dayOf(r)), share: 1 }]
        : periods.map(({ p }, i) => ({ i, share: bookedShare(r, p.start, p.end) })).filter((x) => x.share > 0);
    for (const { i, share } of portions) {
      if (i < 0) continue;
      const bucket = periods[i]!;
      const cents = r.amountCents * share;
      const add = (m: Map<string, CategoryAmount>, v: number) => {
        const cur = m.get(r.category) ?? { category: r.category, group: r.categoryGroup, cents: 0 };
        cur.cents += v;
        m.set(r.category, cur);
      };
      if (r.lane === "INCOME") {
        bucket.p.incomeCents += cents;
        add(bucket.income, cents);
      } else if (r.lane === "EXPENSE") {
        bucket.p.spendingCents -= cents;
        add(bucket.spending, -cents);
      } else add(bucket.external, cents);
    }
  }

  // Spread period totals leave fractions of a cent: rounded once, at the end.
  const sorted = (m: Map<string, CategoryAmount>) =>
    [...m.values()].map((c) => ({ ...c, cents: Math.round(c.cents) })).filter((c) => c.cents !== 0).sort((a, b) => b.cents - a.cents);
  for (const { p, income, spending, external } of periods) {
    p.incomeCents = Math.round(p.incomeCents);
    p.spendingCents = Math.round(p.spendingCents);
    p.netCents = p.incomeCents - p.spendingCents;
    p.savingsRate = p.incomeCents > 0 ? p.netCents / p.incomeCents : null;
    p.incomeByCategory = sorted(income);
    p.spendingByCategory = sorted(spending);
    p.externalByCategory = sorted(external);
    for (const a of ledger.accounts.filter((x) => x.isInvestment && (!accountFilter || accountFilter.has(x.id)))) {
      if (a.timeline.firstDay! > p.end) continue;
      const d = decompose(a.timeline, p.start, p.end);
      p.retirementEmployeeCents += (d.flowsByLane.CONTRIBUTION_EMPLOYEE ?? 0) + (d.flowsByLane.CONTRIBUTION_PERSONAL ?? 0);
      p.retirementEmployerCents += d.flowsByLane.CONTRIBUTION_EMPLOYER ?? 0;
    }
  }

  return { granularity: g, from, to, provenThrough, mergeDate: ledger.mergeDate, periods: periods.map(({ p }) => p) };
}
