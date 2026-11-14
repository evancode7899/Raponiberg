import {
  FEDERAL_RATES,
  SAFE_HARBOR_RULES,
  type SafeHarborRules,
  type CtParams,
  type FederalParams,
  type FilingStatus,
  type NyParams,
  type RecaptureTier,
  type TaxYearParams,
} from "./params.ts";

/**
 * One federal + Connecticut (+ New York, for a year lived or worked there) return from already-totaled inputs. Pure: no database, no
 * projection. All money is integer cents; every intermediate figure the forms would show
 * is returned so the page can explain how each number was reached.
 */

/** One W-2 (or its year-end projection). */
export type W2 = {
  employer: string;
  /** Gross pay before any deduction (for effective-rate context only). */
  grossPay: number;
  box1Wages: number;
  box3SsWages: number;
  box5MedicareWages: number;
  box16StateWages: number;
  federalWithheld: number;
  ssWithheld: number;
  /** Box 6: regular 1.45% plus any 0.9% additional Medicare the employer withheld. */
  medicareWithheld: number;
  stateWithheld: number;
  /** New York State lines (box 16/17 for NY) and New York City tax withheld (box 19). */
  nyStateWages?: number;
  nyWithheld?: number;
  nycWithheld?: number;
};

export type PersonIncome = {
  id: string;
  name: string;
  w2s: W2[];
  taxableInterest: number;
  /** Ordinary dividends (1099-DIV box 1a), including qualified. */
  ordinaryDividends: number;
  qualifiedDividends: number;
  /** 1099-DIV box 5 (REIT dividends): eligible for the 20% QBI deduction. */
  section199aDividends: number;
  taxExemptInterest: number;
  /** Interest/dividends from US obligations (Treasuries, government money funds): exempt in CT. */
  usObligationIncome: number;
  capitalGainDistributions: number;
  shortTermGain: number;
  longTermGain: number;
  foreignTaxPaid: number;
  /** Taxable IRA/pension distributions (after rollovers and basis). */
  retirementTaxable: number;
  otherIncome: number;
  /** Net qualified business income (Schedule C/K-1), if any. */
  businessIncome: number;
  /** Above-the-line: HSA contributions made outside payroll, deductible IRA, etc. */
  adjustments: number;
  ctChetContributions: number;
  ctOtherSubtractions: number;
  ctOtherAdditions: number;
  estimatedFederal: number;
  estimatedCt: number;
  mortgageInterest: number;
  propertyTax: number;
  charitableCash: number;
  charitableOther: number;
  otherItemized: number;
  dependentCareExpenses: number;
  dependentCareFsa: number;
  /** Tax owed to another state (e.g. NY nonresident) on income CT also taxes. */
  otherStateTax: number;
  /** State income tax paid this year for earlier years (deductible as SALT when paid). */
  priorYearStateTaxPaid: number;
  /**
   * Part-year or nonresident Connecticut filers (CT-1040NR/PY): income from Connecticut
   * sources, i.e. earned while a resident (or, as a nonresident, in Connecticut). The tax
   * is figured on the whole year's CT AGI, then cut to this share of it. Absent or null: a
   * full-year resident.
   */
  ctSourceIncome?: number | null;
  /**
   * Part-year or nonresident New York filers (IT-203): the New York amount column, i.e.
   * income received while a New York resident plus New York-source income after. A
   * part-year New York City resident uses the same figure for the City (IT-360.1).
   */
  nySourceIncome?: number | null;
  estimatedNy?: number;
  // ---- Partnership K-1s (tax/k1.ts), after the passive-loss limit (tax/passive.ts). All
  // absent on a return with none. Their interest, dividends, gains and foreign tax are in
  // the lines above with everything else's.
  /** Schedule E page 2: the partnerships' business and rental income the year allows, and guaranteed payments. */
  partnershipIncome?: number;
  /** The part of it that is investment income for the 3.8% tax: passive activities and funds that trade for their own account. */
  partnershipNii?: number;
  /** Schedule E page 1. */
  royalties?: number;
  /** Other portfolio income (Schedule 1 line 8z): ordinary, and investment income. */
  portfolioOtherIncome?: number;
  /** Parts of the long-term gain above taxed at no more than 28% and 25% (Schedule D Tax Worksheet). */
  collectiblesGain?: number;
  unrecaptured1250Gain?: number;
  /** Form 4952: deductible up to net investment income, and only when itemizing. */
  investmentInterestExpense?: number;
  /** Net earnings from self-employment before the 92.35% factor (K-1 box 14). */
  seEarnings?: number;
  /** Each trade or business for the 20% deduction (Form 8995-A). */
  qbiBusinesses?: QbiBusiness[];
  /** Foreign-source taxable income, and the part of foreignTaxPaid it belongs to (Form 1116 limits that part). */
  foreignSourceIncome?: number;
  foreignTaxSourced?: number;
  /** Form 6251 adjustments passed through (K-1 box 17). */
  amtAdjustments?: number;
  /** Connecticut's pass-through entity tax credit (Schedule CT-PE → CT-1040 line 20c): a payment. */
  ctPeCredit?: number;
  /** New York's pass-through entity tax credit (IT-653): a payment, and added back to New York income. */
  nyPtetCredit?: number;
};

/** One trade or business for the qualified business income deduction. */
export type QbiBusiness = {
  name: string;
  /** Qualified business income (a loss is negative). */
  income: number;
  w2Wages: number;
  /** Unadjusted basis immediately after acquisition of qualified property. */
  ubia: number;
  /** A specified service trade or business: phased out above the threshold. */
  sstb: boolean;
  /** The owner materially participates (the minimum deduction, from 2026, is for these). */
  active: boolean;
};

/** A person's other income as 1040 line 8 has it: typed and other income, with the K-1s' Schedule E and other portfolio income. */
export const additionalIncome = (p: PersonIncome): number => p.otherIncome + (p.partnershipIncome ?? 0) + (p.royalties ?? 0) + (p.portfolioOtherIncome ?? 0);

export type Dependent = { name: string; age: number };

export type ReturnInput = {
  params: TaxYearParams;
  filingStatus: FilingStatus;
  people: PersonIncome[];
  dependents: Dependent[];
  /** New York residency for the year; absent or null: no New York return. */
  ny?: NyFiling | null;
  /** AUTO picks the larger deduction; spouses filing separately must both itemize or both not. */
  itemizeMode?: "AUTO" | "ITEMIZE" | "STANDARD";
};

export type FederalResult = {
  wages: number;
  interest: number;
  ordinaryDividends: number;
  qualifiedDividends: number;
  capitalGainNet: number;
  capitalGainAllowed: number;
  capitalLossCarryover: number;
  retirementTaxable: number;
  /** 1040 line 8: Schedule E and every other kind of additional income. */
  otherIncome: number;
  /** Schedule 1 line 5, inside otherIncome: partnership income and royalties. */
  scheduleE: number;
  totalIncome: number;
  /** Adjustments, the deduction for half of self-employment tax included. */
  adjustments: number;
  /** Schedule SE: the tax (Schedule 2 line 4) and the half deducted (Schedule 1 line 15). */
  selfEmploymentTax: number;
  selfEmploymentDeduction: number;
  /** Net earnings from self-employment (92.35%), which the Additional Medicare tax counts after wages. */
  selfEmploymentNet: number;
  agi: number;
  standardDeduction: number;
  /** Form 4952: investment interest paid, and the part the year's investment income allows (deducted only when itemizing). */
  investmentInterest: { paid: number; investmentIncome: number; allowed: number };
  /** The long-term gain taxed at up to 25% and 28%, and the tax on it (inside preferentialTax). */
  rateGain: { unrecaptured1250: number; collectibles: number; tax: number };
  /** Form 8995-A: the business component and the REIT dividend component, before the taxable-income cap. */
  qbi: { business: number; reit: number; cap: number };
  /** Foreign tax paid, and the most the year lets it credit (Form 1116; null: not limited). */
  foreignTax: { paid: number; limit: number | null };
  itemized: {
    saltPaid: number;
    saltCap: number;
    salt: number;
    mortgageInterest: number;
    charitable: number;
    /** Investment interest (Form 4952), inside `other`'s neighbour on Schedule A line 9. */
    investmentInterest: number;
    other: number;
    limitation37: number;
    total: number;
  };
  itemizes: boolean;
  charitableNonItemizer: number;
  deduction: number;
  qbiDeduction: number;
  taxableIncome: number;
  preferentialIncome: number;
  ordinaryTax: number;
  preferentialTax: number;
  regularTax: number;
  amt: number;
  childTaxCredit: number;
  otherDependentCredit: number;
  dependentCareCredit: number;
  foreignTaxCredit: number;
  nonrefundableCredits: number;
  incomeTaxAfterCredits: number;
  additionalMedicareTax: number;
  niit: number;
  netInvestmentIncome: number;
  totalTax: number;
  withholding: number;
  additionalMedicareWithheld: number;
  excessSsCredit: number;
  refundableChildCredit: number;
  estimatedPayments: number;
  totalPayments: number;
  /** Positive: owe at filing; negative: refund. */
  balanceDue: number;
  marginalBracket: number;
};

export type CtResult = {
  federalAgi: number;
  additions: number;
  subtractions: number;
  chetDeduction: number;
  usObligationSubtraction: number;
  ctAgi: number;
  exemption: number;
  taxableIncome: number;
  initialTax: number;
  addBack: number;
  recapture: number;
  personalCreditRate: number;
  personalCredit: number;
  /** Part-year: income from Connecticut sources and its share of CT AGI (4 decimals, as the form rounds it); null for a full-year resident. */
  sourceIncome: number | null;
  incomePercentage: number | null;
  /** The full-year resident tax before the part-year share (CT-1040NR/PY line 8). */
  taxBeforeAllocation: number;
  taxBeforeCredits: number;
  otherStateCredit: number;
  childTaxCredit: number;
  totalTax: number;
  withholding: number;
  estimatedPayments: number;
  /** Pass-through entity tax credit (CT-1040 line 20c). */
  peCredit: number;
  totalPayments: number;
  balanceDue: number;
};

export type NyFiling = {
  state: "RESIDENT" | "PART_YEAR" | "NONRESIDENT";
  city: "RESIDENT" | "PART_YEAR" | "NONE";
  /** Months lived in New York City (part-year): prorates the City deduction, exemptions and fixed school credit. */
  cityMonths: number;
};

export type NyResult = {
  filing: NyFiling;
  federalAgi: number;
  /** Interest on US government obligations (exempt in New York). */
  subtractions: number;
  nyAgi: number;
  standardDeduction: number;
  dependentExemption: number;
  taxableIncome: number;
  /** Tax from the rate schedule alone, and what the tax computation worksheets add above $107,650 of AGI. */
  scheduleTax: number;
  recapture: number;
  /** New York State tax on all income (IT-201 line 39 / IT-203 line 44). */
  baseTax: number;
  /** IT-203: the New York amount column and its share of New York AGI (4 decimals); null for a full-year resident. */
  sourceIncome: number | null;
  incomePercentage: number | null;
  /** New York State tax (IT-201 line 46 / IT-203 line 50). */
  stateTax: number;
  city: {
    agi: number;
    deduction: number;
    dependentExemption: number;
    taxableIncome: number;
    tax: number;
    /** NYC school tax credit: the fixed amount (incomes up to $250k) and the rate reduction (City taxable income up to $500k). Both refundable. */
    schoolCredit: number;
    schoolRateReduction: number;
  } | null;
  cityTax: number;
  totalTax: number;
  withholding: number;
  cityWithholding: number;
  estimatedPayments: number;
  /** Pass-through entity tax credit (IT-653): added to New York income, then credited as paid. */
  ptetCredit: number;
  totalPayments: number;
  /** Positive: owe at filing; negative: refund. */
  balanceDue: number;
  /** State (times the New York share) plus City rate on the next dollar. */
  marginalRate: number;
};

export type FicaResult = {
  socialSecurity: number;
  medicare: number;
  /** Payroll contribution, not income tax; shown alongside. */
  ctPfml: number;
};

export type ReturnResult = {
  filingStatus: FilingStatus;
  people: string[];
  dependents: string[];
  grossPay: number;
  federal: FederalResult;
  ct: CtResult;
  /** New York State and City, for a year the household filed there; null otherwise. */
  ny: NyResult | null;
  fica: FicaResult;
  otherStateTax: number;
  /** Federal income tax + CT + New York + FICA + other states (before the refundable child credit and CT paid leave: see allTaxes). */
  totalTax: number;
  effective: {
    /** Federal income tax (incl. NIIT, additional Medicare) ÷ AGI. */
    federalOfAgi: number;
    ctOfCtAgi: number;
  };
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const total = (people: PersonIncome[], f: (p: PersonIncome) => number) => sum(people.map(f));
const r = Math.round;
const pos = (n: number) => Math.max(0, n);

export function computeReturn(input: ReturnInput): ReturnResult {
  const { params, filingStatus: fs, people, dependents } = input;
  const federal = computeFederal(params.federal, fs, people, dependents, input.itemizeMode ?? "AUTO");
  const ctSource = people.some((p) => p.ctSourceIncome != null) ? total(people, (p) => p.ctSourceIncome ?? 0) : null;
  const ny = input.ny ? computeNy(params.ny, fs, people, dependents, federal, input.ny) : null;
  // A Connecticut resident working in New York as a nonresident: New York's tax on that
  // income is credited against Connecticut's (Schedule 2).
  const nyCredit = ny && ny.filing.state === "NONRESIDENT" && ny.sourceIncome ? { tax: ny.stateTax, income: ny.sourceIncome } : null;
  const ct = computeCt(params.ct, fs, people, dependents, federal.agi, ctSource, nyCredit);
  const fica = computeFica(params, people);
  const otherStateTax = total(people, (p) => p.otherStateTax);
  const grossPay = total(people, (p) => sum(p.w2s.map((w) => w.grossPay)));
  const all = federal.totalTax + ct.totalTax + (ny?.totalTax ?? 0) + fica.socialSecurity + fica.medicare + otherStateTax;
  return {
    filingStatus: fs,
    people: people.map((p) => p.name),
    dependents: dependents.map((d) => d.name),
    grossPay,
    federal,
    ct,
    ny,
    fica,
    otherStateTax,
    totalTax: all,
    effective: {
      federalOfAgi: federal.agi > 0 ? federal.totalTax / federal.agi : 0,
      ctOfCtAgi: ct.ctAgi > 0 ? ct.totalTax / ct.ctAgi : 0,
    },
  };
}

// ---------------------------------------------------------------- federal

/** Tax on ordinary income from the bracket table. */
export function bracketTax(income: number, upperBounds: number[]): number {
  let tax = 0;
  let lower = 0;
  for (let i = 0; i < FEDERAL_RATES.length; i++) {
    const upper = upperBounds[i] ?? Infinity;
    if (income <= lower) break;
    tax += (Math.min(income, upper) - lower) * FEDERAL_RATES[i]!;
    lower = upper;
  }
  return r(tax);
}

/**
 * Every tax a return costs the household, the one "total tax" every page and proof shows:
 * federal income tax (with the 0.9% and 3.8% surtaxes) after every credit, refundable child
 * credit included, + Social Security + Medicare + Connecticut + CT paid leave + New York
 * State and City + other states.
 */
export function allTaxes(r: ReturnResult): number {
  return r.totalTax - r.federal.refundableChildCredit + r.fica.ctPfml;
}

export function marginalRate(income: number, upperBounds: number[]): number {
  const i = upperBounds.findIndex((u) => income <= u);
  return FEDERAL_RATES[i < 0 ? FEDERAL_RATES.length - 1 : i]!;
}

/**
 * Qualified Dividends and Capital Gain Tax Worksheet: ordinary income fills the brackets
 * first; preferential income stacks on top at 0% / 15% / 20%.
 */
export function taxWithPreferential(
  taxable: number,
  preferential: number,
  fp: FederalParams,
  fs: FilingStatus,
  /** Schedule D Tax Worksheet: the parts of the preferential income taxed at ordinary rates up to 25% and 28%. */
  rateGain: { unrecaptured1250: number; collectibles: number } = { unrecaptured1250: 0, collectibles: 0 },
): { ordinaryTax: number; preferentialTax: number; rateGainTax: number } {
  const pref = Math.min(pos(preferential), pos(taxable));
  const ordinary = taxable - pref;
  // The 25% and 28% gains sit right on top of ordinary income; the 0% / 15% / 20% income stacks above them.
  const at25 = Math.min(pos(rateGain.unrecaptured1250), pref);
  const at28 = Math.min(pos(rateGain.collectibles), pref - at25);
  const below = ordinary + at25 + at28;
  const rest = pref - at25 - at28;
  const { zeroMax, fifteenMax } = fp.capitalGains[fs];
  const atZero = Math.min(rest, pos(Math.min(taxable, zeroMax) - below));
  const atFifteen = Math.min(rest - atZero, pos(Math.min(taxable, fifteenMax) - Math.max(below, zeroMax)));
  const atTwenty = rest - atZero - atFifteen;
  const b = fp.brackets[fs];
  const rateGainTax = cappedBracketTax(ordinary, ordinary + at25, b, RATE_GAIN_MAX.unrecaptured1250) + cappedBracketTax(ordinary + at25, below, b, RATE_GAIN_MAX.collectibles);
  return {
    ordinaryTax: bracketTax(ordinary, b),
    preferentialTax: r(atFifteen * fp.preferentialRates.fifteen + atTwenty * fp.preferentialRates.twenty) + rateGainTax,
    rateGainTax,
  };
}

/** The most unrecaptured section 1250 gain and collectibles gain are taxed at (section 1(h)). */
export const RATE_GAIN_MAX = { unrecaptured1250: 0.25, collectibles: 0.28 } as const;

/** Foreign tax up to this is credited without Form 1116 (section 904(j); never indexed). */
export const FOREIGN_TAX_NO_FORM = { joint: 60_000, other: 30_000 } as const;

/** Schedule SE's factor on net earnings (the employer-equivalent half comes off first), and the least it taxes. */
export const SE_FACTOR = 0.9235;
export const SE_MINIMUM = 40_000;

/** Tax on the income between `from` and `to` at the bracket rates, none above `cap`. */
export function cappedBracketTax(from: number, to: number, upperBounds: number[], cap: number): number {
  let tax = 0;
  let lower = 0;
  for (let i = 0; i < FEDERAL_RATES.length; i++) {
    const upper = upperBounds[i] ?? Infinity;
    tax += pos(Math.min(to, upper) - Math.max(from, lower)) * Math.min(FEDERAL_RATES[i]!, cap);
    lower = upper;
  }
  return r(tax);
}

/** Schedule SE for one person: net earnings (92.35%), and the tax (12.4% up to what the wage base leaves after W-2 wages, 2.9% on all). */
function selfEmployment(fp: FederalParams, p: PersonIncome): { net: number; tax: number } {
  const net = r(pos(p.seEarnings ?? 0) * SE_FACTOR);
  if (net < SE_MINIMUM) return { net: 0, tax: 0 };
  const room = pos(fp.socialSecurity.wageBase - sum(p.w2s.map((w) => w.box3SsWages)));
  return { net, tax: r(Math.min(net, room) * fp.socialSecurity.rate * 2) + r(net * fp.medicareRate * 2) };
}

/**
 * Form 8995-A, business by business: 20% of its income; above the threshold, no more than
 * the greater of 50% of its W-2 wages or 25% of them plus 2.5% of its property, the cut
 * phased in across the range; a specified service business phased out across it. A
 * business's loss reduces the others' income in proportion. `minimum` is the least the
 * deduction can be (from 2026, with enough income from businesses the owner works in).
 */
export function qbiBusinessComponent(fp: FederalParams, fs: FilingStatus, taxableBefore: number, businesses: QbiBusiness[]): { component: number; minimum: number } {
  const gains = businesses.filter((b) => b.income > 0);
  const loss = -sum(businesses.filter((b) => b.income < 0).map((b) => b.income));
  const gainTotal = sum(gains.map((b) => b.income));
  const keep = gainTotal > 0 ? pos(1 - loss / gainTotal) : 0;
  const over = fp.qbiPhaseIn[fs] > 0 ? Math.min(1, pos(taxableBefore - fp.qbiThreshold[fs]) / fp.qbiPhaseIn[fs]) : taxableBefore > fp.qbiThreshold[fs] ? 1 : 0;
  let component = 0;
  for (const b of gains) {
    // A service business counts only for the share of the range not yet passed.
    const share = b.sstb ? 1 - over : 1;
    const twenty = 0.2 * b.income * keep * share;
    const limit = Math.max(0.5 * b.w2Wages, 0.25 * b.w2Wages + 0.025 * b.ubia) * share;
    component += over === 0 || limit >= twenty ? twenty : twenty - (twenty - limit) * over;
  }
  const active = sum(businesses.filter((b) => b.active).map((b) => b.income));
  const minimum = fp.qbiMinimum && active >= fp.qbiMinimum.activeIncome ? fp.qbiMinimum.deduction : 0;
  return { component: r(component), minimum };
}

function computeFederal(
  fp: FederalParams,
  fs: FilingStatus,
  people: PersonIncome[],
  dependents: Dependent[],
  itemizeMode: "AUTO" | "ITEMIZE" | "STANDARD",
): FederalResult {
  const w2s = people.flatMap((p) => p.w2s);
  const wages = sum(w2s.map((w) => w.box1Wages));
  const interest = total(people, (p) => p.taxableInterest);
  const ordinaryDividends = total(people, (p) => p.ordinaryDividends);
  const qualifiedDividends = Math.min(ordinaryDividends, total(people, (p) => p.qualifiedDividends));
  const shortTerm = total(people, (p) => p.shortTermGain);
  const longTerm = total(people, (p) => p.longTermGain + p.capitalGainDistributions);
  const capitalGainNet = shortTerm + longTerm;
  const capitalGainAllowed = Math.max(capitalGainNet, -fp.capitalLossLimit[fs]);
  const retirementTaxable = total(people, (p) => p.retirementTaxable);
  // Partnership K-1s: Schedule E (business, rental and royalty income) and other portfolio income.
  const royalties = total(people, (p) => p.royalties ?? 0);
  const scheduleE = total(people, (p) => p.partnershipIncome ?? 0) + royalties;
  const portfolioOther = total(people, (p) => p.portfolioOtherIncome ?? 0);
  const otherIncome = total(people, (p) => p.otherIncome + p.businessIncome) + scheduleE + portfolioOther;
  const totalIncome = wages + interest + ordinaryDividends + capitalGainAllowed + retirementTaxable + otherIncome;
  // Schedule SE, person by person: 92.35% of net earnings, Social Security up to what the wage base leaves after W-2 wages.
  const se = people.map((p) => selfEmployment(fp, p));
  const selfEmploymentTax = sum(se.map((x) => x.tax));
  const selfEmploymentDeduction = sum(se.map((x) => r(x.tax / 2)));
  const adjustments = total(people, (p) => p.adjustments) + selfEmploymentDeduction;
  const agi = totalIncome - adjustments;

  // Itemized deductions (Schedule A).
  const saltPaid = total(
    people,
    (p) => p.propertyTax + sum(p.w2s.map((w) => w.stateWithheld + (w.nyWithheld ?? 0) + (w.nycWithheld ?? 0))) + p.estimatedCt + (p.estimatedNy ?? 0) + p.otherStateTax + p.priorYearStateTaxPaid,
  );
  const saltCap = Math.max(fp.salt.floor[fs], fp.salt.cap[fs] - r(fp.salt.phaseoutRate * pos(agi - fp.salt.phaseoutStart[fs])));
  const salt = Math.min(saltPaid, saltCap);
  const mortgageInterest = total(people, (p) => p.mortgageInterest);
  const charitableGiven = total(people, (p) => p.charitableCash + p.charitableOther);
  const charitable = pos(charitableGiven - r(fp.charitableAgiFloor * pos(agi)));
  const otherItemized = total(people, (p) => p.otherItemized);
  // Form 4952: investment interest, up to the year's investment income. Qualified dividends
  // and net capital gain stay out of it (no election to give up their lower rates).
  const netCapitalGain = pos(Math.min(longTerm, capitalGainNet));
  const investmentInterestPaid = total(people, (p) => p.investmentInterestExpense ?? 0);
  const investmentIncome4952 = pos(interest + ordinaryDividends - qualifiedDividends + portfolioOther + pos(capitalGainNet) - netCapitalGain);
  const investmentInterestAllowed = Math.min(investmentInterestPaid, investmentIncome4952);
  const itemizedBefore = salt + mortgageInterest + charitable + investmentInterestAllowed + otherItemized;
  const top = fp.brackets[fs].at(-1)!;
  const limitation37 = fp.itemizedLimitation37 ? r((2 / 37) * Math.min(itemizedBefore, pos(agi - top))) : 0;
  const itemizedTotal = itemizedBefore - limitation37;
  const standardDeduction = fp.standardDeduction[fs];
  const itemizes = itemizeMode === "ITEMIZE" || (itemizeMode === "AUTO" && itemizedTotal > standardDeduction);
  const charitableNonItemizer = itemizes ? 0 : Math.min(total(people, (p) => p.charitableCash), fp.charitableNonItemizer[fs]);
  const deduction = (itemizes ? itemizedTotal : standardDeduction) + charitableNonItemizer;

  // Preferential income: qualified dividends + net long-term gain (when the year nets positive).
  const netCapitalGainForRates = pos(Math.min(longTerm, capitalGainAllowed));
  const preferentialBase = qualifiedDividends + netCapitalGainForRates;

  // QBI: 20% of REIT dividends and (below-threshold) business income, capped at 20% of
  // taxable income less net capital gain.
  const tiBeforeQbi = pos(agi - deduction);
  const qbiBase = total(people, (p) => p.section199aDividends) + (tiBeforeQbi <= fp.qbiThreshold[fs] ? total(people, (p) => p.businessIncome) : 0);
  // Each K-1 business by Form 8995-A (wage and property limit, phased in above the threshold).
  const qbiBusiness = qbiBusinessComponent(fp, fs, tiBeforeQbi, people.flatMap((p) => p.qbiBusinesses ?? []));
  const qbiCap = r(0.2 * pos(tiBeforeQbi - preferentialBase));
  const qbiDeduction = Math.max(r(Math.min(0.2 * pos(qbiBase) + qbiBusiness.component, qbiCap)), Math.min(qbiBusiness.minimum, tiBeforeQbi));
  const taxableIncome = pos(tiBeforeQbi - qbiDeduction);

  const preferentialIncome = Math.min(preferentialBase, taxableIncome);
  // Schedule D Tax Worksheet: of the long-term gain, unrecaptured section 1250 gain is taxed at no more than 25% and collectibles gain at no more than 28%.
  const unrecaptured1250 = Math.min(pos(total(people, (p) => p.unrecaptured1250Gain ?? 0)), netCapitalGainForRates);
  const collectibles = Math.min(pos(total(people, (p) => p.collectiblesGain ?? 0)), netCapitalGainForRates - unrecaptured1250);
  const { ordinaryTax, preferentialTax, rateGainTax } = taxWithPreferential(taxableIncome, preferentialIncome, fp, fs, { unrecaptured1250, collectibles });
  const regularTax = ordinaryTax + preferentialTax;

  // AMT (Form 6251, simplified): add back the standard deduction or the SALT deduction, and the K-1s' own adjustments.
  const amti = taxableIncome + (itemizes ? salt : standardDeduction) + total(people, (p) => p.amtAdjustments ?? 0);
  const exemption = pos(fp.amt.exemption[fs] - r(fp.amt.phaseoutRate * pos(amti - fp.amt.phaseoutStart[fs])));
  const amtBase = pos(amti - exemption);
  const amtPref = Math.min(preferentialIncome, amtBase);
  const amtOrdinary = amtBase - amtPref;
  const b28 = fp.amt.rate28Above[fs];
  const tmtOrdinary = r(Math.min(amtOrdinary, b28) * fp.amtRates.low + pos(amtOrdinary - b28) * fp.amtRates.high);
  const tmt = tmtOrdinary + taxWithPreferential(amtBase, amtPref, fp, fs).preferentialTax;
  const amt = pos(tmt - regularTax);

  // Credits.
  const kids = dependents.filter((d) => d.age < 17).length;
  const others = dependents.length - kids;
  const reduction = fp.ctcPhaseout.per * Math.ceil(pos(agi - fp.childTaxCredit.phaseoutStart[fs]) / fp.ctcPhaseout.step);
  const ctcTentative = kids * fp.childTaxCredit.perChild + others * fp.childTaxCredit.otherDependent;
  const ctcAllowed = pos(ctcTentative - reduction);
  const ctcShare = ctcTentative > 0 ? (kids * fp.childTaxCredit.perChild) / ctcTentative : 0;

  const dependentCareCredit = fs === "MFS" || kids === 0 ? 0 : careCredit(fp, fs, agi, people, Math.min(kids, 2));
  // Foreign tax credit. Up to $300 ($600 joint) is credited in full without Form 1116. Above
  // that, the tax whose foreign-source income is known (the K-1s', from Schedule K-3) is
  // limited to US tax × foreign-source ÷ total taxable income; the rest (a brokerage 1099
  // prints the tax but not its income) is credited as paid.
  const foreignTaxPaid = total(people, (p) => p.foreignTaxPaid);
  const foreignTaxSourced = Math.min(foreignTaxPaid, total(people, (p) => p.foreignTaxSourced ?? 0));
  const foreignSourceIncome = pos(total(people, (p) => p.foreignSourceIncome ?? 0));
  const foreignLimited = foreignTaxSourced > 0 && foreignTaxPaid > FOREIGN_TAX_NO_FORM[fs === "MFJ" ? "joint" : "other"];
  const foreignLimit = foreignLimited ? r(regularTax * (taxableIncome > 0 ? Math.min(1, foreignSourceIncome / taxableIncome) : 0)) : null;
  const foreignTaxCredit = foreignLimit == null ? foreignTaxPaid : Math.min(foreignTaxSourced, foreignLimit) + (foreignTaxPaid - foreignTaxSourced);

  let taxLeft = regularTax + amt;
  const take = (n: number) => {
    const used = Math.min(n, taxLeft);
    taxLeft -= used;
    return used;
  };
  const foreignUsed = take(foreignTaxCredit);
  const careUsed = take(dependentCareCredit);
  const ctcUsed = take(ctcAllowed);
  const childTaxCredit = r(ctcUsed * ctcShare);
  const otherDependentCredit = ctcUsed - childTaxCredit;
  const earned = wages;
  const refundableChildCredit = Math.min(
    pos(r(ctcAllowed * ctcShare) - childTaxCredit),
    kids * fp.childTaxCredit.refundablePerChild,
    r(fp.ctcRefundable.rate * pos(earned - fp.ctcRefundable.earnedFloor)),
  );
  const nonrefundableCredits = foreignUsed + careUsed + ctcUsed;
  const incomeTaxAfterCredits = regularTax + amt - nonrefundableCredits;

  // Additional Medicare (Form 8959) and NIIT (Form 8960).
  const medicareWages = sum(w2s.map((w) => w.box5MedicareWages));
  // Form 8959 counts self-employment earnings after wages toward the same threshold.
  const additionalMedicareTax = r(fp.additionalMedicareRate * pos(medicareWages + sum(se.map((x) => x.net)) - fp.surtaxThreshold[fs]));
  const additionalMedicareWithheld = sum(w2s.map((w) => pos(w.medicareWithheld - r(w.box5MedicareWages * fp.medicareRate))));
  // Form 8960: with royalties, other portfolio income, and partnership income from passive
  // activities and trading funds; less the investment interest deducted.
  const netInvestmentIncome = pos(interest + ordinaryDividends + capitalGainAllowed + royalties + portfolioOther + total(people, (p) => p.partnershipNii ?? 0) - (itemizes ? investmentInterestAllowed : 0));
  const niit = r(fp.niitRate * Math.min(netInvestmentIncome, pos(agi - fp.surtaxThreshold[fs])));

  const totalTax = incomeTaxAfterCredits + selfEmploymentTax + additionalMedicareTax + niit;
  const withholding = sum(w2s.map((w) => w.federalWithheld));
  const excessSsCredit = sum(
    people.map((p) => (p.w2s.length > 1 ? pos(sum(p.w2s.map((w) => w.ssWithheld)) - r(fp.socialSecurity.wageBase * fp.socialSecurity.rate)) : 0)),
  );
  const estimatedPayments = total(people, (p) => p.estimatedFederal);
  const totalPayments = withholding + additionalMedicareWithheld + excessSsCredit + refundableChildCredit + estimatedPayments;

  return {
    wages,
    interest,
    ordinaryDividends,
    qualifiedDividends,
    capitalGainNet,
    capitalGainAllowed,
    capitalLossCarryover: capitalGainNet - capitalGainAllowed,
    retirementTaxable,
    otherIncome,
    scheduleE,
    totalIncome,
    adjustments,
    selfEmploymentTax,
    selfEmploymentDeduction,
    selfEmploymentNet: sum(se.map((x) => x.net)),
    agi,
    standardDeduction,
    investmentInterest: { paid: investmentInterestPaid, investmentIncome: investmentIncome4952, allowed: investmentInterestAllowed },
    rateGain: { unrecaptured1250, collectibles, tax: rateGainTax },
    qbi: { business: qbiBusiness.component, reit: r(0.2 * pos(qbiBase)), cap: qbiCap },
    foreignTax: { paid: foreignTaxPaid, limit: foreignLimit },
    itemized: { saltPaid, saltCap, salt, mortgageInterest, charitable, investmentInterest: investmentInterestAllowed, other: otherItemized, limitation37, total: itemizedTotal },
    itemizes,
    charitableNonItemizer,
    deduction,
    qbiDeduction,
    taxableIncome,
    preferentialIncome,
    ordinaryTax,
    preferentialTax,
    regularTax,
    amt,
    childTaxCredit,
    otherDependentCredit,
    dependentCareCredit: careUsed,
    foreignTaxCredit: foreignUsed,
    nonrefundableCredits,
    incomeTaxAfterCredits,
    additionalMedicareTax,
    niit,
    netInvestmentIncome,
    totalTax,
    withholding,
    additionalMedicareWithheld,
    excessSsCredit,
    refundableChildCredit,
    estimatedPayments,
    totalPayments,
    balanceDue: totalTax - totalPayments,
    marginalBracket: marginalRate(pos(taxableIncome - preferentialIncome), fp.brackets[fs]),
  };
}

function careCredit(fp: FederalParams, fs: FilingStatus, agi: number, people: PersonIncome[], kids: number): number {
  const limit = fp.dependentCare.expenseLimit[kids >= 2 ? 1 : 0];
  const expenses = total(people, (p) => p.dependentCareExpenses);
  const fsa = total(people, (p) => p.dependentCareFsa);
  const eligible = pos(Math.min(expenses, limit) - fsa);
  const steps = (over: number, per: number) => Math.ceil(pos(over) / per);
  const s = fp.dependentCare.creditPct;
  let pct = Math.max(s.floor, s.top - steps(agi - s.over, s.step));
  if (s.second && agi > s.second.over[fs]) pct = Math.max(s.second.floor, pct - steps(agi - s.second.over[fs], s.second.step[fs]));
  return r((eligible * pct) / 100);
}

// ---------------------------------------------------------------- Connecticut

/** Table C / D lookup: `per` for each started `step` above `start`, up to `max`. */
export function tierAmount(agi: number, t: RecaptureTier): number {
  if (agi <= t.start) return 0;
  return Math.min(t.max, Math.ceil((agi - t.start) / t.step) * t.per);
}

function computeCt(
  cp: CtParams,
  fs: FilingStatus,
  people: PersonIncome[],
  dependents: Dependent[],
  federalAgi: number,
  sourceIncome: number | null,
  nyCredit: { tax: number; income: number } | null = null,
): CtResult {
  const chetDeduction = Math.min(total(people, (p) => p.ctChetContributions), cp.chetDeduction[fs]);
  const usObligationSubtraction = total(people, (p) => p.usObligationIncome);
  const subtractions = chetDeduction + usObligationSubtraction + total(people, (p) => p.ctOtherSubtractions);
  const additions = total(people, (p) => p.ctOtherAdditions);
  const ctAgi = federalAgi + additions - subtractions;
  // CT-1040NR/PY line 7: the tax tables are read at the greater of CT AGI and CT-source income.
  const tableAgi = sourceIncome == null ? ctAgi : Math.max(ctAgi, sourceIncome);
  return ctTax(cp, fs, people, dependents, federalAgi, { additions, subtractions, chetDeduction, usObligationSubtraction, ctAgi }, tableAgi, sourceIncome, nyCredit);
}

/**
 * Connecticut income tax on income that is all ordinary and all Connecticut AGI (a
 * retirement draw): Tables A–E, no credits beyond the personal credit. The outlook taxes
 * draws with it, so retirement uses the same law as the Taxes page.
 */
export function ctIncomeTax(cp: CtParams, fs: FilingStatus, agi: number): number {
  const zero = { additions: 0, subtractions: 0, chetDeduction: 0, usObligationSubtraction: 0, ctAgi: agi };
  return ctTax(cp, fs, [], [], agi, zero, agi, null, null).totalTax;
}

function ctTax(
  cp: CtParams,
  fs: FilingStatus,
  people: PersonIncome[],
  dependents: Dependent[],
  federalAgi: number,
  mods: { additions: number; subtractions: number; chetDeduction: number; usObligationSubtraction: number; ctAgi: number },
  agiForTables: number,
  sourceIncome: number | null,
  nyCredit: { tax: number; income: number } | null,
): CtResult {
  const { additions, subtractions, chetDeduction, usObligationSubtraction } = mods;
  const ctAgi = agiForTables;
  const ex = cp.exemption[fs];
  const exemption = pos(ex.amount - 100_000 * Math.ceil(pos(ctAgi - ex.phaseoutStart) / 100_000));
  const taxableIncome = pos(ctAgi - exemption);

  let initialTax = 0;
  let lower = 0;
  for (const [upper, rate] of cp.brackets[fs]) {
    if (taxableIncome <= lower) break;
    initialTax += (Math.min(taxableIncome, upper) - lower) * rate;
    lower = upper;
  }
  initialTax = r(initialTax);
  const addBack = tierAmount(ctAgi, cp.addBack[fs]);
  // Tiers are cumulative: each later tier starts from the previous tier's cap.
  let recapture = 0;
  for (const t of cp.recapture[fs]) {
    if (ctAgi > t.start) recapture = Math.min(t.max, recapture + Math.ceil((ctAgi - t.start) / t.step) * t.per);
  }
  const taxBefore = initialTax + addBack + recapture;
  const creditRow = cp.personalCredit[fs].find(([upper]) => ctAgi <= upper);
  const personalCreditRate = taxableIncome === 0 ? 0 : creditRow ? creditRow[1] : 0;
  const personalCredit = r(taxBefore * personalCreditRate);
  const taxBeforeAllocation = taxBefore - personalCredit;
  // Part-year (CT-1040NR/PY lines 9–10): the resident tax times CT-source income ÷ CT AGI,
  // a ratio the form rounds to four decimals and caps at 1.
  const incomePercentage = sourceIncome == null ? null : mods.ctAgi > 0 ? Math.min(1, Math.round((sourceIncome / mods.ctAgi) * 10_000) / 10_000) : 1;
  const taxBeforeCredits = incomePercentage == null ? taxBeforeAllocation : r(taxBeforeAllocation * incomePercentage);
  // Schedule 2: the lesser of the other state's tax and Connecticut's tax on the same income.
  const nyPart = nyCredit && mods.ctAgi > 0 ? Math.min(nyCredit.tax, r(taxBeforeCredits * Math.min(1, nyCredit.income / mods.ctAgi))) : 0;
  const otherStateCredit = Math.min(total(people, (p) => p.otherStateTax) + nyPart, taxBeforeCredits);

  let childTaxCredit = 0;
  const cc = cp.childCredit;
  if (cc) {
    const kids = Math.min(cc.maxChildren, dependents.filter((d) => d.age <= 16).length);
    const full = kids * cc.perChild;
    if (federalAgi <= cc.fullBelow[fs]) childTaxCredit = full;
    else if (federalAgi <= cc.zeroAbove[fs]) {
      const tenths = Math.ceil((federalAgi - cc.fullBelow[fs]) / 100_000);
      childTaxCredit = r(full * pos(1 - tenths / 10));
    }
  }

  const totalTax = taxBeforeCredits - otherStateCredit - childTaxCredit;
  const withholding = total(people, (p) => sum(p.w2s.map((w) => w.stateWithheld)));
  const estimatedPayments = total(people, (p) => p.estimatedCt);
  // Schedule CT-PE → CT-1040 line 20c: the pass-through entity tax a partnership paid for its members.
  const peCredit = total(people, (p) => p.ctPeCredit ?? 0);
  const totalPayments = withholding + estimatedPayments + peCredit;
  return {
    federalAgi,
    additions,
    subtractions,
    chetDeduction,
    usObligationSubtraction,
    ctAgi: mods.ctAgi,
    exemption,
    taxableIncome,
    initialTax,
    addBack,
    recapture,
    personalCreditRate,
    personalCredit,
    sourceIncome,
    incomePercentage,
    taxBeforeAllocation,
    taxBeforeCredits,
    otherStateCredit,
    childTaxCredit,
    totalTax,
    withholding,
    estimatedPayments,
    peCredit,
    totalPayments,
    balanceDue: totalTax - totalPayments,
  };
}

// ---------------------------------------------------------------- New York

/** Whole dollars, as the New York forms compute every line. */
const whole = (cents: number) => Math.round(cents / 100) * 100;

/** Below `below` the tax tables are used: the tax on the middle of the $50 band. */
const tableIncome = (ti: number, below: number) => (ti < below ? Math.floor(ti / 5_000) * 5_000 + 2_500 : ti);

/** Tax at the bracket rates, unrounded. */
function scheduleExact(ti: number, brackets: [number, number][]): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of brackets) {
    if (ti <= lower) break;
    tax += (Math.min(ti, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

/** A New York rate schedule as printed: each bracket's whole-dollar base amount plus its rate on the excess. */
export function nyScheduleTax(ti: number, brackets: [number, number][]): number {
  if (ti <= 0) return 0;
  const i = brackets.findIndex(([u]) => ti <= u);
  const lower = i > 0 ? brackets[i - 1]![0] : 0;
  return whole(whole(scheduleExact(lower, brackets)) + (ti - lower) * brackets[i]![1]);
}

/**
 * New York State tax on taxable income (IT-201 line 39, IT-203 line 38). Up to $107,650 of
 * New York AGI it's the tax table / rate schedule. Above, the tax computation worksheets
 * take back the lower brackets' benefit: with income in bracket k, the recapture base
 * (the brackets below k − 1, at k − 1's rate) plus the incremental benefit (bracket k − 1
 * at bracket k's rate), phased in over the next $50,000 of AGI. Taxable income up to the top
 * of the bracket holding $107,650 (the fourth jointly, the fifth for a single filer) moves to
 * that bracket's flat rate; above $25 million of AGI every dollar is at the top rate.
 */
export function nyStateTax(np: NyParams, fs: FilingStatus, nyAgi: number, ti: number): { schedule: number; recapture: number } {
  const b = np.brackets[fs];
  if (ti <= 0) return { schedule: 0, recapture: 0 };
  const schedule = nyScheduleTax(nyAgi <= np.recaptureAgi ? tableIncome(ti, np.tableBelow) : ti, b);
  if (nyAgi <= np.recaptureAgi) return { schedule, recapture: 0 };
  if (nyAgi > np.flatAbove) return { schedule, recapture: whole(ti * b.at(-1)![1]) - schedule };
  const k = b.findIndex(([u]) => ti <= u);
  const phase = (from: number) => Math.min(1, Math.round((pos(nyAgi - from) / np.recapturePhaseIn) * 10_000) / 10_000);
  const m = b.findIndex(([u]) => np.recaptureAgi <= u);
  if (k <= m) {
    // Worksheet 1: towards that bracket's rate on all of it, as AGI passes $107,650.
    const full = whole(ti * b[m]![1]);
    return { schedule, recapture: whole(pos(full - schedule) * phase(np.recaptureAgi)) };
  }
  const lower = b[k - 1]![0];
  const base = whole(lower * b[k - 1]![1] - scheduleExact(lower, b));
  const incremental = whole(lower * (b[k]![1] - b[k - 1]![1]));
  return { schedule, recapture: base + whole(incremental * phase(lower)) };
}

/** New York City resident tax: the City's rate schedule (tables below $65,000). */
export function nycTax(np: NyParams, fs: FilingStatus, ti: number): number {
  return nyScheduleTax(tableIncome(ti, np.tableBelow), np.nyc.brackets[fs]);
}

function computeNy(np: NyParams, fs: FilingStatus, people: PersonIncome[], dependents: Dependent[], federal: FederalResult, filing: NyFiling): NyResult {
  const federalAgi = federal.agi;
  const subtractions = total(people, (p) => p.usObligationIncome);
  // IT-653: the pass-through entity tax credit claimed is added back to income (IT-225), then credited as paid.
  const ptetCredit = total(people, (p) => p.nyPtetCredit ?? 0);
  const nyAgi = federalAgi - subtractions + ptetCredit;
  const standardDeduction = np.standardDeduction[fs];
  const dependentExemption = np.dependentExemption * dependents.length;
  const taxableIncome = pos(whole(nyAgi) - standardDeduction - dependentExemption);
  const { schedule, recapture } = nyStateTax(np, fs, nyAgi, taxableIncome);
  const baseTax = schedule + recapture;
  // IT-203 line 45: the New York amount ÷ the federal amount column, four decimals, at most 1.
  const sourceIncome = filing.state === "RESIDENT" ? null : total(people, (p) => p.nySourceIncome ?? 0);
  const incomePercentage = sourceIncome == null ? null : nyAgi > 0 ? Math.min(1, Math.max(0, Math.round((sourceIncome / whole(nyAgi)) * 10_000) / 10_000)) : 1;
  const stateTax = incomePercentage == null ? baseTax : whole(baseTax * incomePercentage);

  let city: NyResult["city"] = null;
  if (filing.city !== "NONE") {
    // A full-year resident's City taxable income is the State's; a part-year resident's
    // (IT-360.1) is the resident period's income less the deduction and exemptions
    // prorated by months lived in the City.
    const resident = filing.city === "RESIDENT";
    const share = resident ? 1 : Math.min(12, Math.max(0, filing.cityMonths)) / 12;
    const agi = resident ? whole(nyAgi) : (sourceIncome ?? whole(nyAgi));
    const deduction = resident ? standardDeduction : whole(standardDeduction * share);
    const exemption = resident ? dependentExemption : whole(np.dependentExemption * share) * dependents.length;
    const cityTaxable = resident ? taxableIncome : pos(agi - deduction - exemption);
    const sr = np.nyc.schoolRateReduction;
    const rateReduction =
      cityTaxable > sr.incomeLimit
        ? 0
        : cityTaxable <= sr.firstBand[fs]
          ? whole(cityTaxable * sr.firstRate)
          : whole(sr.base[fs] + (cityTaxable - sr.firstBand[fs]) * sr.rate);
    const fixed = federalAgi - federal.retirementTaxable <= np.nyc.schoolCredit.incomeLimit ? whole(np.nyc.schoolCredit.amount[fs] * share) : 0;
    city = { agi, deduction, dependentExemption: exemption, taxableIncome: cityTaxable, tax: nycTax(np, fs, cityTaxable), schoolCredit: fixed, schoolRateReduction: rateReduction };
  }
  const cityTax = city?.tax ?? 0;
  const totalTax = stateTax + cityTax;
  const withholding = total(people, (p) => sum(p.w2s.map((w) => w.nyWithheld ?? 0)));
  const cityWithholding = total(people, (p) => sum(p.w2s.map((w) => w.nycWithheld ?? 0)));
  const estimatedPayments = total(people, (p) => p.estimatedNy ?? 0);
  const totalPayments = withholding + cityWithholding + estimatedPayments + ptetCredit + (city ? city.schoolCredit + city.schoolRateReduction : 0);
  // The next dollar: the bracket reached (the worksheets make it the flat rate once phased in), plus the City's.
  const stateRate = np.brackets[fs].find(([u]) => taxableIncome <= u)?.[1] ?? 0;
  const cityRate = city ? (np.nyc.brackets[fs].find(([u]) => city!.taxableIncome <= u)?.[1] ?? 0) : 0;
  return {
    filing,
    federalAgi,
    subtractions,
    nyAgi,
    standardDeduction,
    dependentExemption,
    taxableIncome,
    scheduleTax: schedule,
    recapture,
    baseTax,
    sourceIncome,
    incomePercentage,
    stateTax,
    city,
    cityTax,
    totalTax,
    withholding,
    cityWithholding,
    estimatedPayments,
    ptetCredit,
    totalPayments,
    balanceDue: totalTax - totalPayments,
    marginalRate: stateRate * (incomePercentage ?? 1) + cityRate,
  };
}

// ---------------------------------------------------------------- payroll

function computeFica(params: TaxYearParams, people: PersonIncome[]): FicaResult {
  const fp = params.federal;
  const cap = fp.socialSecurity.wageBase;
  let socialSecurity = 0;
  let medicare = 0;
  let ctPfml = 0;
  for (const p of people) {
    const ssWages = Math.min(cap, sum(p.w2s.map((w) => w.box3SsWages)));
    socialSecurity += r(ssWages * fp.socialSecurity.rate);
    medicare += r(sum(p.w2s.map((w) => w.box5MedicareWages)) * fp.medicareRate);
    ctPfml += r(Math.min(cap, sum(p.w2s.map((w) => w.box3SsWages))) * params.ct.pfmlRate);
  }
  return { socialSecurity, medicare, ctPfml };
}

// ---------------------------------------------------------------- safe harbor

export type SafeHarbor = {
  currentYearTax: number;
  priorYearTax: number | null;
  priorYearPct: number;
  /** The two tests the safe harbor takes the smaller of: 90% of this year's tax, and 100%/110% of last year's (null without it). */
  currentYearTest: number;
  priorYearTest: number | null;
  /** The smaller of 90% of this year's tax and 100%/110% of last year's. */
  requiredAnnualPayment: number;
  basis: "CURRENT_90" | "PRIOR_YEAR";
  withholding: number;
  estimatesPaid: number;
  /** Additional payments needed to be penalty-proof. */
  shortfall: number;
  /** Owed at filing is under the de-minimis ($1,000) line: no penalty either way. */
  underDeMinimis: boolean;
};

/**
 * Underpayment-penalty safe harbor (federal Form 2210 / CT-2210). Withholding counts as
 * paid evenly through the year, so extra withholding late in the year still fully cures
 * a shortfall; a Q4 estimated payment only covers the January installment.
 */
export function safeHarbor(opts: {
  currentYearTax: number;
  withholding: number;
  estimatesPaid: number;
  priorYearTax: number | null;
  priorYearAgi: number | null;
  highAgiThreshold: number | null;
  rules?: SafeHarborRules;
}): SafeHarbor {
  const rules = opts.rules ?? SAFE_HARBOR_RULES;
  const ninety = r(opts.currentYearTax * rules.currentShare);
  const pct = opts.highAgiThreshold != null && opts.priorYearAgi != null && opts.priorYearAgi > opts.highAgiThreshold ? rules.priorShareHighAgi : rules.priorShare;
  const prior = opts.priorYearTax == null ? null : r(opts.priorYearTax * pct);
  const usePrior = prior != null && prior < ninety;
  const required = usePrior ? prior! : ninety;
  const paid = opts.withholding + opts.estimatesPaid;
  return {
    currentYearTax: opts.currentYearTax,
    priorYearTax: opts.priorYearTax,
    priorYearPct: pct,
    currentYearTest: ninety,
    priorYearTest: prior,
    requiredAnnualPayment: required,
    basis: usePrior ? "PRIOR_YEAR" : "CURRENT_90",
    withholding: opts.withholding,
    estimatesPaid: opts.estimatesPaid,
    shortfall: pos(required - paid),
    underDeMinimis: opts.currentYearTax - paid < rules.deMinimis,
  };
}
