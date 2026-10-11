import { computeReturn, type Dependent, type PersonIncome } from "../tax/computeReturn.ts";
import type { TaxYearParams } from "../tax/params.ts";
import type { LivingBasis, OutlookAssumptions, PaycheckBasis } from "./settings.ts";
import { DEFAULT_PERSON_OUTLOOK } from "./settings.ts";

/**
 * What the outlook stands on, and how base pay turns into take-home. Base pay is each
 * person's regular paycheck (no bonus) × paychecks a year; its taxes are worked out with
 * the real federal and Connecticut brackets and FICA, so the take-home rate is base pay's
 * own — not a blend with bonuses, which are taxed at a higher marginal rate. A bonus is a
 * separate layer: what it adds to the household's tax on top of base pay sets how much
 * of it is kept. Pure (no database), so the page recalculates as assumptions change.
 * All money is integer cents.
 */

export type PaycheckSeed = {
  payDate: string;
  /** Regular earnings on the check (no bonus, no reimbursements). */
  regular: number;
  /** Pre-tax health, FSA and dependent-care deductions (§125). */
  section125: number;
  /** Employee HSA (pre-tax). */
  hsa: number;
  /** After-tax deductions (insurance, ESPP…). */
  afterTax: number;
  /** Employer 401(k) and HSA money. */
  employer: number;
};

export type BonusYear = {
  year: number;
  salary: number;
  bonus: number;
  /** Bonus ÷ salary; for the year in progress, ÷ the base salary run rate. */
  pct: number | null;
  /** The year in progress (bonus paid so far). */
  partial: boolean;
};

export type PersonSeed = {
  personId: string;
  name: string;
  employer: string | null;
  /** Paychecks a year at the current employer (0 = no pay on file). */
  perYear: number;
  frequency: string | null;
  latest: PaycheckSeed | null;
  typical: PaycheckSeed | null;
  /** This year's 401(k) and HSA deferrals, to Dec 31, by paycheck basis (stubs so far + the rest of the year). */
  deferrals: Record<PaycheckBasis, { k401Pretax: number; k401Roth: number; hsa: number }>;
  bonusHistory: BonusYear[];
  /** Month (1–12) of the latest year's largest bonus; null = never paid one. */
  bonusMonth: number | null;
  /** Bonuses paid after the outlook's starting point: real money, but left out of the near term. */
  bonusesSinceStart: { payDate: string; gross: number }[];
  note: string;
};

export type LivingSeed = { cents: number; label: string; detail: string };

export type OutlookSeeds = {
  /** The latest proven net worth the projection starts from (end of `month`). */
  start: { asOf: string; year: number; month: number; liquid: number; illiquid: number; note: string };
  baseYear: number;
  currentYear: number;
  people: PersonSeed[];
  living: Partial<Record<LivingBasis, LivingSeed>>;
  realizedReturn: number | null;
  /** Tax law year used for pay (today's law) and the retirement-draw brackets. */
  taxYear: number;
  tax: { year: number; standardDeduction: number; brackets: number[] };
  dependents: Dependent[];
  birthYear: number | null;
};

// ---------------------------------------------------------------- tax on pay

export type PayForTax = {
  id: string;
  name: string;
  salary: number;
  bonus: number;
  k401Pretax: number;
  hsa: number;
  section125: number;
};

export type PayTax = { federal: number; ct: number; socialSecurity: number; medicare: number; pfml: number; total: number };

const ZERO_TAX: PayTax = { federal: 0, ct: 0, socialSecurity: 0, medicare: 0, pfml: 0, total: 0 };

function income(p: PayForTax, params: TaxYearParams): PersonIncome {
  const gross = p.salary + p.bonus;
  const box5 = Math.max(0, gross - p.section125 - p.hsa);
  const box1 = Math.max(0, box5 - p.k401Pretax);
  return {
    id: p.id,
    name: p.name,
    w2s: [
      {
        employer: "",
        grossPay: gross,
        box1Wages: box1,
        box3SsWages: Math.min(box5, params.federal.socialSecurity.wageBase),
        box5MedicareWages: box5,
        box16StateWages: box1,
        federalWithheld: 0,
        ssWithheld: 0,
        medicareWithheld: 0,
        stateWithheld: 0,
      },
    ],
    taxableInterest: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    section199aDividends: 0,
    taxExemptInterest: 0,
    usObligationIncome: 0,
    capitalGainDistributions: 0,
    shortTermGain: 0,
    longTermGain: 0,
    foreignTaxPaid: 0,
    retirementTaxable: 0,
    otherIncome: 0,
    businessIncome: 0,
    adjustments: 0,
    ctChetContributions: 0,
    ctOtherSubtractions: 0,
    ctOtherAdditions: 0,
    estimatedFederal: 0,
    estimatedCt: 0,
    mortgageInterest: 0,
    propertyTax: 0,
    charitableCash: 0,
    charitableOther: 0,
    otherItemized: 0,
    dependentCareExpenses: 0,
    dependentCareFsa: 0,
    otherStateTax: 0,
    priorYearStateTaxPaid: 0,
  };
}

/** Federal + CT income tax, Social Security, Medicare (incl. the 0.9% surtax) and CT paid leave on wages alone, filing jointly. */
export function taxOnPay(params: TaxYearParams, people: PayForTax[], dependents: Dependent[]): PayTax {
  const paid = people.filter((p) => p.salary + p.bonus > 0);
  if (!paid.length) return { ...ZERO_TAX };
  const r = computeReturn({ params, filingStatus: "MFJ", people: paid.map((p) => income(p, params)), dependents, itemizeMode: "STANDARD" });
  const t = { federal: r.federal.totalTax, ct: r.ct.totalTax, socialSecurity: r.fica.socialSecurity, medicare: r.fica.medicare, pfml: r.fica.ctPfml, total: 0 };
  t.total = t.federal + t.ct + t.socialSecurity + t.medicare + t.pfml;
  return t;
}

const minus = (a: PayTax, b: PayTax): PayTax => ({
  federal: a.federal - b.federal,
  ct: a.ct - b.ct,
  socialSecurity: a.socialSecurity - b.socialSecurity,
  medicare: a.medicare - b.medicare,
  pfml: a.pfml - b.pfml,
  total: a.total - b.total,
});

// ---------------------------------------------------------------- resolving the assumptions

export type ResolvedPerson = {
  personId: string;
  name: string;
  basis: PaycheckBasis;
  paycheck: PaycheckSeed | null;
  perYear: number;
  /** Annual base salary and where it came from. */
  salary: number;
  salaryTyped: boolean;
  /** Annual figures that ride on base pay. */
  section125: number;
  afterTax: number;
  employer: number;
  deferrals: number;
  k401Pretax: number;
  hsa: number;
  /** Long-term bonus: share of base, the default it fell back to, and gross at today's salary. */
  bonusPct: number;
  bonusPctTyped: boolean;
  bonusDefault: { pct: number; label: string };
  bonusGross: number;
  bonusMonth: number;
};

export type ResolvedBasePay = {
  people: ResolvedPerson[];
  salary: number;
  section125: number;
  afterTax: number;
  /** Household 401(k)/HSA deferrals and employer money: from stubs unless typed in. */
  deferrals: number;
  deferralsTyped: boolean;
  employer: number;
  employerTyped: boolean;
  tax: PayTax;
  /** Base salary − taxes − benefit and after-tax deductions (deferrals stay in: they're savings). */
  takeHome: number;
  computedRate: number;
  takeHomeRate: number;
  rateTyped: boolean;
  living: { cents: number; typed: boolean; seed: LivingSeed | null };
  bonus: {
    gross: number;
    /** Extra household tax a bonus of `gross` adds on top of base pay. */
    extraTax: PayTax;
    computedKeep: number;
    keepRate: number;
    keepTyped: boolean;
  };
};

/** The lowest bonus share of the last three complete years (conservative), or 0 with no history. */
export function defaultBonusPct(history: BonusYear[]): { pct: number; label: string } {
  const full = history.filter((h) => !h.partial && h.salary > 0 && h.pct != null).slice(-3);
  if (!full.length) return { pct: 0, label: "no bonus history" };
  const low = full.reduce((a, b) => (b.pct! < a.pct! ? b : a));
  return { pct: low.pct!, label: `lowest of ${full.map((h) => h.year).join(", ")} (${low.year})` };
}

export function resolveBasePay(seeds: OutlookSeeds, a: OutlookAssumptions, params: TaxYearParams): ResolvedBasePay {
  const people: ResolvedPerson[] = seeds.people.map((s) => {
    const o = a.people[s.personId] ?? DEFAULT_PERSON_OUTLOOK;
    const paycheck = (o.paycheck === "LATEST" ? s.latest : s.typical) ?? s.latest ?? s.typical;
    const fromCheck = paycheck ? paycheck.regular * s.perYear : 0;
    const salary = o.salary ?? fromCheck;
    // Benefit deductions and employer money are per paycheck; a typed salary scales the employer's share with it.
    const scale = fromCheck > 0 ? salary / fromCheck : 0;
    const d = s.deferrals[o.paycheck] ?? s.deferrals.TYPICAL;
    const cap = (n: number) => Math.min(n, Math.round(salary * 0.9));
    const k401Pretax = cap(d.k401Pretax);
    const hsa = Math.min(cap(d.hsa), salary - k401Pretax);
    const deferrals = Math.min(salary, k401Pretax + cap(d.k401Roth) + hsa);
    const bonusDefault = defaultBonusPct(s.bonusHistory);
    const bonusPct = o.bonusPct ?? bonusDefault.pct;
    return {
      personId: s.personId,
      name: s.name,
      basis: o.paycheck,
      paycheck,
      perYear: s.perYear,
      salary,
      salaryTyped: o.salary != null,
      section125: paycheck ? paycheck.section125 * s.perYear : 0,
      afterTax: paycheck ? paycheck.afterTax * s.perYear : 0,
      employer: paycheck ? Math.round(paycheck.employer * s.perYear * scale) : 0,
      deferrals,
      k401Pretax,
      hsa,
      bonusPct,
      bonusPctTyped: o.bonusPct != null,
      bonusDefault,
      bonusGross: Math.round(salary * bonusPct),
      bonusMonth: s.bonusMonth ?? 3,
    };
  });
  const sum = (f: (p: ResolvedPerson) => number) => people.reduce((t, p) => t + f(p), 0);
  const forTax = (withBonus: boolean): PayForTax[] =>
    people.map((p) => ({ id: p.personId, name: p.name, salary: p.salary, bonus: withBonus ? p.bonusGross : 0, k401Pretax: p.k401Pretax, hsa: p.hsa, section125: p.section125 }));
  const tax = taxOnPay(params, forTax(false), seeds.dependents);
  const salary = sum((p) => p.salary);
  const section125 = sum((p) => p.section125);
  const afterTax = sum((p) => p.afterTax);
  const takeHome = salary - tax.total - section125 - afterTax;
  const computedRate = salary > 0 ? Math.max(0, takeHome / salary) : 0;
  const bonusGross = sum((p) => p.bonusGross);
  const extraTax = bonusGross > 0 ? minus(taxOnPay(params, forTax(true), seeds.dependents), tax) : { ...ZERO_TAX };
  const computedKeep = bonusGross > 0 ? Math.max(0, 1 - extraTax.total / bonusGross) : 0;
  const livingSeed = seeds.living[a.livingBasis] ?? seeds.living.TRAILING_12 ?? seeds.living.LAST_YEAR ?? null;
  return {
    people,
    salary,
    section125,
    afterTax,
    deferrals: a.deferrals ?? sum((p) => p.deferrals),
    deferralsTyped: a.deferrals != null,
    employer: a.employerMatch ?? sum((p) => p.employer),
    employerTyped: a.employerMatch != null,
    tax,
    takeHome,
    computedRate,
    takeHomeRate: a.takeHomeRate ?? computedRate,
    rateTyped: a.takeHomeRate != null,
    living: { cents: a.livingCost ?? livingSeed?.cents ?? 0, typed: a.livingCost != null, seed: livingSeed },
    bonus: { gross: bonusGross, extraTax, computedKeep, keepRate: a.bonus.keepRate ?? computedKeep, keepTyped: a.bonus.keepRate != null },
  };
}
