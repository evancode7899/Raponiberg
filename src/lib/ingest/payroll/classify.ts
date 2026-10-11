import type { StubLineKind } from "./types.ts";

// TriNet's older stubs spell it "Withholdng".
const TAX_RULES: [RegExp, StubLineKind][] = [
  [/\bFED(ERAL)?\b.*\b(TAX|WITHHOLDI?NG|W\/H|FIT)\b|^FIT\b|^FED WITHHOLDI?NG/i, "FEDERAL_TAX"],
  [/MEDICARE|\bMED\/EE\b|ADDL MED/i, "MEDICARE"],
  // State disability programs print as "NY OASDI/EE" on some stubs: not Social Security.
  [/^[A-Z]{2} OASDI/, "STATE_PAYROLL"],
  [/SOC(IAL)? ?SEC|OASDI|\bFICA\b/i, "SOCIAL_SECURITY"],
  [/PFML|\bFLI\b|\bSDI\b|\bSUI\b|DISABILITY TAX|FAMILY LEAVE/i, "STATE_PAYROLL"],
  [/^CT\b.*(TAX|WITHHOLDI?NG)|CONNECTICUT/i, "STATE_TAX"],
  [/NEW YORK|NYC|CITY|LOCAL/i, "LOCAL_TAX"],
  [/^[A-Z]{2}\b.*(INCOME TAX|WITHHOLDI?NG|STATE TAX)|STATE (INCOME )?TAX|\bSIT\b/i, "OTHER_STATE_TAX"],
];

const DEDUCTION_RULES: [RegExp, StubLineKind][] = [
  [/ROTH/i, "RETIREMENT_ROTH"],
  [/401 ?K|403 ?B|\b457\b|PRE-?TAX (RET|401)|RETIREMENT/i, "RETIREMENT_PRETAX"],
  [/DEP(ENDENT)?\.? ?CARE|DCAP|DCFSA/i, "DEPENDENT_CARE_FSA"],
  [/^HSA\b|HEALTH SAVINGS/i, "HSA"],
  [/^(MEDICAL|MED|DENTAL|VISION|HEALTH|FSA|HC FSA|HEALTH CARE FSA)\b|METLIFE DENTAL|VSP VISION|UHC|COMMUTER|TRANSIT|PARKING/i, "SECTION125"],
];

const EMPLOYER_RULES: [RegExp, StubLineKind][] = [
  [/HSA/i, "EMPLOYER_HSA"],
  [/401|NONELECTIVE|MATCH|PROFIT SHAR|SAFE HARBOR|RETIRE/i, "EMPLOYER_RETIREMENT"],
  [/HDHP|MEDICAL|HEALTH|DENTAL|VISION|VSP|UHC|PPO|HMO|OAMC/i, "EMPLOYER_HEALTH"],
];

const EARNING_RULES: [RegExp, StubLineKind][] = [
  // A tax gross-up ("AnnivTaxReimb") is taxable pay, not a reimbursement.
  [/TAX ?REIMB|GROSS.?UP/i, "OTHER_EARNING"],
  [/REIM|EXPENSE (REIMB|RPT|REPORT)|NON-?TAX/i, "NONTAXABLE"],
  [/GROUP TERM|\bGTL\b|IMPUTED|TAXABLE BENEFIT/i, "IMPUTED"],
  [/BONUS|BNS|SUPPLEMENTAL|COMMISSION|INCENTIVE/i, "BONUS"],
  [/REGULAR|SALARY|BASE|HOURLY|PTO|HOLIDAY|VACATION|SICK|RETRO/i, "REGULAR"],
];

export const firstRule = (rules: [RegExp, StubLineKind][], name: string, fallback: StubLineKind) =>
  rules.find(([re]) => re.test(name))?.[1] ?? fallback;

export function classifyDeduction(name: string): StubLineKind {
  const tax = TAX_RULES.find(([re]) => re.test(name))?.[1];
  return tax ?? firstRule(DEDUCTION_RULES, name, "AFTER_TAX");
}
export const classifyTax = (name: string): StubLineKind | null => TAX_RULES.find(([re]) => re.test(name))?.[1] ?? null;
/** A deduction printed in a pre-tax section: pre-tax whatever its name says. */
export function classifyPretax(name: string): StubLineKind {
  if (/401|403|457/.test(name)) return "RETIREMENT_PRETAX";
  const k = firstRule(DEDUCTION_RULES, name, "SECTION125");
  return k === "AFTER_TAX" || k === "RETIREMENT_ROTH" ? "SECTION125" : k;
}
export const classifyEarning = (name: string) => firstRule(EARNING_RULES, name, "OTHER_EARNING");
export const classifyEmployer = (name: string) => firstRule(EMPLOYER_RULES, name, "EMPLOYER_OTHER");
