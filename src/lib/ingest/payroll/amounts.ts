import type { StubLine } from "./types.ts";

/** Stub lines rolled up by what they are, this period or year to date. */
export type PayrollAmounts = {
  gross: number;
  regular: number;
  bonus: number;
  imputed: number;
  /** Imputed group-term life over $50k (W-2 Box 12 C). */
  groupTermLife: number;
  nonTaxable: number;
  retirementPretax: number;
  retirementRoth: number;
  hsa: number;
  section125: number;
  dependentCareFsa: number;
  federalWithheld: number;
  ssWithheld: number;
  medicareWithheld: number;
  stateWithheld: number;
  /** Every other state's and city's income tax withheld (New York's included). */
  otherStateWithheld: number;
  /** The New York State and New York City parts of `otherStateWithheld`. */
  nyWithheld: number;
  nycWithheld: number;
  statePayroll: number;
  employerRetirement: number;
  employerHsa: number;
  employerHealth: number;
};

export const ZERO_AMOUNTS: PayrollAmounts = {
  gross: 0,
  regular: 0,
  bonus: 0,
  imputed: 0,
  groupTermLife: 0,
  nonTaxable: 0,
  retirementPretax: 0,
  retirementRoth: 0,
  hsa: 0,
  section125: 0,
  dependentCareFsa: 0,
  federalWithheld: 0,
  ssWithheld: 0,
  medicareWithheld: 0,
  stateWithheld: 0,
  otherStateWithheld: 0,
  nyWithheld: 0,
  nycWithheld: 0,
  statePayroll: 0,
  employerRetirement: 0,
  employerHsa: 0,
  employerHealth: 0,
};

export function amountsFromLines(lines: StubLine[], pick: "current" | "ytd"): PayrollAmounts {
  const a = { ...ZERO_AMOUNTS };
  for (const l of lines) {
    const v = l[pick] ?? 0;
    switch (l.kind) {
      case "REGULAR":
      case "OTHER_EARNING":
        a.regular += v;
        a.gross += v;
        break;
      case "BONUS":
        a.bonus += v;
        a.gross += v;
        break;
      case "IMPUTED":
        a.imputed += v;
        if (/LIFE|GTL|GROUP TERM/i.test(l.name)) a.groupTermLife += v;
        a.gross += v;
        break;
      case "NONTAXABLE":
        a.nonTaxable += v;
        a.gross += v;
        break;
      case "RETIREMENT_PRETAX":
        a.retirementPretax += v;
        break;
      case "RETIREMENT_ROTH":
        a.retirementRoth += v;
        break;
      case "HSA":
        a.hsa += v;
        break;
      case "SECTION125":
        a.section125 += v;
        break;
      case "DEPENDENT_CARE_FSA":
        a.dependentCareFsa += v;
        break;
      case "FEDERAL_TAX":
        a.federalWithheld += v;
        break;
      case "SOCIAL_SECURITY":
        a.ssWithheld += v;
        break;
      case "MEDICARE":
        a.medicareWithheld += v;
        break;
      case "STATE_TAX":
        a.stateWithheld += v;
        break;
      case "OTHER_STATE_TAX":
        a.otherStateWithheld += v;
        if (/^NY\b|NEW YORK/i.test(l.name)) a.nyWithheld += v;
        break;
      case "LOCAL_TAX":
        a.otherStateWithheld += v;
        // "New York State …" lands here too (the rules test NEW YORK first): that one is the State's.
        if (/NEW YORK STATE|^NYS\b/i.test(l.name)) a.nyWithheld += v;
        else if (/NEW YORK|NYC|^NY\b/i.test(l.name)) a.nycWithheld += v;
        break;
      case "STATE_PAYROLL":
        a.statePayroll += v;
        break;
      case "EMPLOYER_RETIREMENT":
        a.employerRetirement += v;
        break;
      case "EMPLOYER_HSA":
        a.employerHsa += v;
        break;
      case "EMPLOYER_HEALTH":
        a.employerHealth += v;
        break;
      default:
        break;
    }
  }
  return a;
}
