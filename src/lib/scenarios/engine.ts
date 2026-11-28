import { SPAN_YEARS, type Forecast } from "../forecast/forecast.ts";
import { fixedMonthlyPayment } from "../mortgage/prepayVsInvest.ts";
import { payIncome, type OutlookSeeds, type ResolvedPerson } from "../profile/basePay.ts";
import { grow, monthly, projectOutlook, retirementTax, type BonusPayment, type MonthAdjust, type OutlookMonth, type OutlookPlan, type OutlookYear } from "../profile/outlook.ts";
import { computeReturn, type Dependent } from "../tax/computeReturn.ts";
import type { TaxYearParams } from "../tax/params.ts";
import type { CareBand, PersonChange, Scenario, ScenarioModel } from "./types.ts";

/**
 * The scenario engine: today's plan (the shared forecast, lib/forecast) with a scenario's
 * changes laid on top, month by month, and run through the same outlook engine
 * (profile/outlook.ts projectOutlook). Nothing here is a second model of the household:
 *  - pay changes are the difference between each adult's scenario pay and their pay in
 *    the forecast, taxed by the tax engine (tax/computeReturn.ts, today's law indexed by
 *    inflation, as the outlook taxes retirement draws) — the difference in tax, not a rate;
 *  - childcare, rent, a home and other spending are differences from the living cost the
 *    forecast carries;
 *  - bonuses are the forecast's own bonus schedule, scaled or dropped;
 *  - a home is the mortgage maths (mortgage/prepayVsInvest.ts fixedMonthlyPayment), its
 *    interest and property tax itemized through the tax engine.
 * A scenario that changes nothing adds nothing, so its path is the forecast's, to the cent.
 *
 * Pure (no database): the Scenarios page reruns it on every edit. Money is integer cents.
 */

/** What the ledger says about the household that the scenarios need beyond the forecast (server: lib/scenarios/facts.ts). */
export type ScenarioFacts = {
  /** The proven-through date the forecast starts from. */
  asOf: string;
  /** Childcare a year over the latest proven months (rows paid to daycares, nannies, preschools), or null when the ledger shows none. */
  childcare: { annual: number; months: number; rows: number } | null;
  /** Housing & utilities a month (rent, renter's insurance, utilities) over the latest proven months: what buying a home replaces. */
  housing: { monthly: number; months: number } | null;
};

export type ScenarioContext = {
  forecast: Forecast;
  seeds: OutlookSeeds;
  facts: ScenarioFacts;
  model: ScenarioModel;
  params: TaxYearParams;
};

/** One month of a scenario, as the page draws it. */
export type RunMonth = {
  key: string;
  year: number;
  month: number;
  /** Base pay + bonus, before tax. */
  gross: number;
  /** Tax on pay (income tax and payroll tax) and on bonuses. */
  tax: number;
  /** Pay after tax and deductions (retirement saving included), plus bonuses kept. */
  takeHome: number;
  employerMatch: number;
  /** Living cost (childcare and housing included) and one-offs. */
  spending: number;
  childcare: number;
  /** Rent, or the home's monthly cost (mortgage payment, tax, insurance, upkeep, HOA, utilities). */
  housing: number;
  saved: number;
  liquid: number;
  illiquid: number;
  /** Home value less what's owed on it. */
  equity: number;
  /** liquid + illiquid + equity. */
  netWorth: number;
};

export type RunYear = {
  year: number;
  months: number;
  gross: number;
  tax: number;
  takeHome: number;
  spending: number;
  saved: number;
  liquid: number;
  illiquid: number;
  equity: number;
  netWorth: number;
};

export type ScenarioRun = {
  /** The plan the outlook engine ran (looking SPAN_YEARS ahead). */
  plan: OutlookPlan;
  /** The outlook engine's own months (net worth there is liquid + illiquid). */
  outlook: OutlookMonth[];
  months: RunMonth[];
  years: RunYear[];
  /** First year whose walk-away income (the FIRE rule) covers that year's spending. */
  fiYear: number | null;
  /** The month the scenario's first change takes effect (null: it changes nothing dated). */
  firstChange: string | null;
  /** The working assumptions after the scenario's overrides. */
  used: { returnRate: number; inflation: number; livingGrowth: number; livingCost: number; carePerChild: number; careFrom: "LEDGER" | "TYPED" | "DEFAULT"; rent: number; rentFrom: "LEDGER" | "TYPED" | "NONE" };
};

// ---------------------------------------------------------------- months

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (y: number, m: number) => `${y}-${pad(m)}`;
const parts = (key: string) => ({ y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) });
/** Months from `a` to `b` (both YYYY-MM). */
export const monthsBetween = (a: string, b: string) => {
  const x = parts(a);
  const y = parts(b);
  return (y.y - x.y) * 12 + (y.m - x.m);
};

/** Today's children were born mid-year: the tax profile knows their age, not their birthday. */
const BIRTH_MONTH = 7;

/** A child's whole years of age in month `key` (null before they're born). */
export const ageIn = (born: string, key: string) => {
  const n = monthsBetween(born, key);
  return n < 0 ? null : Math.floor(n / 12);
};

/** The share of full-time care a child of `age` needs (0 when unborn or past every band). */
export const careShare = (bands: readonly CareBand[], age: number | null) => (age == null ? 0 : (bands.find((b) => age >= b.fromAge && age <= b.toAge)?.share ?? 0));

/** Interest above this much mortgage debt isn't deductible (married filing jointly, loans after 2017). */
export const MORTGAGE_INTEREST_DEBT_CAP = 750_000_00;
/** Children count as dependents on the return through this age. */
const DEPENDENT_THROUGH_AGE = 18;

// ---------------------------------------------------------------- the engine

type TaxConfig = { people: { salary: number; k401Pretax: number; hsa: number; section125: number }[]; deps: number[]; mortgageInterest: number; propertyTax: number; care: number };

/** Caches the work every scenario on one context shares (the forecast's own tax by year). */
const taxMemo = new WeakMap<ScenarioContext, Map<string, number>>();

/** Household tax on pay for a year (income tax and payroll tax, in the tax year's dollars), for a config. */
function taxOf(ctx: ScenarioContext, people: readonly ResolvedPerson[], c: TaxConfig): number {
  let memo = taxMemo.get(ctx);
  if (!memo) taxMemo.set(ctx, (memo = new Map()));
  const k = JSON.stringify(c);
  const hit = memo.get(k);
  if (hit != null) return hit;
  const paid = people.map((p, i) => ({ p, c: c.people[i]! })).filter((x) => x.c.salary > 0);
  let total = 0;
  if (paid.length) {
    const incomes = paid.map(({ p, c: x }) => payIncome({ id: p.personId, name: p.name, salary: x.salary, bonus: 0, k401Pretax: x.k401Pretax, hsa: x.hsa, section125: x.section125 }, ctx.params));
    incomes[0] = { ...incomes[0]!, mortgageInterest: c.mortgageInterest, propertyTax: c.propertyTax, dependentCareExpenses: c.care };
    const dependents: Dependent[] = c.deps.map((age, i) => ({ name: `Child ${i + 1}`, age }));
    const r = computeReturn({ params: ctx.params, filingStatus: "MFJ", people: incomes, dependents, itemizeMode: "AUTO" });
    total = r.federal.totalTax + r.ct.totalTax + r.fica.socialSecurity + r.fica.medicare + r.fica.ctPfml;
  }
  memo.set(k, total);
  return total;
}

/** Each adult's scenario base pay for a full year at the rate in force in month `key`. */
function annualPay(base: OutlookPlan, p: ResolvedPerson, c: PersonChange | undefined, year: number, key: string): number {
  const g = c?.raise ?? base.salaryGrowth;
  let a = c?.jobChange && key >= c.jobChange.from ? grow(c.jobChange.salary, g, year - parts(c.jobChange.from).y) : grow(p.salary, g, year - base.start.year);
  if (c?.partTime && key >= c.partTime.from) a *= c.partTime.share;
  if (c?.stop && key >= c.stop.from) a = 0;
  return a;
}

/** The scenario's bonus payments: the forecast's schedule, scaled with pay and the bonus level, dropped once someone stops or leaves. */
function scenarioBonuses(ctx: ScenarioContext, s: Scenario, base: OutlookPlan): BonusPayment[] {
  const f = ctx.forecast;
  const byId = new Map(s.people.map((c) => [c.personId, c]));
  const out: BonusPayment[] = [];
  for (const b of f.schedule) {
    if (!b.counted) continue;
    const c = byId.get(b.personId);
    const p = f.pay.people.find((x) => x.personId === b.personId);
    if (!c || !p) {
      out.push({ key: b.key, gross: b.gross });
      continue;
    }
    if (b.source === "PAID") out.push({ key: b.key, gross: b.gross });
    else if (c.stop && b.key >= c.stop.from) continue;
    else if (b.source === "ESTIMATE") {
      // A new job with its own bonus share gets its own payments (below).
      if (c.jobChange && b.key >= c.jobChange.from && c.jobChange.bonusPct != null) continue;
      const y = parts(b.key).y;
      const before = grow(p.salary, base.salaryGrowth, y - base.start.year);
      const ratio = before > 0 ? annualPay(base, p, c, y, b.key) / before : 1;
      const gross = Math.round(b.gross * c.bonusLevel * ratio);
      if (gross > 0) out.push({ key: b.key, gross });
    } else if (!(c.jobChange && b.key >= c.jobChange.from)) out.push({ key: b.key, gross: b.gross });
    // A letter's payments after a job change are forfeited (left the employer).
  }
  // A new job's bonus: its share of the year's pay, in the person's bonus month, from the first full year there.
  const horizon = base.start.year + SPAN_YEARS;
  for (const c of s.people) {
    const p = f.pay.people.find((x) => x.personId === c.personId);
    if (!p || !c.jobChange || c.jobChange.bonusPct == null || c.jobChange.bonusPct <= 0) continue;
    for (let y = parts(c.jobChange.from).y + 1; y <= horizon; y++) {
      const key = keyOf(y, p.bonusMonth);
      if (c.stop && key >= c.stop.from) break;
      const gross = Math.round(annualPay(base, p, c, y - 1, keyOf(y - 1, 12)) * c.jobChange.bonusPct * c.bonusLevel);
      if (gross > 0) out.push({ key, gross });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Splits a year's whole-cent amount over its twelve months by weight (evenly when no month has any), adding back up exactly. */
export function spread(total: number, weights: readonly number[]): number[] {
  if (total === 0) return weights.map(() => 0);
  const w = weights.some((x) => x > 0) ? weights : weights.map(() => 1);
  const sum = w.reduce((t, x) => t + x, 0);
  let given = 0;
  let acc = 0;
  return w.map((x) => {
    acc += x;
    const upTo = Math.round((total * acc) / sum);
    const part = upTo - given;
    given = upTo;
    return part;
  });
}

/** The month the scenario's first dated change takes effect. */
export function firstChangeOf(s: Scenario, startKey: string): string | null {
  const dates = [
    ...s.people.flatMap((c) => [c.jobChange?.from, c.partTime?.from, c.stop?.from, c.raise != null || c.bonusLevel !== 1 ? "" : undefined]),
    ...s.children.added.map((c) => c.born),
    s.housing.buy?.at,
    s.housing.rentGrowth != null ? "" : undefined,
    ...s.spending.oneOffs.map((o) => o.at),
    s.spending.living != null || s.spending.livingChange != null || s.spending.growth != null || s.assumptions.returnRate != null || s.assumptions.inflation != null || s.children.ageOut ? "" : undefined,
  ].filter((d): d is string => d != null);
  if (!dates.length) return null;
  const first = dates.map((d) => (d === "" || d <= startKey ? nextKey(startKey) : d)).sort()[0]!;
  return first;
}

const nextKey = (key: string) => {
  const { y, m } = parts(key);
  return m === 12 ? keyOf(y + 1, 1) : keyOf(y, m + 1);
};

export function runScenario(ctx: ScenarioContext, s: Scenario): ScenarioRun {
  const f = ctx.forecast;
  const base = f.plan;
  const model = ctx.model;
  const startYear = base.start.year;
  const horizon = Math.max(base.horizonYear, startYear + SPAN_YEARS);

  // Shared assumptions: the forecast's unless the scenario overrides them. Living cost
  // follows a changed inflation when the forecast ties the two together.
  const inflation = s.assumptions.inflation ?? base.inflation;
  const tied = Math.abs(base.livingGrowth - base.inflation) < 1e-12;
  const livingGrowth = s.spending.growth ?? (s.assumptions.inflation != null && tied ? inflation : base.livingGrowth);
  const livingCost = Math.max(0, (s.spending.living ?? base.livingCost) + (s.spending.livingChange ?? 0));
  const returnRate = s.assumptions.returnRate ?? base.returnRate;

  // Pay: each adult's change, and the shares of the household's retirement saving and deductions that ride on their pay.
  const people = f.pay.people;
  const changes = new Map(s.people.map((c) => [c.personId, c]));
  const sumDef = people.reduce((t, p) => t + p.deferrals, 0);
  const sumEmp = people.reduce((t, p) => t + p.employer, 0);
  const sumSal = people.reduce((t, p) => t + p.salary, 0);
  const rates = people.map((p) => {
    const share = (part: number, whole: number) => (whole > 0 ? part / whole : sumSal > 0 ? p.salary / sumSal : 0);
    return {
      def: p.salary > 0 ? (base.deferrals * share(p.deferrals, sumDef)) / p.salary : 0,
      emp: p.salary > 0 ? (base.employerMatch * share(p.employer, sumEmp)) / p.salary : 0,
      ded: p.salary > 0 ? (p.section125 + p.afterTax) / p.salary : 0,
    };
  });

  // Children: today's (born mid-year, from their age on the tax profile) and the ones the scenario adds.
  const today = ctx.seeds.dependents.map((d) => keyOf(ctx.seeds.taxYear - d.age, BIRTH_MONTH));
  const added = s.children.added.map((c) => c.born);
  const careLedger = ctx.facts.childcare?.annual ?? 0;
  const nowShare = today.reduce((t, b) => t + careShare(model.careBands, ageIn(b, f.startKey)), 0);
  const carePerChild = model.carePerChild ?? (careLedger > 0 && nowShare > 0 ? careLedger / nowShare : model.carePerChildDefault);
  const careFrom = model.carePerChild != null ? "TYPED" : careLedger > 0 && nowShare > 0 ? "LEDGER" : "DEFAULT";
  const careStops = s.people.filter((c) => c.stop?.endsCare).map((c) => c.stop!.from).sort()[0] ?? null;

  // Housing: the rent inside today's living cost, and a purchase.
  const rent = model.rent ?? ctx.facts.housing?.monthly ?? 0;
  const rentFrom = model.rent != null ? "TYPED" : ctx.facts.housing ? "LEDGER" : "NONE";
  const rentGrowth = s.housing.rentGrowth ?? livingGrowth;
  const buy = s.housing.buy;
  const loan = buy ? Math.round(buy.price * (1 - buy.downPct)) : 0;
  const payment = buy ? fixedMonthlyPayment(loan, buy.rate, buy.termYears * 12) : 0;
  const appreciation = buy?.appreciation ?? inflation;
  let homeValue = 0;
  let owed = 0;

  const adjust: Record<string, MonthAdjust> = {};
  const extra = new Map<string, { childcare: number; housing: number; equity: number; tax: number }>();
  /** Per year: mortgage interest and property tax paid, scenario childcare paid. */
  const home = new Map<number, { interest: number; propertyTax: number; owedAvg: number }>();

  const firstMonth = base.start.month + 1;
  const careIn = (key: string, i: number, scenario: boolean) => {
    if (!scenario) return careLedger * grow(1, livingGrowth, i);
    if (careStops && key >= careStops) return 0;
    const ofToday = s.children.ageOut ? today.reduce((t, b) => t + careShare(model.careBands, ageIn(b, key)), 0) * carePerChild : careLedger;
    const ofAdded = added.reduce((t, b) => t + careShare(model.careBands, ageIn(b, key)), 0) * carePerChild;
    return (ofToday + ofAdded) * grow(1, livingGrowth, i);
  };

  for (let year = startYear; year <= horizon; year++) {
    const i = year - startYear;
    const from = year === startYear ? firstMonth : 1;
    // The year's tax, with the scenario and without it (both on the same footing, so only the change counts).
    const idx = (1 + inflation) ** (year - ctx.params.year);
    const deflate = (c: number) => Math.round(c / idx);
    let interestY = 0;
    let propertyTaxY = 0;
    let owedSum = 0;
    let owedMonths = 0;

    const monthRows: { key: string; m: number; sal: number[]; base: number[]; careS: number; careB: number; rentS: number; rentB: number; homeCost: number; other: number; planned: number; equity: number }[] = [];
    for (let m = 1; m <= 12; m++) {
      const key = keyOf(year, m);
      const sal = people.map((p) => monthly(annualPay(base, p, changes.get(p.personId), year, key), m));
      const baseSal = people.map((p) => monthly(grow(p.salary, base.salaryGrowth, i), m));
      const careS = monthly(careIn(key, i, true), m);
      const careB = monthly(careIn(key, i, false), m);
      const bought = buy != null && key > buy.at;
      const rentS = bought ? 0 : monthly(rent * 12 * grow(1, rentGrowth, i), m);
      const rentB = monthly(rent * 12 * grow(1, livingGrowth, i), m);
      let homeCost = 0;
      let planned = s.spending.oneOffs.filter((o) => o.at === key).reduce((t, o) => t + o.amount, 0);
      if (buy && key === buy.at) {
        homeValue = buy.price;
        owed = loan;
        planned += Math.round(buy.price * buy.downPct) + Math.round(buy.price * buy.closingPct);
      } else if (bought) {
        const yearsIn = monthsBetween(buy.at, key) / 12;
        homeValue *= (1 + appreciation) ** (1 / 12);
        const interest = owed * (buy.rate / 12);
        const principal = owed > 0 ? Math.min(owed, payment - interest) : 0;
        const pAndI = owed > 0 ? interest + principal : 0;
        owed = Math.max(0, owed - principal);
        const propertyTax = (homeValue * buy.taxRate) / 12;
        homeCost = Math.round(pAndI + propertyTax + (buy.insurance / 12 + buy.hoa + buy.utilities) * grow(1, inflation, Math.floor(yearsIn)) + (homeValue * buy.upkeepRate) / 12);
        interestY += owed > 0 || principal > 0 ? interest : 0;
        propertyTaxY += propertyTax;
        owedSum += owed;
        owedMonths++;
      }
      const other = added.reduce((t, b) => {
        const age = ageIn(b, key);
        return t + (age != null && age < model.otherUntilAge ? monthly(model.otherPerChild * grow(1, inflation, i), m) : 0);
      }, 0);
      monthRows.push({ key, m, sal, base: baseSal, careS, careB, rentS, rentB, homeCost, other, planned, equity: buy && key >= buy.at ? Math.round(homeValue - owed) : 0 });
    }
    home.set(year, { interest: interestY, propertyTax: propertyTaxY, owedAvg: owedMonths ? owedSum / owedMonths : 0 });

    // Tax for the year: today's plan's config and the scenario's.
    const salY = people.map((_, k) => monthRows.reduce((t, r) => t + r.sal[k]!, 0));
    const baseY = people.map((_, k) => monthRows.reduce((t, r) => t + r.base[k]!, 0));
    const depAges = (withAdded: boolean) =>
      [...today, ...(withAdded ? added : [])]
        .map((b) => ageIn(b, keyOf(year, 12)))
        .filter((a): a is number => a != null && a <= DEPENDENT_THROUGH_AGE)
        .sort((a, b) => a - b);
    /** `scenario`: the scenario's deductions, dependents and childcare; `pay`: its pay (defaults to the same). */
    const cfg = (scenario: boolean, withPay = scenario): TaxConfig => {
      const pay = withPay ? salY : baseY;
      const interestCap = home.get(year)!.owedAvg > MORTGAGE_INTEREST_DEBT_CAP ? MORTGAGE_INTEREST_DEBT_CAP / home.get(year)!.owedAvg : 1;
      return {
        people: people.map((p, k) => {
          const scale = grow(1, base.salaryGrowth, i);
          const down = baseY[k]! > 0 ? Math.min(1, pay[k]! / baseY[k]!) : 0;
          return { salary: deflate(pay[k]!), k401Pretax: deflate(p.k401Pretax * scale * down), hsa: deflate(p.hsa * scale * down), section125: deflate(p.section125 * scale * down) };
        }),
        deps: depAges(scenario),
        mortgageInterest: scenario ? deflate(interestY * interestCap) : 0,
        propertyTax: scenario ? deflate(propertyTaxY) : 0,
        care: deflate(monthRows.reduce((t, r) => t + (scenario ? r.careS : r.careB), 0)),
      };
    };
    const tB = Math.round(taxOf(ctx, people, cfg(false)) * idx);
    const tS = Math.round(taxOf(ctx, people, cfg(true)) * idx);
    // The change split in two, each falling in the months it belongs to: the tax on the
    // changed pay in the months pay changed, the rest (a mortgage, a child, childcare) in the
    // months those apply. A year's change never lands in months before it happened.
    const tPay = tS === tB ? tB : Math.round(taxOf(ctx, people, cfg(false, true)) * idx);
    const payTax = spread(
      tPay - tB,
      monthRows.map((r) => Math.abs(r.sal.reduce((t, v, k) => t + v - r.base[k]!, 0))),
    );
    const otherTax = spread(
      tS - tPay,
      monthRows.map((r) => (r.careS !== r.careB || r.homeCost !== 0 || added.some((b) => b <= r.key) ? 1 : 0)),
    );

    for (const [k, r] of monthRows.entries()) {
      const taxDelta = payTax[k]! + otherTax[k]!;
      if (r.m < from) continue;
      const dSal = r.sal.map((v, k) => v - r.base[k]!);
      const cut = dSal.map((d) => Math.min(0, d));
      const a: MonthAdjust = {
        salary: dSal.reduce((t, d) => t + d, 0),
        takeHome: dSal.reduce((t, d) => t + d, 0) - cut.reduce((t, d, p) => t + Math.round(d * rates[p]!.ded), 0) - taxDelta,
        deferrals: cut.reduce((t, d, p) => t + Math.round(d * rates[p]!.def), 0),
        employerMatch: cut.reduce((t, d, p) => t + Math.round(d * rates[p]!.emp), 0),
        living: r.careS - r.careB + r.rentS - r.rentB + r.homeCost + r.other,
        planned: r.planned,
      };
      if (Object.values(a).some((v) => v !== 0)) adjust[r.key] = a;
      extra.set(r.key, { childcare: r.careS, housing: r.rentS + r.homeCost, equity: r.equity, tax: monthly(tB, r.m) + taxDelta });
    }
  }

  const plan: OutlookPlan = {
    ...base,
    horizonYear: horizon,
    livingCost,
    livingGrowth,
    inflation,
    returnRate,
    walkAwayYear: null,
    bonus: null,
    ...(Object.keys(adjust).length ? { adjust } : {}),
  };
  const payments = scenarioBonuses(ctx, s, base);
  if (payments.length) {
    const keepRate = base.bonus?.keepRate ?? (f.pay.bonus.keepRate > 0 ? f.pay.bonus.keepRate : base.takeHomeRate);
    plan.bonus = { payments, keepRate, savedShare: base.bonus?.savedShare ?? f.assumptions.bonus.savedShare };
  }
  const { months: outlook, years: oy } = projectOutlook(plan);

  const months: RunMonth[] = outlook.map((o) => {
    const x = extra.get(o.key) ?? { childcare: 0, housing: 0, equity: 0, tax: 0 };
    return {
      key: o.key,
      year: o.year,
      month: o.month,
      gross: o.salary + o.bonusGross,
      tax: (o.working ? x.tax : 0) + (o.bonusGross - o.bonusKept),
      takeHome: o.takeHome + o.bonusKept,
      employerMatch: o.employerMatch,
      spending: o.livingCost + o.planned,
      childcare: x.childcare,
      housing: x.housing,
      saved: o.saved,
      liquid: o.liquid,
      illiquid: o.illiquid,
      equity: x.equity,
      netWorth: o.netWorth + x.equity,
    };
  });
  const years: RunYear[] = oy.map((y) => {
    const ms = months.filter((m) => m.year === y.year);
    const sum = (k: keyof RunMonth) => ms.reduce((t, m) => t + (m[k] as number), 0);
    const last = ms.at(-1)!;
    return { year: y.year, months: y.months, gross: sum("gross"), tax: sum("tax"), takeHome: sum("takeHome"), spending: sum("spending"), saved: sum("saved"), liquid: y.liquid, illiquid: y.illiquid, equity: last.equity, netWorth: last.netWorth };
  });

  return {
    plan,
    outlook,
    months,
    years,
    fiYear: fiYearOf(plan, oy),
    firstChange: firstChangeOf(s, f.startKey),
    used: { returnRate, inflation, livingGrowth, livingCost, carePerChild: Math.round(carePerChild), careFrom, rent, rentFrom },
  };
}

/**
 * The FIRE rule (profile/outlook.ts walkAwayTable): the first full year whose draw at the
 * withdrawal rate on January 1's invested money, after tax, covers that year's spending —
 * the plan's living cost plus what the scenario adds to it (childcare, a home's cost).
 * Home equity isn't drawn on.
 */
export function fiYearOf(plan: OutlookPlan, years: readonly OutlookYear[]): number | null {
  for (const y of years) {
    if (y.months !== 12 || y.year <= plan.start.year) continue;
    let spend = y.livingAnnual;
    if (plan.adjust) for (let m = 1; m <= 12; m++) spend += plan.adjust[keyOf(y.year, m)]?.living ?? 0;
    const draw = Math.round(Math.max(0, y.startNetWorth) * plan.withdrawalRate);
    const t = retirementTax(plan, y.year, draw);
    if (spend > 0 && t.afterTax / spend >= 1) return y.year;
  }
  return null;
}
