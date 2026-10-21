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
};

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
  otherIncome: number;
  totalIncome: number;
  adjustments: number;
  agi: number;
  standardDeduction: number;
  itemized: {
    saltPaid: number;
    saltCap: number;
    salt: number;
    mortgageInterest: number;
    charitable: number;
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
  /** Federal income tax + CT + New York + FICA + other states. */
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
): { ordinaryTax: number; preferentialTax: number } {
  const pref = Math.min(pos(preferential), pos(taxable));
  const ordinary = taxable - pref;
  const { zeroMax, fifteenMax } = fp.capitalGains[fs];
  const atZero = pos(Math.min(taxable, zeroMax) - ordinary);
  const atFifteen = pos(Math.min(taxable, fifteenMax) - Math.max(ordinary, zeroMax));
  const atTwenty = pref - Math.min(pref, atZero) - Math.min(pref, atFifteen);
  return {
    ordinaryTax: bracketTax(ordinary, fp.brackets[fs]),
    preferentialTax: r(Math.min(pref, atFifteen) * fp.preferentialRates.fifteen + pos(atTwenty) * fp.preferentialRates.twenty),
  };
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
  const otherIncome = total(people, (p) => p.otherIncome + p.businessIncome);
  const totalIncome = wages + interest + ordinaryDividends + capitalGainAllowed + retirementTaxable + otherIncome;
  const adjustments = total(people, (p) => p.adjustments);
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
  const itemizedBefore = salt + mortgageInterest + charitable + otherItemized;
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
  const qbiDeduction = r(Math.min(0.2 * pos(qbiBase), 0.2 * pos(tiBeforeQbi - preferentialBase)));
  const taxableIncome = pos(tiBeforeQbi - qbiDeduction);

  const preferentialIncome = Math.min(preferentialBase, taxableIncome);
  const { ordinaryTax, preferentialTax } = taxWithPreferential(taxableIncome, preferentialIncome, fp, fs);
  const regularTax = ordinaryTax + preferentialTax;

  // AMT (Form 6251, simplified): add back the standard deduction or the SALT deduction.
  const amti = taxableIncome + (itemizes ? salt : standardDeduction);
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
  const foreignTaxCredit = total(people, (p) => p.foreignTaxPaid);

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
  const additionalMedicareTax = r(fp.additionalMedicareRate * pos(medicareWages - fp.surtaxThreshold[fs]));
  const additionalMedicareWithheld = sum(w2s.map((w) => pos(w.medicareWithheld - r(w.box5MedicareWages * fp.medicareRate))));
  const netInvestmentIncome = pos(interest + ordinaryDividends + capitalGainAllowed);
  const niit = r(fp.niitRate * Math.min(netInvestmentIncome, pos(agi - fp.surtaxThreshold[fs])));

  const totalTax = incomeTaxAfterCredits + additionalMedicareTax + niit;
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
    totalIncome,
    adjustments,
    agi,
    standardDeduction,
    itemized: { saltPaid, saltCap, salt, mortgageInterest, charitable, other: otherItemized, limitation37, total: itemizedTotal },
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
  const totalPayments = withholding + estimatedPayments;
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
 * at bracket k's rate), phased in over the next $50,000 of AGI. Taxable income within the
 * first four brackets moves to the fourth bracket's flat rate; above $25 million of AGI
 * every dollar is at the top rate.
 */
export function nyStateTax(np: NyParams, fs: FilingStatus, nyAgi: number, ti: number): { schedule: number; recapture: number } {
  const b = np.brackets[fs];
  if (ti <= 0) return { schedule: 0, recapture: 0 };
  const schedule = nyScheduleTax(nyAgi <= np.recaptureAgi ? tableIncome(ti, np.tableBelow) : ti, b);
  if (nyAgi <= np.recaptureAgi) return { schedule, recapture: 0 };
  if (nyAgi > np.flatAbove) return { schedule, recapture: whole(ti * b.at(-1)![1]) - schedule };
  const k = b.findIndex(([u]) => ti <= u);
  const phase = (from: number) => Math.min(1, Math.round((pos(nyAgi - from) / np.recapturePhaseIn) * 10_000) / 10_000);
  if (k <= 3) {
    // Worksheet 1: towards the fourth bracket's rate on all of it, as AGI passes $107,650.
    const full = whole(ti * b[3]![1]);
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
  const nyAgi = federalAgi - subtractions;
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
  const totalPayments = withholding + cityWithholding + estimatedPayments + (city ? city.schoolCredit + city.schoolRateReduction : 0);
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
