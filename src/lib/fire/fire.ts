import { savingsRate as rateOfSaving } from "../book/definitions.ts";
import { milestones as netWorthMilestones, SPAN_YEARS, type Forecast } from "../forecast/forecast.ts";
import { financialIndependenceYear, projectOutlook, retirementTax, walkAwayTable, type OutlookPlan, type OutlookYear, type WalkAwayRow } from "../profile/outlook.ts";

/**
 * FIRE (financial independence, retire early) analysis on top of the outlook engine
 * (profile/outlook.ts). Nothing here projects money on its own: every "when" comes from
 * running the engine's walk-away table, so the FIRE number, the Lean/Fat/Coast
 * years, the levers and the stress test all agree with the walk-away income. Pure; money
 * is integer cents, rates are ratios.
 */

/** Lean and Fat FIRE as shares of the plan's living cost. */
export const LEAN_SHARE = 0.7;
export const FAT_SHARE = 1.5;
/** Penalty-free access to 401(k)s and IRAs starts at 59½; the first full year is the one you turn 60. */
export const ACCESS_AGE = 60;
/**
 * FIRE's two plans, both the shared forecast (lib/forecast) with the walk-away year as
 * set: `full` is the forecast as is, `base` drops every bonus (paid, scheduled and
 * estimated) to show what base pay alone does.
 */
export function firePlans(f: Pick<Forecast, "plan" | "assumptions">): { full: OutlookPlan; base: OutlookPlan } {
  const full = { ...f.plan, walkAwayYear: f.assumptions.walkAwayYear };
  return { full, base: full.bonus ? { ...full, bonus: null } : full };
}

/** The same plan looking far enough ahead to answer "when". */
export const extended = (plan: OutlookPlan): OutlookPlan => ({ ...plan, horizonYear: Math.max(plan.horizonYear, plan.start.year + SPAN_YEARS) });

/** Smallest pre-tax draw in `year` whose after-tax income reaches `target`. */
export function drawFor(plan: Pick<OutlookPlan, "tax" | "inflation" | "stateTaxRate">, year: number, target: number): number {
  if (target <= 0) return 0;
  let lo = target;
  let hi = target * 2;
  while (retirementTax(plan, year, hi).afterTax < target) hi *= 2;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (retirementTax(plan, year, mid).afterTax >= target) hi = mid;
    else lo = mid;
  }
  return retirementTax(plan, year, lo).afterTax >= target ? lo : hi;
}

/**
 * The FIRE number: the net worth on Jan 1 of `year` whose draw at the withdrawal rate
 * covers `spending` after tax. The classic "25× spending" is this at 4% with no tax.
 */
export function fireNumber(plan: Pick<OutlookPlan, "tax" | "inflation" | "stateTaxRate" | "withdrawalRate">, year: number, spending: number): number {
  return plan.withdrawalRate > 0 ? Math.ceil(drawFor(plan, year, spending) / plan.withdrawalRate) : Infinity;
}

/** Full-year living cost the plan expects in `year` (grows each January from the start year). */
export const livingIn = (plan: OutlookPlan, year: number) => Math.round(plan.livingCost * (1 + plan.livingGrowth) ** (year - plan.start.year));


export type FireRow = WalkAwayRow & {
  fireNumber: number;
  /** netWorth ÷ FIRE number. */
  progress: number;
  /** Net worth that, left alone at the plan's return, reaches the FIRE number at retirement age (null without a birth year). */
  coastNumber: number | null;
  /** Monthly after-tax income still needed on top of walk-away income (0 when covered). */
  gapMonthly: number;
};

export type Milestone = {
  id: string;
  label: string;
  hint: string;
  /** Year it's reached (projected), or null when not within the span. */
  year: number | null;
  /**
   * Net worth milestones: the month (YYYY-MM) the forecast's closing balance first
   * reaches it, the same month the Forecast page shows. FI milestones are judged on Jan 1
   * net worth (a year's draw is set then), so they have no month.
   */
  key: string | null;
  age: number | null;
  /** Already reached on the latest proven net worth. */
  reached: boolean;
};

export type FireAnalysis = {
  plan: OutlookPlan;
  /** The plan as set (walk-away year included), year by year to the horizon. */
  projection: OutlookYear[];
  /** Keep-working walk-away rows with FIRE targets, out to the span. */
  rows: FireRow[];
  fi: FireRow | null;
  /** FI with every bonus left out; equals `fi` when the forecast has none. */
  fiBase: FireRow | null;
  lean: FireRow | null;
  fat: FireRow | null;
  coast: FireRow | null;
  /** Year the owner reaches retirement age (Coast target), when a birth year is known. */
  retireYear: number | null;
  now: {
    netWorth: number;
    liquid: number;
    asOf: string;
    fireNumber: number;
    leanNumber: number;
    fatNumber: number;
    coastNumber: number | null;
    progress: number;
    livingCost: number;
    /** Net worth ÷ a year's living cost. */
    yearsOfSpending: number;
    /** Liquid net worth ÷ a year's living cost ("F-you money"). */
    liquidYears: number;
    /** Multiple of spending the FIRE number is (25× at 4% before tax). */
    multiple: number;
  };
  /** First full working year: saved ÷ (take-home + employer money + bonus kept). */
  savingsRate: number | null;
  milestones: Milestone[];
};

/**
 * Everything the FIRE page shows for one plan. `full` is the plan as set (bonuses
 * included); `base` is base pay alone. The plan starts from the latest proven net worth,
 * which is "now".
 */
export function analyzeFire(full: OutlookPlan, base: OutlookPlan, opts: { asOf: string; retirementAge: number }): FireAnalysis {
  const plan = full;
  const ext = extended(plan);
  const projection = projectOutlook(plan).years;
  const walk = walkAwayTable(ext);
  const y0 = plan.start.year;
  const retireYear = plan.birthYear != null ? plan.birthYear + opts.retirementAge : null;
  const coastTarget = retireYear != null && retireYear >= y0 ? fireNumber(plan, retireYear, livingIn(plan, retireYear)) : null;
  const coastAt = (year: number) => (coastTarget != null && retireYear! >= year ? Math.round(coastTarget / (1 + plan.returnRate) ** (retireYear! - year)) : null);
  const toRow = (w: WalkAwayRow): FireRow => {
    const fn = fireNumber(plan, w.year, w.livingCost);
    return {
      ...w,
      fireNumber: fn,
      progress: fn > 0 ? w.netWorth / fn : 1,
      coastNumber: coastAt(w.year),
      gapMonthly: Math.max(0, Math.round((w.livingCost - w.afterTaxIncome) / 12)),
    };
  };
  const rows = walk.map(toRow);
  const first = (f: (r: FireRow) => boolean) => rows.find(f) ?? null;
  const fiRow = financialIndependenceYear(walk);
  const fi = fiRow ? rows.find((r) => r.year === fiRow.year)! : null;
  const baseFi = base === full ? fiRow : financialIndependenceYear(walkAwayTable(extended(base)));
  const fiBase = baseFi ? (base === full ? fi : toRow(baseFi)) : null;
  const lean = first((r) => r.coverage != null && r.coverage >= LEAN_SHARE);
  const fat = first((r) => r.coverage != null && r.coverage >= FAT_SHARE);
  const coast = first((r) => r.coastNumber != null && r.netWorth >= r.coastNumber);

  const living0 = livingIn(plan, y0);
  const fn0 = fireNumber(plan, y0, living0);
  const nw0 = plan.start.liquid + plan.start.illiquid;
  const now = {
    netWorth: nw0,
    liquid: plan.start.liquid,
    asOf: opts.asOf,
    fireNumber: fn0,
    leanNumber: fireNumber(plan, y0, Math.round(living0 * LEAN_SHARE)),
    fatNumber: fireNumber(plan, y0, Math.round(living0 * FAT_SHARE)),
    coastNumber: coastAt(y0),
    progress: fn0 > 0 ? nw0 / fn0 : 1,
    livingCost: living0,
    yearsOfSpending: living0 > 0 ? nw0 / living0 : 0,
    liquidYears: living0 > 0 ? plan.start.liquid / living0 : 0,
    multiple: living0 > 0 ? fn0 / living0 : 0,
  };
  const y1 = projection.find((y) => y.months === 12 && y.working);
  const income1 = y1 ? y1.takeHome + y1.employerMatch + y1.bonusKept : 0;
  // The plan's first full working year: saved ÷ what came in (take-home + employer money + bonus kept), the shared definition.
  const savingsRate = y1 ? rateOfSaving(income1, y1.saved) : null;

  return {
    plan,
    projection,
    rows,
    fi,
    fiBase,
    lean,
    fat,
    coast,
    retireYear,
    now,
    savingsRate,
    milestones: milestones(plan, rows, now, { fi, lean, fat, coast }),
  };
}

const ageIn = (plan: OutlookPlan, year: number | null) => (year == null || plan.birthYear == null ? null : year - plan.birthYear);

function milestones(plan: OutlookPlan, rows: FireRow[], now: FireAnalysis["now"], f: { fi: FireRow | null; lean: FireRow | null; fat: FireRow | null; coast: FireRow | null }): Milestone[] {
  // Net worth milestones come from the forecast's month-by-month path (keep working), so they match the Forecast page.
  const out: Milestone[] = netWorthMilestones(plan).map((m) => ({
    id: `nw-${m.cents}`,
    label: `${m.label} net worth`,
    hint: "",
    year: m.key ? Number(m.key.slice(0, 4)) : null,
    key: m.key,
    age: m.age,
    reached: m.reached,
  }));
  for (const share of [0.25, 0.5, 0.75]) {
    const reached = now.progress >= share;
    const row = reached ? null : (rows.find((r) => r.progress >= share) ?? null);
    out.push({ id: `fi-${share}`, label: `${share * 100}% FI`, hint: `net worth at ${share * 100}% of that year's FIRE number`, year: row?.year ?? null, key: null, age: ageIn(plan, row?.year ?? null), reached });
  }
  const flavor = (id: string, label: string, hint: string, row: FireRow | null, reached: boolean) =>
    out.push({ id, label, hint, year: reached ? null : (row?.year ?? null), key: null, age: reached ? null : ageIn(plan, row?.year ?? null), reached });
  if (now.coastNumber != null) flavor("coast", "Coast FIRE", "enough invested to stop saving and still reach FI by retirement age", f.coast, now.netWorth >= now.coastNumber);
  flavor("lean", "Lean FIRE", `walk-away income covers ${LEAN_SHARE * 100}% of living cost`, f.lean, now.netWorth >= now.leanNumber);
  flavor("fi", "FIRE", "walk-away income covers living cost", f.fi, now.netWorth >= now.fireNumber);
  flavor("fat", "Fat FIRE", `walk-away income covers ${FAT_SHARE * 100}% of living cost`, f.fat, now.netWorth >= now.fatNumber);
  // Reached first, then in time order (a Jan 1 milestone sorts with the December before it).
  const when = (m: Milestone) => (m.key ?? (m.year != null ? `${m.year - 1}-12` : "9999"));
  return out.sort((a, b) => Number(b.reached) - Number(a.reached) || when(a).localeCompare(when(b)));
}

// ---------------------------------------------------------------- levers

/** Year of financial independence (keep working until then), or null within the span. */
export function fiYear(plan: OutlookPlan): number | null {
  return financialIndependenceYear(walkAwayTable(extended(plan)))?.year ?? null;
}

/** Base take-home pay plus employer money at the start: what a (base-pay) savings rate is a share of. */
export function firstYearIncome(plan: OutlookPlan): number {
  return Math.round(plan.salary * plan.takeHomeRate) + plan.employerMatch;
}

export type SavingsRatePoint = { rate: number; livingCost: number; fiYear: number | null; years: number | null };

/**
 * The classic FIRE chart: years to financial independence by savings rate. Each point
 * reruns the plan with living cost set so that (base income − living) ÷ base income is
 * the rate — spending less both saves more and lowers the FIRE number. Any bonuses
 * stays as set.
 */
export function savingsRateCurve(plan: OutlookPlan, rates: number[]): SavingsRatePoint[] {
  const income = firstYearIncome(plan);
  return rates.map((rate) => {
    const livingCost = Math.round(income * (1 - rate));
    const y = fiYear({ ...plan, livingCost });
    return { rate, livingCost, fiYear: y, years: y == null ? null : y - plan.start.year };
  });
}

export type SpendingCut = { monthly: number; livingCost: number; fiYear: number | null };

/** FI year with living cost lower by each monthly amount. */
export function spendingCuts(plan: OutlookPlan, monthly: number[]): SpendingCut[] {
  return monthly.map((m) => {
    const livingCost = Math.max(0, plan.livingCost - m * 12);
    return { monthly: m, livingCost, fiYear: fiYear({ ...plan, livingCost }) };
  });
}

/** FI year for each return × withdrawal rate. */
export function sensitivityGrid(plan: OutlookPlan, returns: number[], withdrawalRates: number[]): (number | null)[][] {
  return returns.map((returnRate) => withdrawalRates.map((withdrawalRate) => fiYear({ ...plan, returnRate, withdrawalRate })));
}

// ---------------------------------------------------------------- bridge to 59½

export type AccessBridge = {
  walkAwayYear: number;
  /** First retired year that starts with no liquid (taxable) money left, if any. */
  liquidOutYear: number | null;
  accessYear: number;
  /** Retired years before penalty-free access that are paid from retirement accounts. */
  gapYears: number;
  liquidAtWalkAway: number;
  illiquidAtWalkAway: number;
};

/**
 * Retiring early means living on taxable money until 401(k)s and IRAs open at 59½. Runs
 * the plan with the walk-away year and finds when liquid money runs out; the engine then
 * draws on retirement accounts, which before 59½ needs a Roth ladder, 72(t) payments or
 * the Rule of 55.
 */
export function accessBridge(plan: OutlookPlan, walkAwayYear: number): AccessBridge | null {
  if (plan.birthYear == null) return null;
  const accessYear = plan.birthYear + ACCESS_AGE;
  const years = projectOutlook({ ...extended(plan), walkAwayYear }).years;
  if (!years.some((y) => y.year === walkAwayYear)) return null;
  const before = years.find((y) => y.year === walkAwayYear - 1);
  const out = years.find((y) => !y.working && y.liquid <= 0);
  const liquidOutYear = out ? out.year + 1 : null;
  return {
    walkAwayYear,
    liquidOutYear,
    accessYear,
    gapYears: liquidOutYear == null ? 0 : Math.max(0, accessYear - liquidOutYear),
    liquidAtWalkAway: before ? before.liquid : plan.start.liquid,
    illiquidAtWalkAway: before ? before.illiquid : plan.start.illiquid,
  };
}

// ---------------------------------------------------------------- stress test

/** Small seeded generator (mulberry32), so a stress test reads the same on every render. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Annual returns whose average is `mean` and standard deviation `sd` (lognormal growth). */
export function randomReturns(mean: number, sd: number, years: number, next: () => number): number[] {
  const s2 = Math.log(1 + (sd * sd) / (1 + mean) ** 2);
  const mu = Math.log(1 + mean) - s2 / 2;
  const s = Math.sqrt(s2);
  const out: number[] = [];
  for (let i = 0; i < years; i++) {
    const z = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
    out.push(Math.exp(mu + s * z) - 1);
  }
  return out;
}

export type StressTest = {
  paths: number;
  /** Net worth at the start of each year (the plan as set, walk-away included), then the horizon's year end: percentiles across paths. */
  bands: { year: number; p10: number; p25: number; p50: number; p75: number; p90: number; plan: number }[];
  /** Share of paths financially independent by Jan 1 of each year. */
  fiByYear: { year: number; share: number }[];
  /** FI year at the 10th / 50th / 90th percentile of paths (null = not within the span). */
  fiYears: { p10: number | null; p50: number | null; p90: number | null };
  /** With a walk-away year: share of paths whose walk-away income covers living cost in every retired year shown. */
  coveredThroughout: number | null;
};

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;

/**
 * Reruns the plan with random yearly returns (same average as the plan's return, the
 * given volatility) to show how much the dates can move with markets — sequence risk.
 */
export function stressTest(plan: OutlookPlan, opts: { volatility: number; paths?: number; seed?: number }): StressTest {
  const n = opts.paths ?? 500;
  const next = rng(opts.seed ?? 20_261_006);
  const ext = extended(plan);
  const span = ext.horizonYear - plan.start.year + 1;
  const planYears = projectOutlook(plan).years;
  const shown = planYears.length + 1;
  const nw: number[][] = Array.from({ length: shown }, () => []);
  const fis: (number | null)[] = [];
  let covered = 0;
  for (let k = 0; k < n; k++) {
    const returns = randomReturns(plan.returnRate, opts.volatility, span, next);
    fis.push(financialIndependenceYear(walkAwayTable({ ...ext, returns }))?.year ?? null);
    const ys = projectOutlook({ ...plan, returns }).years;
    ys.forEach((y, i) => nw[i]!.push(y.startNetWorth));
    nw[shown - 1]!.push(ys.at(-1)!.netWorth);
    if (plan.walkAwayYear != null && ys.filter((y) => !y.working).every((y) => (y.coverage ?? 0) >= 1)) covered++;
  }
  const bands = nw.map((xs, i) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
      year: i < planYears.length ? planYears[i]!.year : planYears.at(-1)!.year + 1,
      p10: quantile(s, 0.1),
      p25: quantile(s, 0.25),
      p50: quantile(s, 0.5),
      p75: quantile(s, 0.75),
      p90: quantile(s, 0.9),
      plan: i < planYears.length ? planYears[i]!.startNetWorth : planYears.at(-1)!.netWorth,
    };
  });
  const fiByYear: StressTest["fiByYear"] = [];
  for (let year = plan.start.year + 1; year <= ext.horizonYear; year++) fiByYear.push({ year, share: fis.filter((y) => y != null && y <= year).length / n });
  const sortedFi = fis.map((y) => y ?? Infinity).sort((a, b) => a - b);
  const q = (x: number) => {
    const v = quantile(sortedFi, x);
    return Number.isFinite(v) ? v : null;
  };
  return {
    paths: n,
    bands,
    fiByYear,
    fiYears: { p10: q(0.1), p50: q(0.5), p90: q(0.9) },
    coveredThroughout: plan.walkAwayYear != null && planYears.some((y) => !y.working) ? covered / n : null,
  };
}
