import { endOfPeriod, periodLabel, periodsBetween, startOfPeriod, type Granularity } from "../../dates/isoDate.ts";
import { decompose } from "../../ledger/timeline.ts";
import { blockersFor } from "../blockers.ts";
import { household } from "../householdView.ts";
import { bookedShare } from "../booking.ts";
import type { Book, BookRow } from "../load.ts";
import { withReimbursements } from "../reimbursements.ts";
import { countsOn } from "../rent.ts";
import { savedFromTakeHome, savingsRate } from "../definitions.ts";
import { taxAuthority } from "../../tax/facts/payments.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";

export type CategoryAmount = { category: string; group: string | null; cents: number };

export type CashFlowPeriod = {
  label: string;
  start: string;
  end: string;
  /** Set when the period is cut short at the proven-through date (figures run through it). */
  through: string | null;
  incomeCents: number;
  /** Positive number: spending net of merchant refunds and paybacks (tax refunds are income: asCashFlowRow). */
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
  /** Rows counted as the classifier filed them, though it asked for an answer (BookRow.needsReview): how many, and their size. */
  unreviewed: { rows: number; cents: number };
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

/** One row's part in one period's cash flow: `cents` is its signed amount times `share`, unrounded. */
export type CashFlowContribution = { row: BookRow; periodIndex: number; share: number; cents: number; countedOn: string };

/** Cash flow's income category for money a tax authority paid back. */
export const TAX_REFUND_CATEGORY = "Tax refunds";

/**
 * A row as cash flow counts it. A tax refund is filed as a credit to Taxes (the expense
 * lane), so taxes paid net to what the return came to; but money back from a tax authority
 * isn't less spending. Cash flow counts it as income, so spending stays gross of it and net
 * saved doesn't change.
 */
export function asCashFlowRow(r: BookRow): BookRow {
  if (r.lane !== "EXPENSE" || r.amountCents <= 0 || r.reimbursement || !taxAuthority(r.payee)) return r;
  return { ...r, lane: "INCOME", category: TAX_REFUND_CATEGORY, categoryGroup: "Income" };
}

/**
 * The rows cash flow and the spending views read: as the household view counts them
 * (householdView.ts: none on a partner's account before it joined, their pre-merge share as
 * spending credits), with each reimbursement link's pair (book/reimbursements.ts: the
 * payback moves from income into the charge's category), and tax refunds as income.
 */
export function cashFlowRows(book: Book): BookRow[] {
  return withReimbursements({ rows: household(book).rows, reimbursements: book.reimbursements }).map(asCashFlowRow);
}

/** The day each row counts on (rent.ts countsOn), worked out once per Book: rent detection reads every row. */
const days = new WeakMap<Book, (r: BookRow) => string>();
export function dayOfFor(book: Book): (r: BookRow) => string {
  let d = days.get(book);
  if (!d) days.set(book, (d = countsOn(book.rows, book.accounts, book.household.merchantRules)));
  return d;
}

/**
 * Which rows cash flow counts, in which period, and how much of each: the one selection
 * step behind the cash-flow report and the proof of any figure on it (book/proof), so the
 * two can't disagree. Income, spending and outside-money lanes only. Booked where net
 * worth books it: an exact row whole on its (clamped) date, a period total spread across
 * its statement's period (booking.ts). Rent: the month it covers (rent.ts). `countedOn`
 * is that day for an exact row, the statement's start for a spread one.
 */
export function cashFlowContributions(book: Book, periods: { start: string; end: string }[], accountFilter: Set<string> | null): CashFlowContribution[] {
  const idx = (iso: string) => periods.findIndex((p) => p.start <= iso && iso <= p.end);
  const dayOf = dayOfFor(book);
  const out: CashFlowContribution[] = [];
  for (const r of cashFlowRows(book)) {
    if (r.lane !== "INCOME" && r.lane !== "EXPENSE" && r.lane !== "EXTERNAL_TRANSFER") continue;
    if (accountFilter && !accountFilter.has(r.accountId)) continue;
    if (r.precision === "EXACT") {
      const countedOn = dayOf(r);
      const i = idx(countedOn);
      if (i >= 0) out.push({ row: r, periodIndex: i, share: 1, cents: r.amountCents, countedOn });
      continue;
    }
    periods.forEach((p, i) => {
      const share = bookedShare(r, p.start, p.end);
      if (share > 0) out.push({ row: r, periodIndex: i, share, cents: r.amountCents * share, countedOn: r.statement.start });
    });
  }
  return out;
}

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
  const ledger = household(book).ledger;
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
      unreviewed: { rows: 0, cents: 0 },
      blockers: refs(blockersFor(book, { affects: "CASH_FLOW", from: start, to: end, accountIds: opts.accountIds })),
    };
    return { p, income: new Map<string, CategoryAmount>(), spending: new Map<string, CategoryAmount>(), external: new Map<string, CategoryAmount>() };
  });
  for (const { row: r, periodIndex, cents } of cashFlowContributions(book, periods.map(({ p }) => p), accountFilter)) {
    const bucket = periods[periodIndex]!;
    if (r.needsReview) {
      bucket.p.unreviewed.rows++;
      bucket.p.unreviewed.cents += Math.abs(cents);
    }
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

  // Spread period totals leave fractions of a cent: rounded once, at the end.
  const sorted = (m: Map<string, CategoryAmount>) =>
    [...m.values()].map((c) => ({ ...c, cents: Math.round(c.cents) })).filter((c) => c.cents !== 0).sort((a, b) => b.cents - a.cents);
  for (const { p, income, spending, external } of periods) {
    p.incomeCents = Math.round(p.incomeCents);
    p.spendingCents = Math.round(p.spendingCents);
    p.netCents = savedFromTakeHome(p.incomeCents, p.spendingCents);
    p.unreviewed.cents = Math.round(p.unreviewed.cents);
    p.savingsRate = savingsRate(p.incomeCents, p.netCents);
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
