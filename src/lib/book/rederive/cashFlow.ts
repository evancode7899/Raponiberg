import { addDays, endOfMonth, startOfMonth } from "../../dates/isoDate.ts";
import type { FinancialProfileSettings } from "../../profile/settings.ts";
import { bookedCents } from "../booking.ts";
import { savingsRate } from "../definitions.ts";
import type { DerivedFigure } from "../derived/types.ts";
import { household } from "../householdView.ts";
import type { Book, BookRow } from "../load.ts";
import { centsRoute, ratioRoute, rederiveList, textRoute } from "../proof/independence.ts";
import type { ProofValue, Rederivation, RederivedRoute } from "../proof/types.ts";
import { cashFlowRows, dayOfFor } from "../reports/cashFlow.ts";
import { median } from "../reports/cashFlowWindows.ts";
import { detectRecurring, merchantKeyOf, reversals, spendingKindRule, type Cadence, type SpendingReport } from "../reports/spending.ts";

/**
 * Cash flow's derived figures re-added from the Book's rows (F5): each month's income,
 * spending, categories, merchants, payroll retirement money and daily spending summed here
 * from the rows cash flow counts (cashFlowRows, on the day each counts: dayOfFor), not read
 * off the cash-flow engine's periods or the spending report's months. What the two share is
 * the definitions only: which rows count and on which day, how a statement-period total is
 * spread (bookedCents), which charges reverse each other, and which band a charge is in.
 */

type Agg = { cents: number; count: number };
type Month = {
  start: string;
  end: string;
  income: number;
  spending: number;
  /** By lane ("EXPENSE" | "INCOME" | "EXTERNAL"), category → cents, rounded and zeros dropped as the month shows them. */
  lanes: Record<string, Map<string, number>>;
  merchants: Record<"EXPENSE" | "INCOME", Map<string, Agg>>;
  retirement: number;
  daily: { all: number[]; everyday: number[] };
};

const LANE_OF: Record<string, string> = { INCOME: "INCOME", EXPENSE: "EXPENSE", EXTERNAL_TRANSFER: "EXTERNAL" };

/** The calendar months of a window "start/end". */
function monthStarts(start: string, end: string): string[] {
  const out: string[] = [];
  for (let m = startOfMonth(start); m <= end; m = addDays(endOfMonth(m), 1)) out.push(m);
  return out;
}

export function rederiveCashFlow(book: Book, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, rep: Pick<SpendingReport, "months" | "current">, figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const first = rep.months[0];
  const lastEnd = (rep.current ?? rep.months.at(-1))?.end;
  if (!first || !lastEnd) return {};
  const windowEnd = rep.months.at(-1)!.end;
  const dayOf = dayOfFor(book);
  const all = cashFlowRows(book);
  // The spending views' rows: counted from the first month through the month under way, less charges reversed in full.
  const inRange = all.filter((r) => dayOf(r) >= first.start && dayOf(r) <= lastEnd);
  const reversed = reversals(inRange);
  const inScope = inRange.filter((r) => !reversed.has(r.id));
  const windowRows = inScope.filter((r) => dayOf(r) <= windowEnd);
  const last12From = monthStarts(first.start, windowEnd).slice(-12)[0]!;
  const kindOf = spendingKindRule(book, settings, detectRecurring(windowRows, windowEnd, last12From));
  const investment = new Set(household(book).ledger.accounts.filter((a) => a.isInvestment).map((a) => a.id));
  const payroll = household(book).rows.filter((r) => investment.has(r.accountId) && (r.lane === "CONTRIBUTION_EMPLOYEE" || r.lane === "CONTRIBUTION_PERSONAL" || r.lane === "CONTRIBUTION_EMPLOYER"));

  const memo = new Map<string, Month>();
  const month = (start: string): Month => {
    let m = memo.get(start);
    if (m) return m;
    const end = endOfMonth(start) < lastEnd ? endOfMonth(start) : lastEnd;
    const lanes: Record<string, Map<string, number>> = { INCOME: new Map(), EXPENSE: new Map(), EXTERNAL: new Map() };
    let income = 0;
    let spending = 0;
    for (const r of all) {
      const lane = LANE_OF[r.lane];
      if (!lane) continue;
      const cents = r.precision === "EXACT" ? (dayOf(r) >= start && dayOf(r) <= end ? r.amountCents : 0) : bookedCents(r, start, end);
      if (!cents) continue;
      const signed = lane === "EXPENSE" ? -cents : cents;
      if (lane === "INCOME") income += cents;
      if (lane === "EXPENSE") spending -= cents;
      lanes[lane]!.set(r.category, (lanes[lane]!.get(r.category) ?? 0) + signed);
    }
    for (const l of Object.values(lanes))
      for (const [k, v] of l) {
        if (Math.round(v) === 0) l.delete(k);
        else l.set(k, Math.round(v));
      }
    const merchants = { EXPENSE: new Map<string, Agg>(), INCOME: new Map<string, Agg>() };
    const days = Number(endOfMonth(start).slice(8, 10));
    const daily = { all: Array.from({ length: days }, () => 0), everyday: Array.from({ length: days }, () => 0) };
    for (const r of inScope) {
      const d = dayOf(r);
      if (d < start || d > end || (r.lane !== "EXPENSE" && r.lane !== "INCOME")) continue;
      const cents = r.lane === "EXPENSE" ? -r.amountCents : r.amountCents;
      const a = merchants[r.lane].get(merchantKeyOf(r)) ?? { cents: 0, count: 0 };
      a.cents += cents;
      a.count++;
      merchants[r.lane].set(merchantKeyOf(r), a);
      if (r.lane === "EXPENSE") {
        daily.all[Number(d.slice(8, 10)) - 1]! += cents;
        if (kindOf(r) === "everyday") daily.everyday[Number(d.slice(8, 10)) - 1]! += cents;
      }
    }
    for (const m of Object.values(merchants)) for (const [k, v] of m) if (v.cents === 0) m.delete(k);
    let retirement = 0;
    for (const r of payroll) retirement += bookedCents(r, start, end);
    m = { start, end, income: Math.round(income), spending: Math.round(spending), lanes, merchants, retirement, daily };
    memo.set(start, m);
    return m;
  };
  const windowOf = (key: string) => {
    const [s, e] = key.split("|")[0]!.split("/");
    return monthStarts(s!, e!).map(month);
  };
  // Each window's merchants merged once: every merchant figure in it reads the same list.
  const mergedMemo = new Map<string, [string, Agg][]>();
  const merged = (ms: Month[], lane: "EXPENSE" | "INCOME") => {
    const key = `${ms[0]?.start}/${ms.at(-1)?.end}|${lane}`;
    const hit = mergedMemo.get(key);
    if (hit) return hit;
    const out = new Map<string, Agg>();
    for (const m of ms)
      for (const [k, v] of m.merchants[lane]) {
        const a = out.get(k) ?? { cents: 0, count: 0 };
        a.cents += v.cents;
        a.count += v.count;
        out.set(k, a);
      }
    const list = [...out].filter(([, v]) => v.cents > 0).sort((a, b) => b[1].cents - a[1].cents);
    mergedMemo.set(key, list);
    return list;
  };
  const ROWS = "the Book's rows, re-added";
  const cum = (xs: number[], day: number) => xs.slice(0, Math.min(day, xs.length)).reduce((s, v) => s + v, 0);

  return rederiveList(figures, (f) => {
    const v = f.value;
    const k = f.key ?? "";
    switch (f.figure) {
      case "savings-rate": {
        const ms = windowOf(k);
        const inc = ms.reduce((s, m) => s + m.income, 0);
        const sp = ms.reduce((s, m) => s + m.spending, 0);
        return [ratioRoute(ROWS, v, savingsRate(inc, inc - sp), `income ${inc / 100} less spending ${sp / 100}, over income`)];
      }
      case "retirement": {
        const ms = windowOf(k);
        // The engine reads each account's timeline: a cent a month either way is rounding.
        return [centsRoute("contribution rows on the investment accounts", v, ms.reduce((s, m) => s + m.retirement, 0), "employee, personal and employer contributions booked in the window", ms.length)];
      }
      case "typical-income":
        return [centsRoute(ROWS, v, median(windowOf(k).map((m) => m.income)), "the middle month's re-added income")];
      case "above-typical": {
        const ms = windowOf(k);
        const inc = ms.reduce((s, m) => s + m.income, 0);
        return [centsRoute(ROWS, v, Math.max(0, inc - median(ms.map((m) => m.income)) * ms.length), "income less that many typical months")];
      }
      case "merchants":
        return [textRoute(ROWS, v, merged(windowOf(k), "EXPENSE").length.toLocaleString("en-US"), "merchants with spending, net of refunds")];
      case "top10-share": {
        const ms = windowOf(k);
        const sp = ms.reduce((s, m) => s + m.spending, 0);
        return [ratioRoute(ROWS, v, sp > 0 ? merged(ms, "EXPENSE").slice(0, 10).reduce((s, [, a]) => s + a.cents, 0) / sp : null, "the ten largest merchants over spending")];
      }
      case "avg-charge": {
        const ms = merged(windowOf(k), "EXPENSE");
        const visits = ms.reduce((s, [, a]) => s + a.count, 0);
        return [centsRoute(ROWS, v, visits ? ms.reduce((s, [, a]) => s + a.cents, 0) / visits : 0, "spending at merchants over charges")];
      }
      case "charges-per-month": {
        const w = windowOf(k);
        return [ratioRoute(ROWS, v, merged(w, "EXPENSE").reduce((s, [, a]) => s + a.count, 0) / Math.max(1, w.length), "charges over months")];
      }
      case "budget-latest": {
        const last = windowOf(k).at(-1)!;
        const cats = f.lines.filter((l) => l.op !== "=").map((l) => l.label);
        return [centsRoute(ROWS, v, cats.reduce((s, c) => s + (last.lanes.EXPENSE!.get(c) ?? 0), 0), `the budgeted categories in ${last.start.slice(0, 7)}`)];
      }
      case "budget-savings-rate": {
        const typical = median(windowOf(k).map((m) => m.income));
        const budget = f.lines.find((l) => l.label === "Monthly budget")?.value;
        if (!budget || !("cents" in budget)) return null;
        return [ratioRoute(ROWS, v, typical > 0 ? (typical - budget.cents) / typical : null, "re-added typical income less the saved budget")];
      }
      case "category-typical":
      case "category-share":
      case "category-months": {
        const [, lane, ...rest] = k.split("|");
        const cat = rest.join("|");
        const ms = windowOf(k);
        const values = ms.map((m) => m.lanes[lane!]!.get(cat) ?? 0);
        if (f.figure === "category-typical") return [centsRoute(ROWS, v, median(values), `${cat}'s middle month`)];
        if (f.figure === "category-months") return [textRoute(ROWS, v, String(values.filter(Boolean).length), `months with any ${cat}`)];
        const sp = ms.reduce((s, m) => s + m.spending, 0);
        return [ratioRoute(ROWS, v, sp > 0 ? values.reduce((s, x) => s + x, 0) / sp : null, `${cat} over spending`)];
      }
      case "merchant-count":
      case "merchant-avg": {
        const [, lane, ...rest] = k.split("|");
        const key = rest.join("|");
        const a = merged(windowOf(k), lane as "EXPENSE" | "INCOME").find(([x]) => x === key)?.[1];
        if (!a) return [textRoute(ROWS, v, "none", "no rows at this merchant in the window")];
        return f.figure === "merchant-count" ? [textRoute(ROWS, v, String(a.count), "rows at the merchant")] : [centsRoute(ROWS, v, a.count ? a.cents / a.count : 0, "its total over its rows")];
      }
      case "merchant-pattern":
        return { none: "A classification by the recurring-charge detector (cadence and steadiness of the charges), not a sum: nothing to re-add." };
      case "pace-spent": {
        const [start, basis, day] = k.split("|");
        const m = month(start!);
        return [centsRoute(ROWS, v, cum(basis === "all" ? m.daily.all : m.daily.everyday, Number(day)), `expense rows counted on days 1–${day}`)];
      }
      case "pace-typical": {
        const [start, basis] = k.split("|");
        const idx = rep.months.findIndex((m) => m.start === start);
        const before = rep.months.slice(Math.max(0, (idx < 0 ? rep.months.length : idx) - 12), idx < 0 ? rep.months.length : idx).map((m) => month(m.start));
        return [centsRoute(ROWS, v, median(before.map((m) => cum(basis === "all" ? m.daily.all : m.daily.everyday, 31))), `the middle of the ${before.length} months before, each re-added in full`)];
      }
      case "bills-monthly":
      case "habits-monthly":
      case "price-changes":
      case "stopped":
        return recurringRoutes(f.figure, v, windowRows, windowEnd, last12From);
      case "budget-monthly":
        return { none: "The saved budget targets, as typed: an input, nothing to re-derive." };
      default:
        return null;
    }
  });
}

/**
 * Recurring's money re-worked from each merchant's own charges: a bill's typical charge (the
 * median) times its cadence's charges a year, a habit's last twelve months re-added. Which
 * merchants are bills or habits, still active or raised, is the detector's call (declared).
 */
function recurringRoutes(figure: string, v: ProofValue, rows: BookRow[], windowEnd: string, last12From: string): RederivedRoute[] | { none: string } {
  if (figure === "stopped" || figure === "price-changes")
    return { none: "A count of the recurring-charge detector's verdicts (which bills stopped, which went up): a classification, not a sum to re-add." };
  const recurring = detectRecurring(rows, windowEnd, last12From);
  const charges = (key: string) => rows.filter((r) => r.lane === "EXPENSE" && r.amountCents < 0 && merchantKeyOf(r) === key).map((r) => r);
  const ROUTE = "each merchant's charges, re-added";
  if (figure === "bills-monthly") {
    const yearly = recurring.filter((x) => x.kind === "bill" && x.active).reduce((s, b) => s + roundedMedian(charges(b.key).map((r) => -r.amountCents)) * PER_YEAR[b.cadence!], 0);
    return [centsRoute(ROUTE, v, yearly / 12, "each active bill's median charge × its charges a year, ÷ 12")];
  }
  const last12 = recurring.filter((x) => x.kind === "habit" && x.active).reduce((s, h) => s + charges(h.key).filter((r) => r.date >= last12From).reduce((t, r) => t - r.amountCents, 0), 0);
  return [centsRoute(ROUTE, v, last12 / 12, "each active habit's charges in the last twelve months, ÷ 12")];
}

const PER_YEAR: Record<Cadence, number> = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, annual: 1 };

/** A median in whole cents (the middle two averaged and rounded), as a bill's typical charge is. */
function roundedMedian(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}
