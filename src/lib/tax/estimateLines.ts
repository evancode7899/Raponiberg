import type { PersonReport, TaxReport } from "./buildTaxReport.ts";
import { allTaxes, computeReturn, type Dependent, type PersonIncome, type ReturnResult } from "./computeReturn.ts";
import type { TaxAuthority, TaxPaymentRow } from "./facts/payments.ts";
import { ZERO_AMOUNTS, type PayrollAmounts } from "./facts/payroll.ts";
import { taxYearParams } from "./params.ts";
import { applyWhatIf, bestSeparate, NO_WHAT_IF, type MfsResult, type WhatIf } from "./scenarios.ts";

/**
 * The tax estimate's lines, one definition each: what the Taxes page shows for a line in a
 * column (a spouse's separate return or the joint one) and what its proof re-derives
 * (book/proof/taxEstimateProof.ts). The worksheet's rows, the Overview's cards and the
 * Income tab read their figures from here, so a page and its proof can't compute a line
 * two ways. Pure: runs in the browser (the worksheet's basis and what-ifs) and on the server.
 */

/** Year to date (as if the year ended at the latest stub and statement) or projected to December 31. */
export type EstimateBasis = "projected" | "ytd";

/** One return the page shows: a spouse filing separately, or the household's return (joint, or Single in a Single year). */
export type EstimateColumn = {
  /** A person's id, or "joint" for the household's return. */
  id: string;
  name: string;
  sub: string;
  r: ReturnResult;
  /** The return's inputs, one per person on it. */
  incomes: PersonIncome[];
  /** The people's pay-stub totals for the basis (the worksheet's top rows). */
  pay: PayrollAmounts;
  /** Dependents claimed on this return. */
  dependents: Dependent[];
  /** Figures as a return reports them: whole dollars (the Filed return tab's comparison). */
  wholeDollars?: boolean;
};

export type EstimateInput = Pick<TaxReport, "year" | "people" | "dependents" | "ny" | "filingStatus"> & { profile: Pick<TaxReport["profile"], "mfsDependentClaimant"> };

/** The page's returns for a basis: each spouse's separate return (as bestSeparate picks them), then the joint one; a Single year has only the filer's return. */
export function estimateColumns(r: EstimateInput, basis: EstimateBasis, whatIf: WhatIf = NO_WHAT_IF): { joint: ReturnResult; mfs: MfsResult; cols: EstimateColumn[] } {
  const params = taxYearParams(r.year);
  const base = r.people.map((p) => (basis === "ytd" ? p.incomeYtd : p.income));
  const incomes = applyWhatIf(base, whatIf, params);
  const ny = r.ny?.filing ?? null;
  const joint = computeReturn({ params, filingStatus: r.filingStatus, people: incomes, dependents: r.dependents, ny });
  const mfs = bestSeparate(params, incomes, r.dependents, r.profile.mfsDependentClaimant, ny);
  const pays = r.people.map((p) => payFor(p, basis, whatIf));
  const pay = pays.reduce(addPay, { ...ZERO_AMOUNTS });
  if (r.filingStatus === "SINGLE") return { joint, mfs, cols: [{ id: "joint", name: "Single", sub: "filing single", r: joint, incomes, pay, dependents: r.dependents }] };
  const cols: EstimateColumn[] = [
    ...r.people.map((p, i) => ({
      id: p.id,
      name: p.name,
      sub: "separate",
      r: mfs.returns[p.id]!,
      incomes: [incomes[i]!],
      pay: pays[i]!,
      dependents: mfs.claimant === p.id ? r.dependents : [],
    })),
    { id: "joint", name: "Joint", sub: "filing jointly", r: joint, incomes, pay, dependents: r.dependents },
  ];
  return { joint, mfs, cols };
}

/** A person's pay-stub totals for the basis, with a what-if's extra wages (as a bonus) and 401(k). */
export function payFor(p: PersonReport, basis: EstimateBasis, whatIf: WhatIf = NO_WHAT_IF): PayrollAmounts {
  const a = basis === "ytd" ? p.payrollTotals.ytd : p.payrollTotals.projected;
  const w = whatIf.people[p.id];
  return w ? { ...a, bonus: a.bonus + w.extraWages, retirementPretax: a.retirementPretax + w.extraPretax401k } : a;
}

export function addPay(a: PayrollAmounts, b: PayrollAmounts): PayrollAmounts {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof PayrollAmounts)[]) out[k] += b[k];
  return out;
}

const sumW2 = (c: EstimateColumn, f: (w: PersonIncome["w2s"][number]) => number) => c.incomes.reduce((s, p) => s + p.w2s.reduce((t, w) => t + f(w), 0), 0);
const dollar = (cents: number) => Math.round(cents / 100) * 100;
const nySchool = (c: EstimateColumn) => (c.r.ny?.city ? c.r.ny.city.schoolCredit + c.r.ny.city.schoolRateReduction : 0);

type LineDef = {
  label: string;
  /** Money (cents); `ratio` lines are a share. Null: the return has no such line (no New York return, a full-year resident's share). */
  value: (c: EstimateColumn, all: EstimateColumn[]) => number | null;
  ratio?: true;
  /** Read off the people's pay stubs: no Filed return comparison has it. */
  payroll?: true;
};

const L = <K extends string>(defs: Record<K, LineDef>) => defs;

/** Every line, by key. Keys of the federal, Connecticut and New York lines follow the Filed return tab's (lib/tax/filedCheck). */
export const ESTIMATE_LINES = L({
  // ------------------------------------------------------------ pay stubs
  "pay.salary": { label: "Gross salary", value: (c) => c.pay.regular, payroll: true },
  "pay.bonus": { label: "Gross bonus", value: (c) => c.pay.bonus, payroll: true },
  "pay.earned": { label: "Earned income", value: (c) => c.pay.regular + c.pay.bonus, payroll: true },
  "pay.imputed": { label: "Taxable company-paid benefits", value: (c) => c.pay.imputed, payroll: true },
  "pay.withBenefits": { label: "Total income + taxable benefits", value: (c) => c.pay.regular + c.pay.bonus + c.pay.imputed, payroll: true },
  "pay.pretax": { label: "Pre-tax health, dental, vision, HSA, FSA", value: (c) => c.pay.section125 + c.pay.hsa + c.pay.dependentCareFsa, payroll: true },
  "pay.medicareWages": { label: "Social Security / Medicare wages (W-2 box 5)", value: (c) => sumW2(c, (w) => w.box5MedicareWages) },
  "pay.k401": { label: "Pre-tax 401(k)", value: (c) => c.pay.retirementPretax, payroll: true },

  // ------------------------------------------------------------ federal
  "fed.wages": { label: "Wages (W-2 box 1)", value: (c) => c.r.federal.wages },
  "fed.taxableInterest": { label: "Taxable interest", value: (c) => c.r.federal.interest },
  "fed.ordinaryDividends": { label: "Ordinary dividends", value: (c) => c.r.federal.ordinaryDividends },
  "fed.qualifiedDividends": { label: "Qualified dividends", value: (c) => c.r.federal.qualifiedDividends },
  "fed.iraTaxable": { label: "Taxable IRA distributions", value: (c) => c.r.federal.retirementTaxable },
  "fed.capitalGain": { label: "Capital gain or loss", value: (c) => c.r.federal.capitalGainAllowed },
  "fed.additionalIncome": { label: "Other income (Schedule 1)", value: (c) => c.r.federal.otherIncome },
  "fed.investmentIncome": {
    label: "Investment income (interest, dividends, gains, IRA)",
    value: (c) => c.r.federal.interest + c.r.federal.ordinaryDividends + c.r.federal.capitalGainAllowed + c.r.federal.retirementTaxable + c.r.federal.otherIncome,
  },
  "fed.totalIncome": { label: "Total income", value: (c) => c.r.federal.totalIncome },
  "fed.adjustments": { label: "Adjustments to income", value: (c) => c.r.federal.adjustments },
  "fed.agi": { label: "Federal adjusted gross income", value: (c) => c.r.federal.agi },
  "fed.deduction": { label: "Standard or itemized deduction", value: (c) => c.r.federal.deduction },
  "fed.qbiDeduction": { label: "Qualified business income deduction", value: (c) => c.r.federal.qbiDeduction },
  "fed.taxableIncome": { label: "Federal taxable income", value: (c) => c.r.federal.taxableIncome },
  "fed.preferentialIncome": { label: "Qualified dividends & long-term gains (0/15/20%)", value: (c) => c.r.federal.preferentialIncome },
  "fed.tax": { label: "Tax (1040 line 16)", value: (c) => c.r.federal.regularTax },
  "fed.amt": { label: "Alternative minimum tax", value: (c) => c.r.federal.amt },
  "fed.childCredit": { label: "Child / other dependent credit", value: (c) => c.r.federal.childTaxCredit + c.r.federal.otherDependentCredit },
  "fed.otherCredits": { label: "Other credits (foreign tax, dependent care)", value: (c) => c.r.federal.foreignTaxCredit + c.r.federal.dependentCareCredit },
  "fed.additionalMedicareTax": { label: "Additional Medicare tax (0.9%)", value: (c) => c.r.federal.additionalMedicareTax },
  "fed.niit": { label: "Net investment income tax (3.8%)", value: (c) => c.r.federal.niit },
  "fed.totalTax": { label: "Total federal tax (1040 line 24)", value: (c) => c.r.federal.totalTax },
  "fed.incomeTax": { label: "Federal income tax", value: (c) => c.r.federal.incomeTaxAfterCredits - c.r.federal.refundableChildCredit },
  "fed.w2Withholding": { label: "Federal withholding (W-2 box 2)", value: (c) => c.r.federal.withholding },
  "fed.otherWithholding": { label: "Additional Medicare tax withheld", value: (c) => c.r.federal.additionalMedicareWithheld },
  "fed.estimatedPayments": { label: "Federal estimated payments", value: (c) => c.r.federal.estimatedPayments },
  "fed.excessSsCredit": { label: "Excess Social Security withheld", value: (c) => c.r.federal.excessSsCredit },
  "fed.refundableChildCredit": { label: "Refundable child tax credit", value: (c) => c.r.federal.refundableChildCredit },
  "fed.totalPayments": { label: "Total federal payments", value: (c) => c.r.federal.totalPayments },
  // The Filed return tab subtracts the return's own rounded lines (24 − 33), as the form does.
  "fed.balance": { label: "Federal owed / (refund)", value: (c) => (c.wholeDollars ? dollar(c.r.federal.totalTax) - dollar(c.r.federal.totalPayments) : c.r.federal.balanceDue) },

  // ------------------------------------------------------------ Connecticut
  "ct.federalAgi": { label: "Federal AGI (CT-1040 line 1)", value: (c) => c.r.ct.federalAgi },
  "ct.usObligationSubtraction": { label: "US government interest subtracted", value: (c) => c.r.ct.usObligationSubtraction },
  "ct.chet": { label: "CHET 529 contributions subtracted", value: (c) => c.r.ct.chetDeduction },
  "ct.stateAgi": { label: "Connecticut AGI", value: (c) => c.r.ct.ctAgi },
  "ct.exemption": { label: "Personal exemption", value: (c) => c.r.ct.exemption },
  "ct.taxableIncome": { label: "Connecticut taxable income", value: (c) => c.r.ct.taxableIncome },
  "ct.sourceIncome": { label: "Income from Connecticut sources", value: (c) => c.r.ct.sourceIncome },
  "ct.incomePercentage": { label: "Connecticut share of income", value: (c) => c.r.ct.incomePercentage, ratio: true },
  "ct.taxBeforeAllocation": { label: "Tax on all income (resident tables)", value: (c) => c.r.ct.taxBeforeAllocation },
  "ct.otherStateCredit": { label: "Credit for taxes paid to other states", value: (c) => c.r.ct.otherStateCredit },
  "ct.childTaxCredit": { label: "Connecticut child tax credit", value: (c) => c.r.ct.childTaxCredit },
  "ct.totalTax": { label: "Connecticut income tax", value: (c) => c.r.ct.totalTax },
  "ct.withheld": { label: "Connecticut withholding (W-2 box 17)", value: (c) => c.r.ct.withholding },
  "ct.estimatedPayments": { label: "Connecticut estimated payments", value: (c) => c.r.ct.estimatedPayments },
  "ct.totalPayments": { label: "Total Connecticut payments", value: (c) => c.r.ct.totalPayments },
  "ct.balance": { label: "Connecticut owed / (refund)", value: (c) => (c.wholeDollars ? dollar(c.r.ct.totalTax) - dollar(c.r.ct.totalPayments) : c.r.ct.balanceDue) },

  // ------------------------------------------------------------ New York
  "ny.federalAgi": { label: "Federal AGI (New York return)", value: (c) => c.r.ny?.federalAgi ?? null },
  "ny.usObligationSubtraction": { label: "US government interest subtracted", value: (c) => c.r.ny?.subtractions ?? null },
  "ny.stateAgi": { label: "New York AGI", value: (c) => c.r.ny?.nyAgi ?? null },
  "ny.deductions": { label: "Standard deduction and dependent exemptions", value: (c) => (c.r.ny ? c.r.ny.standardDeduction + c.r.ny.dependentExemption : null) },
  "ny.taxableIncome": { label: "New York taxable income", value: (c) => c.r.ny?.taxableIncome ?? null },
  "ny.sourceIncome": { label: "New York amount column (income while a resident + NY-source)", value: (c) => c.r.ny?.sourceIncome ?? null },
  "ny.incomePercentage": { label: "New York share of income", value: (c) => c.r.ny?.incomePercentage ?? null, ratio: true },
  "ny.taxBeforeAllocation": { label: "New York State tax on all income (with recapture)", value: (c) => c.r.ny?.baseTax ?? null },
  "ny.incomeTax": { label: "New York State income tax", value: (c) => c.r.ny?.stateTax ?? null },
  "ny.cityTaxableIncome": { label: "New York City taxable income", value: (c) => c.r.ny?.city?.taxableIncome ?? null },
  "ny.cityTax": { label: "New York City income tax", value: (c) => c.r.ny?.cityTax ?? null },
  "ny.totalTax": { label: "Total New York taxes", value: (c) => c.r.ny?.totalTax ?? null },
  "ny.withheld": { label: "New York State tax withheld", value: (c) => c.r.ny?.withholding ?? null },
  "ny.cityWithheld": { label: "New York City tax withheld", value: (c) => c.r.ny?.cityWithholding ?? null },
  "ny.withheldAll": { label: "New York State + City withholding (box 17, 19)", value: (c) => sumW2(c, (w) => (w.nyWithheld ?? 0) + (w.nycWithheld ?? 0)) },
  "ny.credits": { label: "NYC school credits and NY estimates", value: (c) => nySchool(c) + (c.r.ny?.estimatedPayments ?? 0) },
  "ny.estimatedPayments": { label: "New York estimated payments", value: (c) => c.r.ny?.estimatedPayments ?? null },
  "ny.totalPayments": { label: "Total New York payments and refundable credits", value: (c) => c.r.ny?.totalPayments ?? null },
  "ny.balance": {
    label: "New York owed / (refund)",
    value: (c) => (c.r.ny ? (c.wholeDollars ? dollar(c.r.ny.totalTax) - dollar(c.r.ny.totalPayments) : c.r.ny.balanceDue) : null),
  },

  // ------------------------------------------------------------ payroll taxes
  "fica.socialSecurity": { label: "Social Security", value: (c) => c.r.fica.socialSecurity },
  "fica.medicare": { label: "Medicare (1.45%)", value: (c) => c.r.fica.medicare },
  "fica.medicareTotal": { label: "Medicare (1.45% + 0.9% surtax)", value: (c) => c.r.fica.medicare + c.r.federal.additionalMedicareTax },
  "fica.pfml": { label: "CT Paid Leave (PFML)", value: (c) => c.r.fica.ctPfml },
  "fica.ssWithheld": { label: "Social Security withheld (W-2 box 4)", value: (c) => sumW2(c, (w) => w.ssWithheld) },
  "fica.medicareWithheld": { label: "Medicare withheld (W-2 box 6)", value: (c) => sumW2(c, (w) => w.medicareWithheld) },

  // ------------------------------------------------------------ totals
  "all.otherStateTax": { label: "Other state tax", value: (c) => c.r.otherStateTax },
  "all.totalTaxes": { label: "Total taxes", value: (c) => totalTaxes(c) },
  "all.jointValue": {
    label: "Value of filing jointly",
    value: (c, all) => (c.id === "joint" && all.length > 1 ? all.filter((x) => x.id !== "joint").reduce((s, x) => s + totalTaxes(x), 0) - totalTaxes(c) : null),
  },
  "all.earnedPlusInvestment": { label: "Earned + investment income", value: (c) => earnedPlusInvestment(c) },
  "all.takeHome": { label: "Take-home income (after all taxes)", value: (c) => earnedPlusInvestment(c) - totalTaxes(c) },
  "all.totalPaid": { label: "Total taxes paid", value: (c) => totalPaid(c) },
  "all.balance": { label: "Total owed / (refund)", value: (c) => c.r.federal.balanceDue + c.r.ct.balanceDue + (c.r.ny?.balanceDue ?? 0) },
});

export type EstimateKey = keyof typeof ESTIMATE_LINES;

export const isEstimateKey = (k: unknown): k is EstimateKey => typeof k === "string" && Object.hasOwn(ESTIMATE_LINES, k);

/** A line's figure in a column, as the page shows it (before any sign flip for a deduction). */
export function lineValue(key: EstimateKey, c: EstimateColumn, all: EstimateColumn[] = [c]): number | null {
  return ESTIMATE_LINES[key].value(c, all);
}

/**
 * The lines the Worksheet draws for these columns, in its order (each across every column,
 * or only the one it names): the one list the page draws its rows from and the proof sweep
 * enumerates (book/proof/figures.ts), so a line is swept exactly where a basis draws it.
 * New York's lines come with a New York return, its city and other states' tax with tax.
 */
export function worksheetLines(cols: EstimateColumn[]): { key: EstimateKey; only?: "joint" }[] {
  const ny = cols.some((c) => c.r.ny);
  const any = (key: EstimateKey) => cols.some((c) => lineValue(key, c, cols));
  const keys = (...ks: (EstimateKey | false)[]) => ks.filter((k): k is EstimateKey => !!k).map((key) => ({ key }));
  return [
    ...keys("pay.salary", "pay.bonus", "pay.earned", "pay.imputed", "pay.withBenefits", "pay.pretax", "pay.medicareWages", "pay.k401"),
    ...keys("fed.wages", "fed.investmentIncome", "fed.adjustments", "fed.agi", "fed.deduction", "fed.qbiDeduction", "fed.taxableIncome", "fed.preferentialIncome"),
    ...keys("ct.stateAgi", "ct.exemption", "ct.taxableIncome"),
    ...keys(ny && "ny.stateAgi", ny && "ny.deductions", ny && "ny.taxableIncome", cols.some((c) => c.r.ny?.incomePercentage != null) && "ny.incomePercentage", cols.some((c) => c.r.ny?.city) && "ny.cityTaxableIncome"),
    ...keys("fed.incomeTax", "fica.medicareTotal", "fed.niit", "fica.socialSecurity", "ct.totalTax", "fica.pfml", ny && "ny.incomeTax", any("ny.cityTax") && "ny.cityTax", any("all.otherStateTax") && "all.otherStateTax", "all.totalTaxes"),
    ...(cols.length > 1 ? [{ key: "all.jointValue" as const, only: "joint" as const }] : []),
    ...keys("all.earnedPlusInvestment", "all.takeHome"),
    ...keys("fed.w2Withholding", "fed.estimatedPayments", "fica.medicareWithheld", "fica.ssWithheld", "ct.withheld", "ct.estimatedPayments", ny && "ny.withheldAll", ny && "ny.credits", "all.totalPaid"),
    ...keys("fed.balance", "ct.balance", ny && "ny.balance", "all.balance"),
  ];
}

/** The joint return's lines Taxes › Income & W-2 draws beyond the Worksheet's, projected (federal income to taxable income, Connecticut AGI to tax). */
export const INCOME_TAB_LINES: readonly EstimateKey[] = [
  "fed.taxableInterest", "fed.ordinaryDividends", "fed.capitalGain", "fed.iraTaxable", "fed.additionalIncome",
  "ct.federalAgi", "ct.chet", "ct.usObligationSubtraction", "ct.childTaxCredit",
];

/** Every tax the worksheet totals (computeReturn.ts allTaxes, the one definition). */
const totalTaxes = (c: EstimateColumn): number => allTaxes(c.r);

function earnedPlusInvestment(c: EstimateColumn): number {
  const f = c.r.federal;
  return c.pay.regular + c.pay.bonus + c.pay.imputed + f.interest + f.ordinaryDividends + f.capitalGainAllowed + f.retirementTaxable + f.otherIncome;
}

/** Withholding, estimates, PFML and New York's credits: what the worksheet counts as paid. */
function totalPaid(c: EstimateColumn): number {
  return (
    sumW2(c, (w) => w.federalWithheld + w.ssWithheld + w.medicareWithheld + w.stateWithheld + (w.nyWithheld ?? 0) + (w.nycWithheld ?? 0)) +
    c.r.federal.estimatedPayments +
    c.r.ct.estimatedPayments +
    c.r.fica.ctPfml +
    nySchool(c) +
    (c.r.ny?.estimatedPayments ?? 0)
  );
}

/** The year's estimated payments to one authority found in the bank ledger (the Payments tab's totals). */
export function estimatesFound(payments: TaxPaymentRow[], year: number, authority: TaxAuthority): number {
  return estimateRows(payments, year, authority).reduce((s, p) => s + p.amount, 0);
}

export function estimateRows(payments: TaxPaymentRow[], year: number, authority: TaxAuthority): TaxPaymentRow[] {
  return payments.filter((p) => p.authority === authority && p.attribution.kind === "ESTIMATE" && p.attribution.taxYear === year);
}
