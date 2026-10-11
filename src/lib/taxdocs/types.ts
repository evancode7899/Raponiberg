import type { ReturnLine } from "./lines.ts";

/**
 * The tax documents folder (TAX_DOCS_DIR): filed returns, W-2s, 1099s, K-1s and the like,
 * one subfolder per year. Each PDF is read once into one of these and kept in
 * data/tax-documents.json (gitignored, backed up with data/), so the tax pages never touch
 * the PDFs. Money is integer cents throughout, except a filed return's raw lines, which
 * keep the whole dollars (and decimals) the form printed.
 */

export type TaxDocKind =
  | "RETURN_FEDERAL"
  | "RETURN_CT"
  | "RETURN_NY"
  | "W2"
  | "1099_BROKERAGE"
  | "1099_INT"
  | "1099_R"
  | "5498_SA"
  | "K1"
  /** Canadian slips and returns (T4, T1): kept for the record, not modeled. */
  | "FOREIGN"
  /** Pay stubs, bank statements, worksheets and anything else in the folder. */
  | "OTHER";

export const TAX_DOC_KIND_LABEL: Record<TaxDocKind, string> = {
  RETURN_FEDERAL: "Federal return",
  RETURN_CT: "Connecticut return",
  RETURN_NY: "New York return",
  W2: "W-2",
  "1099_BROKERAGE": "Brokerage 1099",
  "1099_INT": "1099-INT",
  "1099_R": "1099-R",
  "5498_SA": "5498-SA (HSA)",
  K1: "Schedule K-1",
  FOREIGN: "Foreign tax slip",
  OTHER: "Other",
};

export type W2Form = {
  employer: string;
  ein: string | null;
  employee: string;
  wages: number;
  federalWithheld: number;
  ssWages: number;
  ssWithheld: number;
  medicareWages: number;
  medicareWithheld: number;
  dependentCare: number;
  /** Box 12 entries: D (401k), W (HSA employer + pre-tax), DD (health coverage, informational), C (GTL)… */
  box12: { code: string; amount: number }[];
  states: { state: string; wages: number; withheld: number }[];
  locals: { name: string; wages: number; withheld: number }[];
};

export type Brokerage1099 = {
  payer: string;
  recipient: string;
  /** Last four of the account number. */
  account: string | null;
  div: {
    ordinary: number;
    qualified: number;
    capitalGainDistributions: number;
    unrecaptured1250: number;
    nondividend: number;
    federalWithheld: number;
    section199a: number;
    foreignTax: number;
    exemptInterest: number;
  };
  int: { interest: number; earlyWithdrawalPenalty: number; usTreasury: number; federalWithheld: number; foreignTax: number; taxExempt: number };
  misc: { other: number; substitutePayments: number };
  b: { shortTermProceeds: number; shortTermBasis: number; shortTermGain: number; longTermProceeds: number; longTermBasis: number; longTermGain: number; unknownTermGain: number; washDisallowed: number };
};

export type Int1099 = {
  payer: string;
  recipient: string;
  account: string | null;
  interest: number;
  earlyWithdrawalPenalty: number;
  usTreasury: number;
  federalWithheld: number;
  taxExempt: number;
  foreignTax: number;
};

export type R1099 = {
  payer: string;
  recipient: string;
  account: string | null;
  gross: number;
  taxable: number;
  taxableNotDetermined: boolean;
  federalWithheld: number;
  /** Box 7: "G" direct rollover, "1" early, "7" normal, "2" exception… */
  codes: string;
  ira: boolean;
};

export type Sa5498 = { trustee: string; recipient: string; contributions: number; rollover: number; fairMarketValue: number };

export type K1Form = {
  partnership: string;
  ein: string | null;
  partner: string;
  limitedPartner: boolean;
  final: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  /** Boxes 1–3: passive for a limited partner. */
  ordinaryBusiness: number;
  rentalRealEstate: number;
  otherRental: number;
  guaranteedPayments: number;
  interest: number;
  ordinaryDividends: number;
  qualifiedDividends: number;
  royalties: number;
  shortTermGain: number;
  longTermGain: number;
  section1231: number;
  foreignTax: number;
};

/** The figures the checks compare, from a filed return's lines (cents; null when not printed). */
export type FederalReturnSummary = Record<FederalKey, number | null>;
export type FederalKey =
  | "wages"
  | "taxExemptInterest"
  | "taxableInterest"
  | "qualifiedDividends"
  | "ordinaryDividends"
  | "iraDistributions"
  | "iraTaxable"
  | "pensionsTaxable"
  | "capitalGain"
  | "additionalIncome"
  | "totalIncome"
  | "adjustments"
  | "agi"
  | "deduction"
  | "qbiDeduction"
  | "taxableIncome"
  | "tax"
  | "amt"
  | "childCredit"
  | "otherCredits"
  | "otherTaxes"
  | "additionalMedicareTax"
  | "niit"
  | "totalTax"
  | "w2Withholding"
  | "otherWithholding"
  | "estimatedPayments"
  | "excessSsCredit"
  | "refundableCredits"
  | "totalPayments"
  | "refund"
  | "appliedToNextYear"
  | "amountOwed"
  | "penalty"
  | "hsaDeduction"
  | "hsaEmployer"
  | "section199aDividends";

export type StateKey =
  | "federalAgi"
  | "stateAgi"
  /** Part-year / nonresident: income from the state's sources (CT-SI line 30, IT-203 NY column). */
  | "sourceIncome"
  | "incomePercentage"
  | "taxBeforeAllocation"
  | "incomeTax"
  | "otherStateCredit"
  | "cityTax"
  | "totalTax"
  | "withheld"
  | "cityWithheld"
  | "estimatedPayments"
  | "totalPayments"
  | "refund"
  | "amountOwed"
  | "usObligationSubtraction"
  | "chet";
export type StateReturnSummary = Record<StateKey, number | null>;

export type FiledReturn = {
  jurisdiction: "FEDERAL" | "CT" | "NY";
  /** The main form: 1040, 1040X, CT-1040, CT-1040NR/PY, IT-201, IT-203. */
  form: string;
  filingStatus: "MFJ" | "MFS" | "SINGLE" | "HOH" | null;
  /** "Printed on" date, when the software stamps one (ISO). */
  printedOn: string | null;
  /** Part-year residents: the move date the state form records (ISO). */
  movedOn: string | null;
  lines: ReturnLine[];
  /** Schedule 1 line 8z: other income items as described on the return. */
  otherIncome: { label: string; amount: number }[];
  federal: FederalReturnSummary | null;
  state: StateReturnSummary | null;
};

export type TaxDocParsed =
  | { kind: "RETURN_FEDERAL" | "RETURN_CT" | "RETURN_NY"; ret: FiledReturn }
  | { kind: "W2"; w2: W2Form }
  | { kind: "1099_BROKERAGE"; f1099: Brokerage1099 }
  | { kind: "1099_INT"; int: Int1099 }
  | { kind: "1099_R"; r: R1099 }
  | { kind: "5498_SA"; sa: Sa5498 }
  | { kind: "K1"; k1: K1Form }
  | { kind: "FOREIGN" | "OTHER" };

export type TaxDoc = {
  /** First 16 hex of the file's SHA-256: the same file in two places is one document. */
  id: string;
  /** Path inside the tax folder, with forward slashes. */
  file: string;
  /** Other paths holding the identical file. */
  duplicates: string[];
  year: number | null;
  kind: TaxDocKind;
  /** A rejected e-file, a preview superseded by the filed copy, or an older print of the same return. */
  superseded: string | null;
  /** The person's name as printed (employee, recipient, partner, first taxpayer). */
  names: string[];
  parsed: TaxDocParsed;
  /** What couldn't be read, in words. */
  warnings: string[];
};

export type TaxDocsFile = {
  version: number;
  scannedAt: string;
  folder: string;
  docs: TaxDoc[];
  /** Files that couldn't be opened at all. */
  errors: { file: string; error: string }[];
};
