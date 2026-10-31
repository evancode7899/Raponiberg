import { savingsRate } from "../definitions.ts";
import { cashFlowWindows, median, mergeCategories, mergeMerchants, sum } from "../reports/cashFlowWindows.ts";
import type { CategoryAmount } from "../reports/cashFlow.ts";
import type { MerchantMonth, SpendingMonth, SpendingReport } from "../reports/spending.ts";
import { c, ln, r, t, type DerivedFigure } from "./types.ts";

/** A run of months, as a derived figure's key: its first and last day. */
export const windowKey = (months: SpendingMonth[]) => (months.length ? `${months[0]!.start}/${months.at(-1)!.end}` : "");

export type Lane = "EXPENSE" | "INCOME" | "EXTERNAL";
const LANES: [Lane, (m: SpendingMonth) => CategoryAmount[]][] = [
  ["EXPENSE", (m) => m.spendingByCategory],
  ["INCOME", (m) => m.incomeByCategory],
  ["EXTERNAL", (m) => m.externalByCategory],
];
/** A category's value in one month, in its lane. */
export const laneCents = (m: SpendingMonth, lane: Lane, category: string) => (LANES.find(([l]) => l === lane)![1](m).find((x) => x.category === category)?.cents ?? 0);
export const categoryKey = (months: SpendingMonth[], lane: Lane, category: string) => `${windowKey(months)}|${lane}|${category}`;
export const merchantKeyOf = (months: SpendingMonth[], lane: "EXPENSE" | "INCOME", key: string) => `${windowKey(months)}|${lane}|${key}`;
const merchantsOf = (lane: "EXPENSE" | "INCOME") => (m: SpendingMonth): MerchantMonth[] => (lane === "EXPENSE" ? m.merchants : m.payers);

/**
 * The Cash flow page's derived figures over each run of months the tabs sum (cashFlowWindows):
 * the savings rate, payroll retirement money, the typical (median) month of income, the
 * merchant counts and averages, each category's typical month and share, each merchant's
 * charges, average and pattern; and once, Recurring's bills and habits and the budget's
 * figures on the saved targets.
 */
export function cashFlowDerived(rep: Pick<SpendingReport, "months" | "recurring"> & Partial<Pick<SpendingReport, "current">>, targets: Record<string, number> = {}): DerivedFigure[] {
  const out: DerivedFigure[] = [...paceDerived(rep)];
  for (const months of cashFlowWindows(rep)) {
    const key = windowKey(months);
    const span = months.length === 1 ? months[0]!.label : `${months[0]!.label} – ${months.at(-1)!.label}`;
    const add = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"], k = key) => out.push({ figure, key: k, describes: `${describes}, ${span}`, value, lines });
    const n = months.length;
    const income = sum(months, (m) => m.incomeCents);
    const spending = sum(months, (m) => m.spendingCents);
    const rate = savingsRate(income, income - spending);
    add("savings-rate", "Savings rate from take-home", rate == null ? null : r(rate), [ln("Income", c(income), undefined, { source: "proven" }), ln("Spending", c(spending), "−", { source: "proven" }), ln("Saved from take-home", c(income - spending), "="), ln("÷ income", c(income), "÷"), ln("Savings rate", rate == null ? t("—") : r(rate), "=")]);
    const employee = sum(months, (m) => m.retirementEmployeeCents);
    const employer = sum(months, (m) => m.retirementEmployerCents);
    add("retirement", "401(k) and HSA money via payroll", c(employee + employer), [ln("Your deferrals, from the stubs", c(employee), undefined, { source: "proven" }), ln("Employer money, from the stubs", c(employer), "+", { source: "proven" }), ln("Via payroll", c(employee + employer), "=")]);
    const typical = median(months.map((m) => m.incomeCents));
    add("typical-income", "Typical (median) month of income", c(typical), [ln("Months", t(String(n))), ln("The middle month's income", c(typical))]);
    add("above-typical", "Income above a typical month", c(Math.max(0, income - typical * n)), [ln("Income", c(income), undefined, { source: "proven" }), ln(`${n} typical months`, c(typical * n), "−"), ln("Difference", c(income - typical * n), "="), ln("Above typical (none below zero)", c(Math.max(0, income - typical * n)), undefined, { note: "A run below its typical months shows $0." })]);
    const all = mergeMerchants(months);
    const visits = sum(all, (m) => m.count);
    const top10 = sum(all.slice(0, 10), (m) => m.cents);
    add("merchants", "Merchants charged", t(all.length.toLocaleString("en-US")), [ln("Merchants with spending, net of refunds", t(String(all.length)))]);
    add("top10-share", "Top 10 merchants' share of spending", spending > 0 ? r(top10 / spending) : null, [ln("The ten largest merchants", c(top10)), ln("÷ spending", c(spending), "÷"), ln("Share", spending > 0 ? r(top10 / spending) : t("—"), "=")]);
    add("avg-charge", "Average charge", c(visits ? sum(all, (m) => m.cents) / visits : 0), [ln("Spending at merchants", c(sum(all, (m) => m.cents))), ln("÷ charges", t(String(visits)), "÷"), ln("Average charge", c(visits ? sum(all, (m) => m.cents) / visits : 0), "=")]);
    add("charges-per-month", "Charges a month", r(visits / Math.max(1, n)), [ln("Charges", t(String(visits))), ln("÷ months", t(String(n)), "÷"), ln("A month", r(visits / Math.max(1, n)), "=")]);
    // Budget › the latest month against the saved targets.
    const budgeted = sum(Object.values(targets), (v) => v);
    if (Object.keys(targets).length) {
      const last = months.at(-1)!;
      const latest = sum(Object.keys(targets), (cat) => laneCents(last, "EXPENSE", cat));
      add("budget-latest", `Spending in budgeted categories, ${last.label}`, c(latest), Object.keys(targets).map((cat, i) => ln(cat, c(laneCents(last, "EXPENSE", cat)), i ? "+" : undefined, { source: "proven" })).concat(ln("In budgeted categories", c(latest), "=")));
      add("budget-savings-rate", "Planned savings rate (typical income less the budget)", typical > 0 ? r((typical - budgeted) / typical) : null, [ln("Typical month of income", c(typical)), ln("Monthly budget", c(budgeted), "−", { source: "assumption" }), ln("Left of a typical month", c(typical - budgeted), "="), ln("÷ typical income", c(typical), "÷"), ln("Planned savings rate", typical > 0 ? r((typical - budgeted) / typical) : t("—"), "=")]);
    }
    // Drills: each category in its lane, each merchant and payer.
    const spent = spending;
    for (const [lane, pick] of LANES)
      for (const cat of mergeCategories(months, pick)) {
        const values = months.map((m) => laneCents(m, lane, cat.category));
        const k = categoryKey(months, lane, cat.category);
        add("category-typical", `${cat.category}: typical (median) month`, c(median(values)), [ln("The middle month", c(median(values)))], k);
        if (lane === "EXPENSE") add("category-share", `${cat.category}: share of spending`, spent > 0 ? r(cat.cents / spent) : null, [ln(cat.category, c(cat.cents), undefined, { source: "proven" }), ln("÷ spending", c(spent), "÷"), ln("Share", spent > 0 ? r(cat.cents / spent) : t("—"), "=")], k);
        else add("category-months", `${cat.category}: months with any`, t(String(values.filter(Boolean).length)), [ln("Months", t(`${values.filter(Boolean).length} of ${values.length}`))], k);
      }
    for (const lane of ["EXPENSE", "INCOME"] as const)
      for (const x of mergeMerchants(months, merchantsOf(lane))) {
        const k = merchantKeyOf(months, lane, x.key);
        const rec = rep.recurring.find((q) => q.key === x.key);
        add("merchant-count", `${x.name}: ${lane === "EXPENSE" ? "charges" : "deposits"}`, t(String(x.count)), [ln(lane === "EXPENSE" ? "Charges" : "Deposits", t(String(x.count)), undefined, { source: "proven" })], k);
        add("merchant-avg", `${x.name}: average per charge`, c(x.count ? x.cents / x.count : 0), [ln("Total", c(x.cents), undefined, { source: "proven" }), ln("÷ charges", t(String(x.count)), "÷"), ln("Average", c(x.count ? x.cents / x.count : 0), "=")], k);
        add("merchant-pattern", `${x.name}: pattern`, t(rec ? (rec.kind === "bill" ? "Bill" : "Habit") : "Irregular"), [ln("Recurring detection", t(rec ? `${rec.kind}, ${rec.active ? "active" : "stopped"}` : "not recurring"))], k);
      }
  }
  // Recurring.
  const bills = rep.recurring.filter((x) => x.kind === "bill");
  const active = bills.filter((x) => x.active);
  const stopped = bills.filter((x) => !x.active);
  const raised = active.filter((x) => (x.changeCents ?? 0) > 0);
  const habits = rep.recurring.filter((x) => x.kind === "habit" && x.active);
  const list = (xs: typeof bills, f: (x: (typeof bills)[number]) => number) => xs.map((x) => ({ label: x.name, value: c(f(x)) }));
  out.push(
    { figure: "bills-monthly", describes: "Active bills and subscriptions, a month", value: c(sum(active, (x) => x.annualCents) / 12), lines: [ln("A year, every active bill", c(sum(active, (x) => x.annualCents))), ln("÷ 12", t("12"), "÷"), ln("A month", c(sum(active, (x) => x.annualCents) / 12), "=")], parts: list(active, (x) => x.annualCents) },
    { figure: "price-changes", describes: "Active bills whose latest charge went up", value: t(String(raised.length)), lines: [ln("Bills charged more than before", t(String(raised.length)))], parts: list(raised, (x) => x.changeCents!) },
    { figure: "habits-monthly", describes: "Habits, a month (the last twelve months ÷ 12)", value: c(sum(habits, (x) => x.last12Cents) / 12), lines: [ln("Last twelve months, every active habit", c(sum(habits, (x) => x.last12Cents))), ln("÷ 12", t("12"), "÷"), ln("A month", c(sum(habits, (x) => x.last12Cents) / 12), "=")], parts: list(habits, (x) => x.last12Cents) },
    { figure: "stopped", describes: "Bills no longer charged", value: t(String(stopped.length)), lines: [ln("Bills stopped", t(String(stopped.length)))], parts: list(stopped, (x) => x.annualCents) },
  );
  const budgeted = sum(Object.values(targets), (v) => v);
  out.push({
    figure: "budget-monthly",
    describes: "Monthly budget: the saved targets",
    value: Object.keys(targets).length ? c(budgeted) : null,
    lines: [...Object.entries(targets).map(([cat, v], i) => ln(cat, c(v), i ? "+" : undefined, { source: "assumption" })), ln("Monthly budget", c(budgeted), "=")],
  });
  return out;
}

// ------------------------------------------------------------------ Patterns › pace

export type PaceBasis = "all" | "everyday";
const cumulative = (xs: number[]) => {
  let run = 0;
  return xs.map((v) => (run += v));
};
const paceDays = (m: SpendingMonth, basis: PaceBasis) => (basis === "all" ? m.daily.allCents : m.daily.everydayCents);
const basisWords = (basis: PaceBasis) => (basis === "all" ? "all spending" : "everyday spending (no bills, nothing over $1,500)");
/** A pace figure's key: the month, which spending, and (a running total) through which day. */
export const paceKey = (m: Pick<SpendingMonth, "start">, basis: PaceBasis, day?: number) => `${m.start}|${basis}${day != null ? `|${day}` : ""}`;

/** One month's running total through `day` (the last day on file when the month is shorter), summed from its daily series. */
export function runningTotal(m: SpendingMonth, basis: PaceBasis, day: number): number {
  const cum = cumulative(paceDays(m, basis));
  return cum[Math.min(day, cum.length) - 1] ?? 0;
}

/** A typical month before month index `i`: the median, across the twelve months before, of each one's whole-month running total. */
export function typicalMonth(months: SpendingMonth[], i: number, basis: PaceBasis): { cents: number | null; from: SpendingMonth[] } {
  const from = months.slice(Math.max(0, i - 12), i);
  const ends = from.map((m) => {
    const c = cumulative(paceDays(m, basis));
    return c[Math.min(30, c.length - 1)]!;
  });
  return { cents: ends.length ? median(ends) : null, from };
}

/**
 * Patterns › pace: for each month the range can end on (and the month under way), each
 * running total the tab states (through the day on file, and the month before by the same
 * day) and the typical month, for all spending and for everyday spending.
 */
function paceDerived(rep: Pick<SpendingReport, "months"> & Partial<Pick<SpendingReport, "current">>): DerivedFigure[] {
  const out = new Map<string, DerivedFigure>();
  const ends: { m: SpendingMonth; i: number; partial: boolean }[] = rep.months.map((m, i) => ({ m, i, partial: false }));
  if (rep.current) ends.push({ m: rep.current, i: rep.months.length, partial: true });
  const spent = (m: SpendingMonth, basis: PaceBasis, day: number) => {
    const key = paceKey(m, basis, day);
    if (out.has(`pace-spent ${key}`)) return;
    const days = paceDays(m, basis);
    const through = Math.min(day, days.length);
    const total = runningTotal(m, basis, day);
    out.set(`pace-spent ${key}`, {
      figure: "pace-spent",
      key,
      describes: `${m.label}: ${basisWords(basis)} through day ${through}`,
      value: c(total),
      lines: [...days.slice(0, through).flatMap((x, d) => (x ? [{ d, x }] : [])).map(({ d, x }, k) => ln(`Day ${d + 1}`, c(x), k ? "+" : undefined, { source: "proven" })), ln(`Through day ${through}`, c(total), "=")],
    });
  };
  for (const { m, i, partial } of ends)
    for (const basis of ["all", "everyday"] as const) {
      const len = paceDays(m, basis).length;
      const day = partial && m.through ? Number(m.through.slice(8, 10)) : len;
      spent(m, basis, day);
      const prev = rep.months[i - 1];
      if (prev) spent(prev, basis, partial ? day : paceDays(prev, basis).length);
      const typ = typicalMonth(rep.months, i, basis);
      if (typ.cents == null) continue;
      out.set(`pace-typical ${paceKey(m, basis)}`, {
        figure: "pace-typical",
        key: paceKey(m, basis),
        describes: `A typical month before ${m.label}: ${basisWords(basis)}`,
        value: c(typ.cents),
        lines: [ln(`Median of the ${typ.from.length} months before`, c(typ.cents), undefined, { note: "Each month's running total through its last day." })],
        parts: typ.from.map((x) => ({ label: x.label, value: c(runningTotal(x, basis, 31)) })),
      });
    }
  return [...out.values()];
}
