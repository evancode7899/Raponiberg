import { resolveBasePay, type OutlookSeeds, type ResolvedBasePay } from "../profile/basePay.ts";
import { projectOutlook, type OutlookMonth, type OutlookPlan, type OutlookYear } from "../profile/outlook.ts";
import type { OutlookAssumptions } from "../profile/settings.ts";
import { TAX_YEARS } from "../tax/params.ts";
import { bonusSchedule, monthKey, type BonusFacts, type ScheduledBonus } from "./bonusSchedule.ts";

/**
 * THE forecast: one month-by-month path of pay, bonuses, spending and net worth from the
 * latest proven balances, on the owner's saved assumptions. Every page that looks ahead
 * reads it — FIRE, Taxes (bonus still expected this year), Home budget (cash and salary at
 * a buy date), Goals (when each is reached) — so a date or balance means the same thing
 * everywhere. Pure, so the Forecast page can rerun it as assumptions are edited; the
 * server runs the same function on the saved assumptions (lib/forecast/load.ts).
 *
 * It always assumes you keep working: retiring early is a FIRE scenario on top of it.
 */

export type ForecastInputs = { seeds: OutlookSeeds; bonusFacts: BonusFacts };

export type Milestone = {
  cents: number;
  label: string;
  /** First month (YYYY-MM) whose closing net worth reaches it; null = not within 60 years. */
  key: string | null;
  age: number | null;
  /** Already reached at the start. */
  reached: boolean;
};

export type Forecast = {
  assumptions: OutlookAssumptions;
  pay: ResolvedBasePay;
  nearTermThrough: number;
  schedule: ScheduledBonus[];
  /** The plan the engine runs (keep working, to the horizon). */
  plan: OutlookPlan;
  months: OutlookMonth[];
  years: OutlookYear[];
  milestones: Milestone[];
  /** YYYY-MM of the starting balances. */
  startKey: string;
};

/** How far estimated bonuses and milestones are generated (the FIRE "when" questions look this far). */
export const SPAN_YEARS = 60;

const MILESTONES = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000].map((d) => d * 100);

export const nearTermEnd = (s: OutlookSeeds, a: OutlookAssumptions) => Math.max(a.nearTermThrough ?? s.currentYear + 1, s.start.year);

export function buildForecast(inputs: ForecastInputs, a: OutlookAssumptions): Forecast {
  const s = inputs.seeds;
  const pay = resolveBasePay(s, a, TAX_YEARS[s.taxYear]!);
  const nearTermThrough = nearTermEnd(s, a);
  const startKey = monthKey(s.start.year, s.start.month);
  const schedule = bonusSchedule({
    startKey,
    startYear: s.start.year,
    people: pay.people.map((p) => ({
      personId: p.personId,
      name: p.name,
      salary: p.salary,
      bonusPct: p.bonusPct,
      bonusMonth: p.bonusMonth,
      paidSinceStart: s.people.find((x) => x.personId === p.personId)?.bonusesSinceStart ?? [],
    })),
    facts: inputs.bonusFacts,
    salaryGrowth: a.salaryGrowth,
    estimates: a.bonus.estimates,
    nearTermThrough,
    throughYear: s.start.year + SPAN_YEARS + 1,
  });
  const payments = schedule.filter((b) => b.counted).map((b) => ({ key: b.key, gross: b.gross }));
  const plan: OutlookPlan = {
    start: { year: s.start.year, month: s.start.month, liquid: s.start.liquid, illiquid: s.start.illiquid },
    horizonYear: Math.max(a.horizonYear, s.start.year + 1),
    nearTermThrough,
    salary: pay.salary,
    takeHomeRate: pay.takeHomeRate,
    deferrals: pay.deferrals,
    employerMatch: pay.employer,
    livingCost: pay.living.cents,
    salaryGrowth: a.salaryGrowth,
    livingGrowth: a.livingGrowth,
    bonus: payments.length ? { payments, keepRate: pay.bonus.keepRate, savedShare: a.bonus.savedShare } : null,
    returnRate: a.returnRate,
    walkAwayYear: null,
    withdrawalRate: a.withdrawalRate,
    stateTaxRate: a.stateTaxRate,
    inflation: a.inflation,
    plannedExpenses: a.plannedExpenses,
    tax: s.tax,
    birthYear: s.birthYear,
  };
  const { months, years } = projectOutlook(plan);
  return { assumptions: a, pay, nearTermThrough, schedule, plan, months, years, milestones: milestones(plan), startKey };
}

/** Net worth milestones: the first month the plan's closing net worth reaches each, looking 60 years out. */
export function milestones(plan: OutlookPlan): Milestone[] {
  const long = projectOutlook({ ...plan, walkAwayYear: null, horizonYear: Math.max(plan.horizonYear, plan.start.year + SPAN_YEARS) }).months;
  const now = plan.start.liquid + plan.start.illiquid;
  const top = Math.max(now, ...long.map((m) => m.netWorth));
  // Every milestone reached in the span, plus the next one out of reach.
  return MILESTONES.filter((d, i) => d <= top || (i > 0 && MILESTONES[i - 1]! <= top)).map((d) => {
    const reached = now >= d;
    const m = reached ? null : (long.find((x) => x.netWorth >= d) ?? null);
    return {
      cents: d,
      label: d >= 100_000_000 ? `$${d / 100_000_000}M` : `$${d / 100_000}k`,
      key: m?.key ?? null,
      age: m && plan.birthYear != null ? m.year - plan.birthYear : null,
      reached,
    };
  });
}

/** The forecast's balances at the end of month `key` (the start for any month at or before it). */
export function balancesAt(f: Pick<Forecast, "months" | "plan" | "startKey">, key: string): { key: string; liquid: number; illiquid: number; netWorth: number; projected: boolean } {
  if (key <= f.startKey) {
    const { liquid, illiquid } = f.plan.start;
    return { key: f.startKey, liquid, illiquid, netWorth: liquid + illiquid, projected: false };
  }
  const m = f.months.find((x) => x.key === key) ?? f.months.at(-1)!;
  return { key: m.key, liquid: m.liquid, illiquid: m.illiquid, netWorth: m.netWorth, projected: true };
}

/** What the tax estimate takes from the forecast for the year in progress: each person's paycheck basis and the bonuses it pays. */
export type TaxForecastLink = {
  paycheck: Record<string, "LATEST" | "TYPICAL">;
  bonuses: Pick<ScheduledBonus, "personId" | "key" | "date" | "gross" | "label" | "source">[];
};

export function taxLink(f: Forecast): TaxForecastLink {
  return {
    paycheck: Object.fromEntries(f.pay.people.map((p) => [p.personId, p.basis])),
    bonuses: f.schedule.filter((b) => b.counted).map(({ personId, key, date, gross, label, source }) => ({ personId, key, date, gross, label, source })),
  };
}

/** What the Home budget page needs to answer "what could we pay in month X": liquid money and its growth by month, and base salary by year. */
export type HomeForecast = {
  startKey: string;
  startLiquid: number;
  months: { key: string; liquid: number; liquidGrowth: number }[];
  /** Household base salary for a full year, by year. */
  salary: Record<number, number>;
};

export function homeForecast(f: Forecast): HomeForecast {
  const { start, salary, salaryGrowth } = f.plan;
  const salaryByYear: Record<number, number> = {};
  for (let y = start.year; y <= f.plan.horizonYear; y++) salaryByYear[y] = Math.round(salary * (1 + salaryGrowth) ** (y - start.year));
  return { startKey: f.startKey, startLiquid: start.liquid, months: f.months.map(({ key, liquid, liquidGrowth }) => ({ key, liquid, liquidGrowth })), salary: salaryByYear };
}

/** Investment growth on liquid money from the start through month `key` (for capital-gains estimates). */
export function liquidGrowthThrough(f: Pick<Forecast, "months">, key: string): number {
  return f.months.filter((m) => m.key <= key).reduce((g, m) => g + m.liquidGrowth, 0);
}
