import { bracketTax } from "../tax/computeReturn.ts";
import type { PlannedExpense } from "./settings.ts";

/**
 * The outlook: net worth month by month from the latest proven balance, split into liquid
 * and illiquid money, rolled up into calendar years, and what that net worth could pay
 * you if you stopped working ("walk-away income"). Pure; money is integer cents, rates
 * are ratios.
 *
 * Every working month runs on base pay alone: a twelfth of base salary × the take-home
 * rate (after tax and benefit deductions; 401(k)/HSA deferrals stay in) + employer
 * money − living cost − planned one-offs. Deferrals and employer money land in illiquid
 * (retirement) accounts, the rest in liquid ones. Raises and living-cost growth apply each
 * January. Bonuses are dated payments — the forecast's bonus schedule decides which ones
 * and when (lib/forecast/bonusSchedule.ts): each is paid in its month, a fixed share of it
 * is kept after tax, and a chosen share of that is saved into liquid money. Returns
 * compound monthly on the opening balance plus half the month's flows.
 *
 * Once retired: draw a fixed share of the January 1 net worth across the year, pay
 * federal tax on it with the real brackets (indexed for inflation) plus a flat state
 * rate, and compare the after-tax income with that year's living cost.
 */

/** One bonus payment in the plan: its gross, paid in month `key` (YYYY-MM). */
export type BonusPayment = { key: string; gross: number };

export type OutlookPlan = {
  /** The projection starts the month after `month` of `year`, from these balances. */
  start: { year: number; month: number; liquid: number; illiquid: number };
  horizonYear: number;
  /** Last year of the near term (no estimated bonus is paid in it by default; the schedule applies that). */
  nearTermThrough: number;
  /** Household annual base salary at the start. */
  salary: number;
  takeHomeRate: number;
  /** Annual employee 401(k)/HSA deferrals (inside take-home) and employer money, at the start. */
  deferrals: number;
  employerMatch: number;
  livingCost: number;
  salaryGrowth: number;
  livingGrowth: number;
  /** Null = no bonuses at all (base pay only throughout). */
  bonus: { payments: BonusPayment[]; keepRate: number; savedShare: number } | null;
  returnRate: number;
  walkAwayYear: number | null;
  withdrawalRate: number;
  stateTaxRate: number;
  inflation: number;
  plannedExpenses: PlannedExpense[];
  /**
   * Stress tests only: each calendar year's return in place of `returnRate` (index 0 =
   * start.year); years past the end of the list use `returnRate`.
   */
  returns?: number[];
  /** Married-filing-jointly standard deduction and bracket tops for `tax.year`. */
  tax: { year: number; standardDeduction: number; brackets: number[] };
  birthYear: number | null;
};

export type OutlookMonth = {
  year: number;
  month: number;
  /** YYYY-MM */
  key: string;
  working: boolean;
  nearTerm: boolean;
  salary: number;
  /** Base pay after tax and deductions (deferrals included). */
  takeHome: number;
  employerMatch: number;
  deferrals: number;
  livingCost: number;
  planned: number;
  bonusGross: number;
  bonusKept: number;
  bonusSaved: number;
  /** Base pay's savings: take-home + employer − living − one-offs. */
  baseSaved: number;
  /** Everything added: base savings + bonus saved (working), or − draw − one-offs (retired). */
  saved: number;
  draw: number;
  growth: number;
  /** The part of `growth` earned on liquid money. */
  liquidGrowth: number;
  liquid: number;
  illiquid: number;
  netWorth: number;
};

export type OutlookYear = {
  year: number;
  /** Months of the year that are projected (fewer in the starting year). */
  months: number;
  age: number | null;
  working: boolean;
  nearTerm: boolean;
  salary: number;
  takeHome: number;
  employerMatch: number;
  livingCost: number;
  /** That year's full-year living cost (for walk-away coverage). */
  livingAnnual: number;
  planned: number;
  baseSaved: number;
  bonusGross: number;
  bonusKept: number;
  bonusSaved: number;
  saved: number;
  growth: number;
  draw: number;
  federalTax: number;
  stateTax: number;
  afterTaxIncome: number;
  /** After-tax retirement income ÷ that year's living cost. */
  coverage: number | null;
  startNetWorth: number;
  liquid: number;
  illiquid: number;
  netWorth: number;
  change: number;
  changePct: number | null;
};

export type Outlook = { months: OutlookMonth[]; years: OutlookYear[] };

const grow = (base: number, rate: number, years: number) => base * (1 + rate) ** years;
const pad = (m: number) => String(m).padStart(2, "0");

/** Federal + state tax on a retirement draw in `year` (all draws treated as ordinary income). */
export function retirementTax(plan: Pick<OutlookPlan, "tax" | "inflation" | "stateTaxRate">, year: number, draw: number) {
  const idx = (1 + plan.inflation) ** (year - plan.tax.year);
  const taxable = Math.max(0, draw - plan.tax.standardDeduction * idx);
  const federal = bracketTax(taxable, plan.tax.brackets.map((b) => b * idx));
  const state = Math.round(taxable * plan.stateTaxRate);
  return { taxable: Math.round(taxable), federal, state, afterTax: Math.round(draw - federal - state) };
}

/** Splits an annual amount into twelve whole-cent months that add back up exactly. */
const monthly = (annual: number, m: number) => Math.round((annual * m) / 12) - Math.round((annual * (m - 1)) / 12);

export function projectOutlook(plan: OutlookPlan): Outlook {
  const months: OutlookMonth[] = [];
  const years: OutlookYear[] = [];
  let liquid = plan.start.liquid;
  let illiquid = plan.start.illiquid;
  const walkAway = plan.walkAwayYear != null && plan.walkAwayYear > plan.start.year ? plan.walkAwayYear : null;
  const bonusIn = new Map<string, number>();
  for (const b of plan.bonus?.payments ?? []) bonusIn.set(b.key, (bonusIn.get(b.key) ?? 0) + b.gross);

  for (let year = plan.start.year; year <= plan.horizonYear; year++) {
    const first = year === plan.start.year ? plan.start.month + 1 : 1;
    if (first > 12) continue;
    const i = year - plan.start.year;
    const rm = (1 + (plan.returns?.[i] ?? plan.returnRate)) ** (1 / 12) - 1;
    const working = walkAway == null || year < walkAway;
    const nearTerm = year <= plan.nearTermThrough;
    const startNw = liquid + illiquid;
    const salaryY = grow(plan.salary, plan.salaryGrowth, i);
    const scale = plan.salary > 0 ? salaryY / plan.salary : 1;
    const livingY = grow(plan.livingCost, plan.livingGrowth, i);
    const draw = working ? 0 : Math.round(Math.max(0, startNw) * plan.withdrawalRate);
    const y: OutlookYear = {
      year,
      months: 13 - first,
      age: plan.birthYear == null ? null : year - plan.birthYear,
      working,
      nearTerm,
      salary: 0,
      takeHome: 0,
      employerMatch: 0,
      livingCost: 0,
      livingAnnual: Math.round(livingY),
      planned: 0,
      baseSaved: 0,
      bonusGross: 0,
      bonusKept: 0,
      bonusSaved: 0,
      saved: 0,
      growth: 0,
      draw: 0,
      federalTax: 0,
      stateTax: 0,
      afterTaxIncome: 0,
      coverage: null,
      startNetWorth: startNw,
      liquid: 0,
      illiquid: 0,
      netWorth: 0,
      change: 0,
      changePct: null,
    };
    for (let m = first; m <= 12; m++) {
      const planned = plan.plannedExpenses.filter((e) => e.year === year && (e.month ?? 6) === m).reduce((s, e) => s + e.amount, 0);
      const row: OutlookMonth = {
        year,
        month: m,
        key: `${year}-${pad(m)}`,
        working,
        nearTerm,
        salary: 0,
        takeHome: 0,
        employerMatch: 0,
        deferrals: 0,
        livingCost: monthly(livingY, m),
        planned,
        bonusGross: 0,
        bonusKept: 0,
        bonusSaved: 0,
        baseSaved: 0,
        saved: 0,
        draw: 0,
        growth: 0,
        liquidGrowth: 0,
        liquid: 0,
        illiquid: 0,
        netWorth: 0,
      };
      let liquidFlow: number;
      let illiquidFlow: number;
      if (working) {
        row.salary = monthly(salaryY, m);
        row.takeHome = monthly(salaryY * plan.takeHomeRate, m);
        row.employerMatch = monthly(plan.employerMatch * scale, m);
        row.deferrals = Math.min(row.takeHome, monthly(plan.deferrals * scale, m));
        row.baseSaved = row.takeHome + row.employerMatch - row.livingCost - planned;
        if (plan.bonus) {
          row.bonusGross = bonusIn.get(row.key) ?? 0;
          row.bonusKept = Math.round(row.bonusGross * plan.bonus.keepRate);
          row.bonusSaved = Math.round(row.bonusKept * plan.bonus.savedShare);
        }
        row.saved = row.baseSaved + row.bonusSaved;
        illiquidFlow = row.deferrals + row.employerMatch;
        liquidFlow = row.saved - illiquidFlow;
      } else {
        row.draw = monthly(draw, m);
        row.saved = -row.draw - planned;
        liquidFlow = row.saved;
        illiquidFlow = 0;
      }
      const lg = Math.round(rm * (liquid + liquidFlow / 2));
      const ig = Math.round(rm * (illiquid + illiquidFlow / 2));
      liquid += liquidFlow + lg;
      illiquid += illiquidFlow + ig;
      // Retired and out of liquid money: the rest comes from retirement accounts.
      if (!working && liquid < 0) {
        illiquid += liquid;
        liquid = 0;
      }
      row.growth = lg + ig;
      row.liquidGrowth = lg;
      row.liquid = liquid;
      row.illiquid = illiquid;
      row.netWorth = liquid + illiquid;
      months.push(row);
      y.salary += row.salary;
      y.takeHome += row.takeHome;
      y.employerMatch += row.employerMatch;
      y.livingCost += row.livingCost;
      y.planned += planned;
      y.baseSaved += row.baseSaved;
      y.bonusGross += row.bonusGross;
      y.bonusKept += row.bonusKept;
      y.bonusSaved += row.bonusSaved;
      y.saved += row.saved;
      y.growth += row.growth;
      y.draw += row.draw;
    }
    if (!working) {
      const t = retirementTax(plan, year, draw);
      y.federalTax = t.federal;
      y.stateTax = t.state;
      y.afterTaxIncome = t.afterTax;
      y.coverage = y.livingAnnual > 0 ? t.afterTax / y.livingAnnual : null;
    }
    y.liquid = liquid;
    y.illiquid = illiquid;
    y.netWorth = liquid + illiquid;
    y.change = y.netWorth - startNw;
    y.changePct = startNw > 0 ? y.change / startNw : null;
    years.push(y);
  }
  return { months, years };
}

export type WalkAwayRow = {
  /** Stop working at the start of this year. */
  year: number;
  age: number | null;
  netWorth: number;
  draw: number;
  federalTax: number;
  stateTax: number;
  afterTaxIncome: number;
  monthly: number;
  /** Monthly, in today's dollars. */
  monthlyToday: number;
  livingCost: number;
  coverage: number | null;
};

/**
 * "If I walked away on Jan 1 of year X": the first year's after-tax income from drawing
 * the withdrawal rate on the net worth the working plan reaches by then. Only years that
 * start after the projection does (their Jan 1 net worth is projected).
 */
export function walkAwayTable(plan: OutlookPlan): WalkAwayRow[] {
  const { years } = projectOutlook({ ...plan, walkAwayYear: null });
  return years
    .filter((y) => y.months === 12 && y.year > plan.start.year)
    .map((y) => {
      const nw = y.startNetWorth;
      const draw = Math.round(Math.max(0, nw) * plan.withdrawalRate);
      const t = retirementTax(plan, y.year, draw);
      return {
        year: y.year,
        age: y.age,
        netWorth: nw,
        draw,
        federalTax: t.federal,
        stateTax: t.state,
        afterTaxIncome: t.afterTax,
        monthly: Math.round(t.afterTax / 12),
        monthlyToday: Math.round(t.afterTax / 12 / (1 + plan.inflation) ** (y.year - plan.start.year)),
        livingCost: y.livingAnnual,
        coverage: y.livingAnnual > 0 ? t.afterTax / y.livingAnnual : null,
      };
    });
}

/** First year whose walk-away income covers that year's living cost. */
export function financialIndependenceYear(rows: WalkAwayRow[]): WalkAwayRow | null {
  return rows.find((r) => r.coverage != null && r.coverage >= 1) ?? null;
}
