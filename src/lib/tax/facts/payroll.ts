import { addDays, endOfMonth, ymd } from "../../dates/isoDate.ts";
import { amountsFromLines, type PayrollAmounts, type PayStubFacts, type StubLine } from "../../ingest/payroll/index.ts";
import type { W2 } from "../computeReturn.ts";
import type { FederalParams } from "../params.ts";

/**
 * Stored pay stubs → year-to-date payroll figures → W-2 boxes and a year-end projection.
 * The stubs themselves are read once, at import, by src/lib/ingest/payroll; this file
 * only does payroll's W-2 arithmetic on them: Box 5 = gross − non-taxable
 * reimbursements − §125 deductions; Box 1 = Box 5 − pre-tax retirement deferrals.
 */

export type { PayrollAmounts, StubLine };
export { amountsFromLines, ZERO_AMOUNTS } from "../../ingest/payroll/index.ts";
/** A stored stub as the tax and profile modules see it. */
export type PayStubTax = PayStubFacts;

export type W2Boxes = W2 & {
  /** Box 12 codes: D (401k), AA (Roth 401k), W (HSA incl. employer), C (taxable group-term life), DD (health coverage cost). */
  box12: { D: number; AA: number; W: number; C: number; DD: number };
  /** Box 10: dependent-care benefits. */
  box10: number;
  otherStateWithheld: number;
  statePayroll: number;
  employerRetirement: number;
};

/** Payroll's W-2 arithmetic. Box 3 is capped at the Social Security wage base. */
export function w2FromAmounts(employer: string, a: PayrollAmounts, fp: FederalParams): W2Boxes {
  const box5 = a.gross - a.nonTaxable - a.section125 - a.hsa - a.dependentCareFsa;
  const box1 = box5 - a.retirementPretax;
  return {
    employer,
    grossPay: a.gross - a.nonTaxable,
    box1Wages: box1,
    box3SsWages: Math.min(box5, fp.socialSecurity.wageBase),
    box5MedicareWages: box5,
    box16StateWages: box1,
    federalWithheld: a.federalWithheld,
    ssWithheld: a.ssWithheld,
    medicareWithheld: a.medicareWithheld,
    stateWithheld: a.stateWithheld,
    // An employer withholding New York tax reports these wages on the W-2's New York line.
    nyStateWages: a.nyWithheld > 0 ? box1 : 0,
    nyWithheld: a.nyWithheld,
    nycWithheld: a.nycWithheld,
    otherStateWithheld: a.otherStateWithheld,
    statePayroll: a.statePayroll,
    employerRetirement: a.employerRetirement,
    box10: a.dependentCareFsa,
    box12: {
      D: a.retirementPretax,
      AA: a.retirementRoth,
      W: a.hsa + a.employerHsa,
      C: a.groupTermLife,
      DD: a.employerHealth + a.section125,
    },
  };
}

// ---------------------------------------------------------------- projection

export type PayFrequency = "WEEKLY" | "BIWEEKLY" | "SEMIMONTHLY" | "MONTHLY";

export function inferFrequency(periodStart: string | null, periodEnd: string | null): PayFrequency {
  if (!periodStart || !periodEnd) return "SEMIMONTHLY";
  const days = (Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000 + 1;
  if (days <= 8) return "WEEKLY";
  if (days <= 14) return "BIWEEKLY";
  if (days <= 16) return "SEMIMONTHLY";
  return "MONTHLY";
}

/** Pay dates after `lastPayDate` through Dec 31 of its year. */
export function remainingPayDates(lastPayDate: string, frequency: PayFrequency): string[] {
  const year = Number(lastPayDate.slice(0, 4));
  const end = ymd(year, 12, 31);
  const out: string[] = [];
  if (frequency === "SEMIMONTHLY") {
    for (let m = Number(lastPayDate.slice(5, 7)); m <= 12; m++) {
      for (const d of [ymd(year, m, 15), endOfMonth(ymd(year, m, 1))]) if (d > lastPayDate) out.push(d);
    }
    return out;
  }
  if (frequency === "MONTHLY") {
    for (let m = Number(lastPayDate.slice(5, 7)) + 1; m <= 12; m++) {
      const day = Math.min(Number(lastPayDate.slice(8, 10)), Number(endOfMonth(ymd(year, m, 1)).slice(8, 10)));
      out.push(ymd(year, m, day));
    }
    return out;
  }
  const step = frequency === "WEEKLY" ? 7 : 14;
  for (let d = addDays(lastPayDate, step); d <= end; d = addDays(d, step)) out.push(d);
  return out;
}

export type PayrollProjection = {
  employer: string;
  employee: string;
  source: PayStubTax["source"];
  latestPayDate: string;
  frequency: PayFrequency;
  remainingPayDates: string[];
  /** The regular (non-bonus) paycheck the projection repeats. */
  regularPaycheck: PayrollAmounts | null;
  /** Which paycheck is repeated: the latest regular one, or the typical recent one. */
  basis: PaycheckBasis;
  /** The latest regular paycheck and the typical one (median gross of the last six), for comparison. */
  latestRegular: { payDate: string; amounts: PayrollAmounts } | null;
  typicalRegular: { payDate: string; amounts: PayrollAmounts } | null;
  /** Pay stops after this date (the job ends), when set. */
  payThrough: string | null;
  extraBonus: number;
  ytd: PayrollAmounts;
  projected: PayrollAmounts;
  w2Ytd: W2Boxes;
  w2Projected: W2Boxes;
  lines: StubLine[];
  federalFilingStatus: string | null;
};

export type PaycheckBasis = "LATEST" | "TYPICAL";

/**
 * Year-end figures: YTD plus a regular paycheck (the latest, or the typical recent one)
 * repeated for every remaining pay date (through `payThrough` when the job ends), plus
 * any expected bonus at supplemental withholding rates. Deferrals stop at the annual
 * limit; Social Security stops at the wage base; Medicare is recomputed so the 0.9%
 * surtax kicks in at $200k of wages exactly as the employer withholds it.
 */
export function projectPayroll(
  stubs: PayStubTax[],
  fp: FederalParams,
  opts: { extraBonus?: number; ctSupplementalRate?: number; basis?: PaycheckBasis; payThrough?: string | null } = {},
): PayrollProjection {
  const sorted = [...stubs].sort((a, b) => a.payDate.localeCompare(b.payDate));
  const latest = sorted.at(-1)!;
  const ytd = amountsFromLines(latest.lines, "ytd");
  const regulars = sorted
    .map((s) => ({ stub: s, amounts: amountsFromLines(s.lines, "current") }))
    .filter((x) => x.amounts.regular > 0 && x.amounts.bonus === 0);
  const latestRegular = regulars.at(-1) ?? null;
  const recent = regulars.slice(-6).sort((a, b) => a.amounts.gross - b.amounts.gross || a.stub.payDate.localeCompare(b.stub.payDate));
  const typicalRegular = recent[Math.floor(recent.length / 2)] ?? null;
  const basis = opts.basis ?? "LATEST";
  const regular = (basis === "TYPICAL" ? typicalRegular : latestRegular)?.amounts ?? null;
  const frequency = inferFrequency(latestRegular?.stub.periodStart ?? latest.periodStart, latestRegular?.stub.periodEnd ?? latest.periodEnd);
  const payThrough = opts.payThrough ?? null;
  const dates = remainingPayDates(latest.payDate, frequency).filter((d) => !payThrough || d <= payThrough);
  const n = regular ? dates.length : 0;
  const bonus = opts.extraBonus ?? 0;

  const p: PayrollAmounts = { ...ytd };
  if (regular) {
    for (const k of Object.keys(p) as (keyof PayrollAmounts)[]) p[k] += regular[k] * n;
  }
  // Deferrals cannot exceed the annual limit (payroll stops them once reached).
  p.retirementPretax = Math.min(p.retirementPretax, Math.max(ytd.retirementPretax, fp.limits.k401 - ytd.retirementRoth));
  // HSA payroll contributions likewise stop at the annual limit (the family one, the most any
  // coverage allows): repeating a paycheck's amount mustn't overshoot it by a rounding.
  p.employerHsa = Math.min(p.employerHsa, Math.max(ytd.employerHsa, fp.limits.hsaFamily));
  p.hsa = Math.min(p.hsa, Math.max(ytd.hsa, fp.limits.hsaFamily - p.employerHsa));
  p.gross += bonus;
  p.bonus += bonus;
  const box5 = p.gross - p.nonTaxable - p.section125 - p.hsa - p.dependentCareFsa;
  const ytdBox5 = ytd.gross - ytd.nonTaxable - ytd.section125 - ytd.hsa - ytd.dependentCareFsa;
  p.ssWithheld = Math.round(Math.min(box5, fp.socialSecurity.wageBase) * fp.socialSecurity.rate);
  p.ssWithheld = Math.max(p.ssWithheld, ytd.ssWithheld);
  const medicareOn = (w: number) => w * fp.medicareRate + Math.max(0, w - 20_000_000) * fp.additionalMedicareRate;
  p.medicareWithheld = ytd.medicareWithheld + Math.round(medicareOn(box5) - medicareOn(ytdBox5));
  p.federalWithheld += Math.round(bonus * 0.22);
  p.stateWithheld += Math.round(bonus * (opts.ctSupplementalRate ?? 0.0699));
  p.statePayroll = Math.max(ytd.statePayroll, Math.min(p.statePayroll, Math.round(fp.socialSecurity.wageBase * 0.005)));

  return {
    employer: latest.employer,
    employee: latest.employee,
    source: latest.source,
    latestPayDate: latest.payDate,
    frequency,
    remainingPayDates: n ? dates : [],
    regularPaycheck: regular,
    basis,
    latestRegular: latestRegular && { payDate: latestRegular.stub.payDate, amounts: latestRegular.amounts },
    typicalRegular: typicalRegular && { payDate: typicalRegular.stub.payDate, amounts: typicalRegular.amounts },
    payThrough,
    extraBonus: bonus,
    ytd,
    projected: p,
    w2Ytd: w2FromAmounts(latest.employer, ytd, fp),
    w2Projected: w2FromAmounts(latest.employer, p, fp),
    lines: latest.lines,
    federalFilingStatus: latest.federalFilingStatus,
  };
}
