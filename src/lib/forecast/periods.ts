import type { AnnualProfileReport, YearProfile } from "../profile/buildAnnualProfile.ts";
import type { OutlookMonth } from "../profile/outlook.ts";
import type { Forecast } from "./forecast.ts";

/**
 * The forecast as columns of one ledger: proven years, the year in progress split into
 * actual-to-date + the forecast's rest of the year (and their total), then forecast years
 * or months. Every column has the same rows on the same definitions, so a total is always
 * the sum of its parts and each column's net worth change = saved + growth:
 *
 *   salary + bonus + other income − taxes & deductions + employer money
 *   − living − bonus spent − one-offs = saved;  saved + growth = change in net worth.
 *
 * Actual columns come from the annual profile (pay stubs, ledger rows, statements); growth
 * there is everything besides cash saved (markets, outside money, gaps). Forecast columns
 * come from the forecast's months; growth there is returns only. Money is cents; null =
 * not proven (a blocked section of an actual year).
 */

export type Flows = {
  salary: number | null;
  bonus: number | null;
  /** Interest, dividends and other income (actual only: the forecast counts them in growth). */
  otherIncome: number | null;
  /** Income tax, FICA and payroll deductions. Actual: withheld + paid − refunds + deductions. Forecast: owed on that pay. */
  taxes: number | null;
  employer: number | null;
  living: number | null;
  /** Forecast only: the part of bonuses kept after tax that's spent rather than saved. */
  bonusSpent: number | null;
  oneOffs: number | null;
  saved: number | null;
  /** The part of `saved` going to retirement accounts (your 401(k)/HSA deferrals + employer money). */
  toRetirement: number | null;
  growth: number | null;
  change: number | null;
  /** Net worth at the start of the period. */
  open: number | null;
  /** Balances at the end of the period. */
  close: { netWorth: number; liquid: number; illiquid: number } | null;
};

export type PeriodKind = "ACTUAL" | "FORECAST" | "TOTAL";

export type Period = {
  id: string;
  kind: PeriodKind;
  year: number;
  /** "2025", "Jan–Jun", "Aug ’27". */
  label: string;
  /** "actual", "forecast", "total" — or a short qualifier. */
  sub: string;
  /** First month (YYYY-MM) and through when it runs (YYYY-MM, or an ISO date for actual columns). */
  from: string;
  through: string;
  nearTerm: boolean;
  flows: Flows;
  /** Why an actual column's flows are missing, if they are. */
  note?: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mon = (m: number) => MONTHS[m - 1]!;
const span = (from: number, to: number) => (from === to ? mon(from) : `${mon(from)}–${mon(to)}`);
const sum = (xs: (number | null)[]) => (xs.some((x) => x == null) ? null : xs.reduce<number>((t, x) => t + x!, 0));

/** An actual year (or the year to date) from the annual profile; `open` is the net worth it starts from. */
export function actualFlows(y: YearProfile, open: number | null): Flows {
  const w = y.cash?.waterfall;
  const close = y.netWorth ? { netWorth: y.netWorth.netWorth, liquid: y.netWorth.liquid, illiquid: y.netWorth.illiquid } : null;
  const change = y.change && close && open != null ? close.netWorth - open : null;
  const deferrals = y.people ? y.people.reduce((t, p) => t + p.deferrals, 0) : null;
  return {
    salary: w?.salary ?? null,
    bonus: w?.bonus ?? null,
    otherIncome: w?.otherIncome ?? null,
    taxes: w ? w.withholding + w.additionalTaxes - w.refunds + w.otherDeductions : null,
    employer: w?.employer ?? null,
    living: w?.living ?? null,
    bonusSpent: w ? 0 : null,
    oneOffs: w?.nonRecurring ?? null,
    saved: w?.saved ?? null,
    toRetirement: w && deferrals != null ? deferrals + w.employer : null,
    growth: change != null && w ? change - w.saved : null,
    change,
    open: y.change ? open : null,
    close,
  };
}

/** Forecast months (consecutive), opening on the balances before the first. */
export function forecastFlows(months: OutlookMonth[], open: number): Flows {
  const t = (fn: (m: OutlookMonth) => number) => months.reduce((s, m) => s + fn(m), 0);
  const last = months.at(-1);
  const close = last ? { netWorth: last.netWorth, liquid: last.liquid, illiquid: last.illiquid } : null;
  return {
    salary: t((m) => m.salary),
    bonus: t((m) => m.bonusGross),
    otherIncome: 0,
    taxes: t((m) => m.salary - m.takeHome + m.bonusGross - m.bonusKept),
    employer: t((m) => m.employerMatch),
    living: t((m) => m.livingCost),
    bonusSpent: t((m) => m.bonusKept - m.bonusSaved),
    oneOffs: t((m) => m.planned),
    saved: t((m) => m.saved),
    toRetirement: t((m) => m.deferrals + m.employerMatch),
    growth: t((m) => m.growth),
    change: close ? close.netWorth - open : 0,
    open,
    close,
  };
}

/** Two consecutive periods as one: flows add, it opens on the first and closes on the second. */
export function addFlows(a: Flows, b: Flows): Flows {
  const k = (key: keyof Omit<Flows, "open" | "close">) => sum([a[key], b[key]]);
  return {
    salary: k("salary"),
    bonus: k("bonus"),
    otherIncome: k("otherIncome"),
    taxes: k("taxes"),
    employer: k("employer"),
    living: k("living"),
    bonusSpent: k("bonusSpent"),
    oneOffs: k("oneOffs"),
    saved: k("saved"),
    toRetirement: k("toRetirement"),
    growth: k("growth"),
    change: k("change"),
    open: a.open,
    close: b.close,
  };
}

const startNetWorth = (f: Forecast) => f.plan.start.liquid + f.plan.start.illiquid;

/** Net worth on Dec 31 of `year` from the profile (null if not proven). */
const provenClose = (r: AnnualProfileReport, year: number) => r.years.find((y) => y.year === year && !y.isCurrent)?.netWorth?.netWorth ?? null;

/** The year in progress as actual-to-date + forecast rest, or null when the forecast starts on last Dec 31. */
function currentYearParts(f: Forecast, r: AnnualProfileReport): { ytd: Period; restMonths: OutlookMonth[] } | null {
  const y = r.ytd;
  const s = f.plan.start;
  if (!y || s.year !== r.currentYear) return null;
  const cashShort = y.asOf < y.netWorthAsOf;
  const flows = actualFlows(y, provenClose(r, s.year - 1));
  // The forecast starts from these balances exactly, so the actual column closes on them.
  flows.close = { netWorth: startNetWorth(f), liquid: s.liquid, illiquid: s.illiquid };
  if (flows.open != null) flows.change = flows.close.netWorth - flows.open;
  if (cashShort) {
    for (const key of ["salary", "bonus", "otherIncome", "taxes", "employer", "living", "bonusSpent", "oneOffs", "saved", "toRetirement", "growth"] as const) flows[key] = null;
  } else if (flows.change != null && flows.saved != null) flows.growth = flows.change - flows.saved;
  return {
    ytd: {
      id: `${s.year}-ytd`,
      kind: "ACTUAL",
      year: s.year,
      label: span(1, s.month),
      sub: "actual",
      from: `${s.year}-01`,
      through: y.netWorthAsOf,
      nearTerm: false,
      flows,
      note: cashShort ? `Cash flow is proven only through ${y.asOf}; net worth through ${y.netWorthAsOf}.` : undefined,
    },
    restMonths: f.months.filter((m) => m.year === s.year),
  };
}

function forecastPeriod(f: Forecast, id: string, label: string, sub: string, months: OutlookMonth[], open: number): Period {
  const last = months.at(-1)!;
  return { id, kind: "FORECAST", year: last.year, label, sub, from: months[0]!.key, through: last.key, nearTerm: last.nearTerm, flows: forecastFlows(months, open) };
}

/** Opening net worth for a run of forecast months: the balance at the end of the month before. */
function openBefore(f: Forecast, first: OutlookMonth): number {
  const i = f.months.indexOf(first);
  return i > 0 ? f.months[i - 1]!.netWorth : startNetWorth(f);
}

/**
 * Year columns: the last `actualYears` proven years, the year in progress (split when the
 * forecast starts mid-year), then forecast years through `throughYear`.
 */
export function yearPeriods(f: Forecast, r: AnnualProfileReport, opts: { actualYears: number; throughYear: number }): Period[] {
  const out: Period[] = [];
  const proven = r.years.filter((y) => !y.isCurrent && y.year < f.plan.start.year + (f.plan.start.month === 12 ? 1 : 0)).slice(-opts.actualYears);
  for (const y of proven) {
    out.push({ id: String(y.year), kind: "ACTUAL", year: y.year, label: String(y.year), sub: "actual", from: `${y.year}-01`, through: `${y.year}-12-31`, nearTerm: false, flows: actualFlows(y, provenClose(r, y.year - 1)) });
  }
  const cur = currentYearParts(f, r);
  if (cur) {
    out.push(cur.ytd);
    if (cur.restMonths.length) {
      const first = cur.restMonths[0]!;
      const rest = forecastPeriod(f, `${cur.ytd.year}-rest`, span(first.month, 12), "forecast", cur.restMonths, openBefore(f, first));
      out.push(rest, { ...rest, id: `${cur.ytd.year}-total`, kind: "TOTAL", from: cur.ytd.from, label: String(cur.ytd.year), sub: "total", flows: addFlows(cur.ytd.flows, rest.flows) });
    }
  }
  for (const year of [...new Set(f.months.map((m) => m.year))]) {
    if (year > opts.throughYear || (cur && year === cur.ytd.year)) continue;
    const ms = f.months.filter((m) => m.year === year);
    out.push(forecastPeriod(f, String(year), ms.length < 12 ? `${span(ms[0]!.month, 12)} ${year}` : String(year), "forecast", ms, openBefore(f, ms[0]!)));
  }
  return out;
}

/** One year's columns month by month: actual to date as one column (the year in progress), each forecast month, and the year's total. */
export function monthPeriods(f: Forecast, r: AnnualProfileReport, year: number): Period[] {
  const out: Period[] = [];
  const cur = year === f.plan.start.year ? currentYearParts(f, r) : null;
  if (cur) out.push(cur.ytd);
  const ms = f.months.filter((m) => m.year === year);
  for (const m of ms) out.push(forecastPeriod(f, m.key, mon(m.month), "forecast", [m], openBefore(f, m)));
  if (ms.length) {
    const all = forecastFlows(ms, openBefore(f, ms[0]!));
    const flows = cur ? addFlows(cur.ytd.flows, all) : all;
    out.push({ id: `${year}-total`, kind: "TOTAL", year, label: String(year), sub: "total", from: cur ? cur.ytd.from : ms[0]!.key, through: ms.at(-1)!.key, nearTerm: ms.at(-1)!.nearTerm, flows });
  }
  return out;
}
