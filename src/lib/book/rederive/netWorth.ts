import { addDays, endOfPeriod, inclusiveDays, maxIso, minIso, periodsBetween, type Granularity } from "../../dates/isoDate.ts";
import { dietzParts, MIN_RETURN_CAPITAL_CENTS, valueAt } from "../../ledger/timeline.ts";
import { bookedCents } from "../booking.ts";
import type { DerivedFigure } from "../derived/types.ts";
import { household } from "../householdView.ts";
import type { Book, BookRow } from "../load.ts";
import { centsRoute, invariant, ratioRoute, rederiveList } from "../proof/independence.ts";
import type { Rederivation, RederivedRoute } from "../proof/types.ts";
import { cashFlowRows, dayOfFor } from "../reports/cashFlow.ts";
import type { NetWorthChangesReport } from "../reports/netWorthChanges.ts";

/** Net worth on a day from the ledger's balances, account by account (every account on file by then), as the household counts it. */
export function ledgerNetWorthAt(book: Book, iso: string): number {
  return household(book).ledger.accounts.reduce((s, a) => (a.timeline.firstDay && a.timeline.firstDay <= iso ? s + valueAt(a.timeline, iso).cents : s), 0);
}

const CONTRIBUTIONS = new Set(["CONTRIBUTION_EMPLOYEE", "CONTRIBUTION_PERSONAL", "CONTRIBUTION_EMPLOYER"]);

/**
 * A row's cents the household's ledger books inside [from, to]: only from its account's
 * first day there (a partner's account from the day it joined, cutting a statement total
 * spread across that day), and none on an account the ledger doesn't hold.
 */
function ledgerBooked(book: Book): (r: BookRow, from: string, to: string) => number {
  const first = new Map(household(book).ledger.accounts.map((a) => [a.id, a.timeline.firstDay]));
  return (r, from, to) => {
    const day = first.get(r.accountId);
    if (!day) return 0;
    const lo = maxIso(from, day);
    return lo > to ? 0 : bookedCents(r, lo, to);
  };
}

/** Whether a summary statement (which fills a gap in the ledger with flows no row carries) covers part of [from, to]. */
const summaryIn = (book: Book, from: string, to: string, accountIds?: ReadonlySet<string>) =>
  book.statements.some((s) => s.isSummary && s.periodStart <= to && s.periodEnd >= from && (!accountIds || accountIds.has(s.accountId)));

/**
 * Payroll retirement money re-added from the contribution rows, as the ledger books them
 * (on investment accounts only, when asked); null where a summary statement fills part of
 * the span, since its flows are on no row.
 */
export function contributionRows(book: Book, from: string, to: string, investmentOnly: boolean): number | null {
  const accounts = household(book).ledger.accounts.filter((a) => !investmentOnly || a.isInvestment);
  const ids = new Set(accounts.map((a) => a.id));
  if (summaryIn(book, from, to, ids)) return null;
  const booked = ledgerBooked(book);
  return household(book).rows.reduce((s, r) => (ids.has(r.accountId) && CONTRIBUTIONS.has(r.lane) ? s + booked(r, from, to) : s), 0);
}

/**
 * Net worth's derived figures worked out a second way (F5):
 *  - the portfolio return: each month's Modified Dietz worked out again from every
 *    investment account's timeline and chained here, not read off the report's periods or
 *    its run (only the run's first month is taken from the report);
 *  - each period's return in How it was built (the portfolio's and each account's, month,
 *    quarter or year; What changed shows the same figure): its months worked out the same
 *    way and chained, so a quarter's or year's can't drift from its months';
 *  - What changed: every step must close the waterfall against opening and closing
 *    balances summed here, account by account (valueAt), and the steps that are money
 *    (retirement from pay, timing) are re-added from the rows.
 */
export function rederiveNetWorth(book: Book, figures: readonly DerivedFigure[], portfolioFrom: string | null, changes: Pick<NetWorthChangesReport, "granularity" | "periods">[]): Record<string, Rederivation> {
  const ledger = household(book).ledger;
  const through = book.horizon.netWorth;
  // Each month's Modified Dietz parts, account by account, worked from the timelines once (keyed by the month's first day).
  const monthParts = new Map<string, Map<string, { gainCents: number; capitalCents: number }>>();
  const partsIn = (start: string) => {
    let m = monthParts.get(start);
    if (!m) {
      const end = minIso(endOfPeriod(start, "month"), through);
      m = new Map();
      for (const a of ledger.accounts) {
        if (!a.isInvestment || !a.timeline.firstDay || a.timeline.firstDay > end || (a.timeline.lastDay ?? end) < start) continue;
        m.set(a.id, dietzParts(a.timeline, start, end));
      }
      monthParts.set(start, m);
    }
    return m;
  };
  // A month's return: every investment account's parts added (or one account's), none under the minimum capital.
  const monthRatio = (start: string, accountId?: string) => {
    let gain = 0;
    let capital = 0;
    for (const [id, p] of partsIn(start))
      if (!accountId || id === accountId) {
        gain += p.gainCents;
        capital += p.capitalCents;
      }
    return capital < MIN_RETURN_CAPITAL_CENTS ? null : gain / capital;
  };
  const chained = (from: string, to = through, accountId?: string) => {
    let growth = 1;
    let days = 0;
    let months = 0;
    for (const { start, end: rawEnd } of periodsBetween(from, to, "month")) {
      const r = monthRatio(start, accountId);
      if (r == null) continue;
      growth *= 1 + r;
      days += inclusiveDays(start, minIso(rawEnd, through));
      months++;
    }
    return { total: months ? growth - 1 : null, annualized: days >= 365 ? growth ** (365 / days) - 1 : null, months, days };
  };
  const ROUTE = "each month re-worked from every investment account's timeline (Modified Dietz), chained";

  // What changed: each period's steps, and its balances summed here.
  const steps = new Map<string, { cents: number; all: number; start: string; end: string }>();
  for (const r of changes)
    for (const p of r.periods) {
      const all = p.steps.reduce((s, x) => s + x.cents, 0);
      for (const s of p.steps) steps.set(`${r.granularity}|${p.start}|${s.key}`, { cents: s.cents, all, start: p.start, end: p.end });
    }
  // Every account on file by `iso`; one that first appears later has no balance yet (its opening is "other money").
  const balance = (iso: string) => ledger.accounts.reduce((s, a) => (a.timeline.firstDay && a.timeline.firstDay <= iso ? s + valueAt(a.timeline, iso).cents : s), 0);
  const rows = household(book).rows;
  const cfRows = cashFlowRows(book);
  const dayOf = dayOfFor(book);
  const booked = ledgerBooked(book);

  return rederiveList(figures, (f) => {
    const v = f.value;
    switch (f.figure) {
      case "return-total":
      case "return-annualized": {
        const from = portfolioFrom;
        if (!from) return null;
        const c = chained(from);
        if (f.figure === "return-total") return [ratioRoute(ROUTE, v, c.total, `${c.months} months from ${from}`, 1e-9)];
        const total = f.lines[0]?.value;
        const out: RederivedRoute[] = [ratioRoute(ROUTE, v, c.annualized, `${c.months} months from ${from}, a year`, 1e-9)];
        if (total && "ratio" in total && "ratio" in v) out.push(invariant("annualized from the cumulative return", v, Math.abs((1 + total.ratio) ** (365 / c.days) - 1 - v.ratio) < 1e-9, "(1 + cumulative)^(365 ÷ days) − 1"));
        return out;
      }
      case "account-return":
      case "account-return-annualized":
        return { none: "One account's monthly returns chained over its unbroken proven stretch: each month's return is that account's cell of How it was built (month), re-derived there." };
      case "built": {
        // How it was built's returns (What changed's too): each month of the period re-worked here, chained.
        const [g, row, col] = (f.key ?? "").split("|");
        if (!g || !col || !row?.endsWith(":return")) return null;
        const start = row.slice(0, -":return".length);
        const end = minIso(endOfPeriod(start, g as Granularity), through);
        const c = chained(start, end, col === "household" ? undefined : col);
        const of = col === "household" ? "every investment account's timeline" : "the account's timeline";
        return [ratioRoute(`each month re-worked from ${of} (Modified Dietz), chained`, v, c.total, `${c.months} of ${periodsBetween(start, end, "month").length} months measured, chained`, 1e-9)];
      }
      case "change-typical":
        return { none: "The mean of the same figure over the whole proven periods before it: each of those is a figure of its own on this tab (its change, saving, markets, income, spending or category), re-derived by its own proof." };
      case "accounts-measured":
        return { none: "A count of the accounts whose statements give an unbroken stretch to measure: which stretch is unbroken is the integrity checks' call, not a sum." };
      case "change-step": {
        const k = f.key ?? "";
        const s = steps.get(k);
        if (!s) return null;
        const [g, , key] = k.split("|");
        const end = minIso(endOfPeriod(s.start, g as Granularity), through);
        const change = balance(end) - balance(addDays(s.start, -1));
        const out: RederivedRoute[] = [centsRoute("the waterfall closed on balances summed account by account", v, change - (s.all - s.cents), "closing less opening, less every other step", 2)];
        // Rows re-added, where no summary statement fills part of the period with flows no row carries.
        const months = periodsBetween(s.start, end, "month").length;
        const cents = key === "retirement" ? contributionRows(book, s.start, end, false) : null;
        if (cents != null) out.push(centsRoute("payroll contribution rows, re-added", v, cents, "deferrals and employer money booked in the period", 2 * months));
        if (key === "timing" && !summaryIn(book, s.start, end)) {
          // Net worth counts income and spending the day the money moves; cash flow counts rent in the month it pays for and nets paid-back pairs.
          const ledgerSide = rows.filter((r) => r.lane === "INCOME" || r.lane === "EXPENSE").reduce((t, r) => t + booked(r, s.start, end), 0);
          const cfSide = cfRows
            .filter((r) => r.lane === "INCOME" || r.lane === "EXPENSE")
            .reduce((t, r) => t + (r.precision === "EXACT" ? (dayOf(r) >= s.start && dayOf(r) <= end ? r.amountCents : 0) : bookedCents(r, s.start, end)), 0);
          out.push(centsRoute("rows as net worth books them less rows as cash flow counts them", v, ledgerSide - cfSide, "re-added both ways", 2 * months));
        }
        return out;
      }
      default:
        return null;
    }
  });
}
