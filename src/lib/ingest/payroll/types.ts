/**
 * The one shape every pay stub is read into, by the one extractor for its provider
 * (TriNet, Vensure, ADP). The ledger stores it as-is (PayStub + PayStubLine), and every
 * module that needs pay — the profile, the outlook, taxes, the integrity checks — reads
 * that stored copy. Nothing re-reads stub PDFs downstream.
 *
 * A stub carries both its line items and the totals it prints, so it can prove itself:
 * the lines must add up to the printed totals, and gross − withheld must equal net.
 */

export type StubLineKind =
  // earnings
  | "REGULAR"
  | "BONUS"
  | "IMPUTED"
  | "NONTAXABLE"
  | "OTHER_EARNING"
  // employee deductions
  | "RETIREMENT_PRETAX"
  | "RETIREMENT_ROTH"
  | "HSA"
  | "SECTION125"
  | "DEPENDENT_CARE_FSA"
  | "AFTER_TAX"
  // withholding
  | "FEDERAL_TAX"
  | "SOCIAL_SECURITY"
  | "MEDICARE"
  | "STATE_TAX"
  | "OTHER_STATE_TAX"
  | "LOCAL_TAX"
  | "STATE_PAYROLL"
  // employer-paid
  | "EMPLOYER_RETIREMENT"
  | "EMPLOYER_HSA"
  | "EMPLOYER_HEALTH"
  | "EMPLOYER_OTHER";

export type StubLine = { name: string; kind: StubLineKind; current: number | null; ytd: number | null };

/** Earnings paid in cash (imputed income is taxed but never paid). */
export const CASH_EARNING_KINDS: ReadonlySet<StubLineKind> = new Set(["REGULAR", "BONUS", "NONTAXABLE", "OTHER_EARNING"]);
/** Everything taken out of gross pay before the net is deposited. */
export const WITHHELD_KINDS: ReadonlySet<StubLineKind> = new Set([
  "RETIREMENT_PRETAX",
  "RETIREMENT_ROTH",
  "HSA",
  "SECTION125",
  "DEPENDENT_CARE_FSA",
  "AFTER_TAX",
  "FEDERAL_TAX",
  "SOCIAL_SECURITY",
  "MEDICARE",
  "STATE_TAX",
  "OTHER_STATE_TAX",
  "LOCAL_TAX",
  "STATE_PAYROLL",
]);

/**
 * Totals exactly as the stub prints them (null where this provider doesn't print one).
 * `gross*` is cash gross pay (imputed income excluded); `withheld*` is every tax and
 * deduction taken from it.
 */
export type PrintedTotals = {
  grossCurrent: number | null;
  grossYtd: number | null;
  withheldCurrent: number | null;
  withheldYtd: number | null;
  netCurrent: number;
  netYtd: number | null;
};

export type PayStubSource = "TRINET" | "VENSURE" | "ADP";

export type PayStubFacts = {
  source: PayStubSource;
  /** As printed; matched to a household member by the tax profile's name rules. */
  employee: string;
  employer: string;
  /**
   * The provider's payroll company code (ADP "CO."), when printed. A move to another
   * payroll company under the same employer name restarts year-to-date totals, so each
   * code is its own chain of stubs.
   */
  payrollCode?: string | null;
  /** YYYY-MM-DD */
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  federalFilingStatus: string | null;
  lines: StubLine[];
  printed: PrintedTotals;
  /** Where the net pay went (a paycheck can be split across accounts). */
  deposits: { last4: string | null; amount: number }[];
  /** Extraction notes (never silent: shown on Statements → Issues). */
  warnings: string[];
};

/**
 * Employer identity for grouping stubs: providers print the same employer slightly
 * differently ("Acme Capital Advisory Group LP", "ACME CAPITAL ADVISORY GROUP, L.P."),
 * and one employer can pay through several payroll companies (" #CODE"), each with its
 * own year-to-date totals.
 */
export function employerKey(employer: string, payrollCode?: string | null): string {
  const base = employer
    .toUpperCase()
    .replace(/^EARNINGS STATEMENT\s+/, "")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\b(L ?L ?C|L ?P|INC|CORP(ORATION)?|CO|LTD|COMPANY)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return payrollCode ? `${base} #${payrollCode.toUpperCase()}` : base;
}

/** The payroll company code an employer key carries, if any. */
export const payrollCodeOf = (key: string): string | null => key.split(" #")[1] ?? null;
