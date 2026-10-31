import { addDays, endOfPeriod, inclusiveDays, minIso, periodsBetween, type Granularity } from "../../dates/isoDate.ts";
import { dietzParts, MIN_RETURN_CAPITAL_CENTS, valueAt } from "../../ledger/timeline.ts";
import { bookedCents } from "../booking.ts";
import type { DerivedFigure } from "../derived/types.ts";
import { household } from "../householdView.ts";
import type { Book } from "../load.ts";
import { centsRoute, invariant, ratioRoute, rederiveList } from "../proof/independence.ts";
import type { Rederivation, RederivedRoute } from "../proof/types.ts";
import { cashFlowRows, dayOfFor } from "../reports/cashFlow.ts";
import type { NetWorthChangesReport } from "../reports/netWorthChanges.ts";

/** Net worth on a day from the ledger's balances, account by account (every account on file by then), as the household counts it. */
export function ledgerNetWorthAt(book: Book, iso: string): number {
  return household(book).ledger.accounts.reduce((s, a) => (a.timeline.firstDay && a.timeline.firstDay <= iso ? s + valueAt(a.timeline, iso).cents : s), 0);
}

/**
 * Net worth's derived figures worked out a second way (F5):
 *  - the portfolio return: each month's Modified Dietz worked out again from every
 *    investment account's timeline and chained here, not read off the report's periods or
 *    its run (only the run's first month is taken from the report);
 *  - What changed: every step must close the waterfall against opening and closing
 *    balances summed here, account by account (valueAt), and the steps that are money
 *    (retirement from pay, timing) are re-added from the rows.
 */
export function rederiveNetWorth(book: Book, figures: readonly DerivedFigure[], portfolioFrom: string | null, changes: Pick<NetWorthChangesReport, "granularity" | "periods">[]): Record<string, Rederivation> {
  const ledger = household(book).ledger;
  const through = book.horizon.netWorth;
  const chained = (from: string) => {
    let growth = 1;
    let days = 0;
    let months = 0;
    for (const { start, end: rawEnd } of periodsBetween(from, through, "month")) {
      const end = minIso(rawEnd, through);
      let gain = 0;
      let capital = 0;
      for (const a of ledger.accounts) {
        if (!a.isInvestment || !a.timeline.firstDay || a.timeline.firstDay > end || (a.timeline.lastDay ?? end) < start) continue;
        const p = dietzParts(a.timeline, start, end);
        gain += p.gainCents;
        capital += p.capitalCents;
      }
      if (capital < MIN_RETURN_CAPITAL_CENTS) continue;
      growth *= 1 + gain / capital;
      days += inclusiveDays(start, end);
      months++;
    }
    return { total: growth - 1, annualized: days >= 365 ? growth ** (365 / days) - 1 : null, months, days };
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
  const RETIREMENT = new Set(["CONTRIBUTION_EMPLOYEE", "CONTRIBUTION_PERSONAL", "CONTRIBUTION_EMPLOYER"]);

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
        if (key === "retirement") {
          const cents = rows.filter((r) => RETIREMENT.has(r.lane)).reduce((t, r) => t + bookedCents(r, s.start, end), 0);
          out.push(centsRoute("payroll contribution rows, re-added", v, cents, "deferrals and employer money booked in the period", 2));
        }
        if (key === "timing") {
          // Net worth counts income and spending the day the money moves; cash flow counts rent in the month it pays for and nets paid-back pairs.
          const ledgerSide = rows.filter((r) => r.lane === "INCOME" || r.lane === "EXPENSE").reduce((t, r) => t + bookedCents(r, s.start, end), 0);
          const cfSide = cfRows
            .filter((r) => r.lane === "INCOME" || r.lane === "EXPENSE")
            .reduce((t, r) => t + (r.precision === "EXACT" ? (dayOf(r) >= s.start && dayOf(r) <= end ? r.amountCents : 0) : bookedCents(r, s.start, end)), 0);
          out.push(centsRoute("rows as net worth books them less rows as cash flow counts them", v, ledgerSide - cfSide, "re-added both ways", 2));
        }
        return out;
      }
      default:
        return null;
    }
  });
}
