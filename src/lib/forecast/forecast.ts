import { resolveBasePay, type OutlookSeeds, type ResolvedBasePay } from "../profile/basePay.ts";
import type { Dependent } from "../tax/computeReturn.ts";
import { grow, projectOutlook, type OutlookMonth, type OutlookPlan, type OutlookYear } from "../profile/outlook.ts";
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
  bonuses: Pick<ScheduledBonus, "personId" | "key" | "date" | "gross" | "label" | "source" | "window">[];
};

export function taxLink(f: Forecast): TaxForecastLink {
  return {
    paycheck: Object.fromEntries(f.pay.people.map((p) => [p.personId, p.basis])),
    bonuses: f.schedule.filter((b) => b.counted).map(({ personId, key, date, gross, label, source, window }) => ({ personId, key, date, gross, label, source, ...(window ? { window } : {}) })),
  };
}

/** What the Home budget page needs to answer "what could we pay in month X": liquid money and its growth by month, and base salary by year. */
export type HomeForecast = {
  startKey: string;
  startLiquid: number;
  months: { key: string; liquid: number; liquidGrowth: number }[];
  /** Household base salary for a full year, by year. */
  salary: Record<number, number>;
  /** What the tax engine needs to tax any household salary: each earner's share of base pay, the dependents and the law year. */
  tax: { year: number; earners: { id: string; name: string; share: number }[]; dependents: Dependent[] };
  /**
   * Bonus as a lender counts it: each earner's cash bonuses averaged over their last two
   * complete years (fewer if that's all there is), summed. Null with no bonus history.
   */
  lenderBonus: { annual: number; years: number[] } | null;
  /** The forecast's return: what the page's investments earn unless a return is typed. */
  returnRate: number;
};

export function homeForecast(f: Forecast, seeds: OutlookSeeds): HomeForecast {
  const { start, salary, salaryGrowth } = f.plan;
  const salaryByYear: Record<number, number> = {};
  for (let y = start.year; y <= f.plan.horizonYear; y++) salaryByYear[y] = Math.round(grow(salary, salaryGrowth, y - start.year));
  const earners = f.pay.people.filter((p) => p.salary > 0).map((p) => ({ id: p.personId, name: p.name, share: salary > 0 ? p.salary / salary : 0 }));
  let bonus = 0;
  const years = new Set<number>();
  for (const p of seeds.people) {
    const last = p.bonusHistory.filter((h) => !h.partial).slice(-2);
    if (!last.length) continue;
    bonus += last.reduce((t, h) => t + h.bonus, 0) / last.length;
    for (const h of last) years.add(h.year);
  }
  return {
    startKey: f.startKey,
    startLiquid: start.liquid,
    months: f.months.map(({ key, liquid, liquidGrowth }) => ({ key, liquid, liquidGrowth })),
    salary: salaryByYear,
    tax: { year: seeds.taxYear, earners, dependents: seeds.dependents },
    lenderBonus: bonus > 0 ? { annual: Math.round(bonus), years: [...years].sort((a, b) => a - b) } : null,
    returnRate: f.assumptions.returnRate,
  };
}

/** Counted bonus pay the schedule puts in `year`, of the given sources (every source by default): one sum for FIRE's table and the Forecast's feeds. */
export function bonusesInYear(schedule: Pick<ScheduledBonus, "counted" | "source" | "key" | "gross">[], year: number, sources?: ScheduledBonus["source"][]): number {
  return schedule.filter((b) => b.counted && (!sources || sources.includes(b.source)) && b.key.startsWith(`${year}-`)).reduce((t, b) => t + b.gross, 0);
}

/**
 * What two pages read from the forecast, as the Forecast page's "Feeds" strip shows it,
 * each read the way its page reads it: the bonus still to come this year (letters and
 * estimates, the bonuses taxLink hands the Taxes page beyond what the stubs paid), and the
 * average monthly change in liquid money over the next twelve months (the balances Goals
 * reads through goalForecastOf: saving, growth and planned one-offs together).
 */
export function forecastFeeds(f: Pick<Forecast, "schedule" | "months" | "plan">, currentYear: number): { bonusToCome: number; liquidPerMonth: number } {
  const year1 = f.months.slice(0, 12);
  return {
    bonusToCome: bonusesInYear(f.schedule, currentYear, ["LETTER", "ESTIMATE"]),
    liquidPerMonth: year1.length ? Math.round((year1.at(-1)!.liquid - f.plan.start.liquid) / year1.length) : 0,
  };
}

/** Investment growth on liquid money from the start through month `key` (for capital-gains estimates). */
export function liquidGrowthThrough(f: Pick<Forecast, "months">, key: string): number {
  return f.months.filter((m) => m.key <= key).reduce((g, m) => g + m.liquidGrowth, 0);
}
