import { type Amount } from "../book/said.ts";
import { type BookBrokerage } from "../book/load.ts";
import { type BlockerRef } from "../book/reports/blockerRef.ts";
import { type ChetYear, type ExcessDeferral } from "../book/taxAdvantaged.ts";
import { type BonusCheck } from "./bonusGap.ts";
import { type TaxForecastLink } from "../forecast/forecast.ts";
import { type FiledReturn, type K1Form, type TaxDoc } from "../taxdocs/types.ts";
import { type NyFiling, type PersonIncome, type QbiBusiness, type ReturnResult, type SafeHarbor } from "./computeReturn.ts";
import { type DocRef } from "./documents.ts";
import { type AccountTaxKind, type DistributionRow } from "./facts/investments.ts";
import { type TaxPaymentRow } from "./facts/payments.ts";
import { type PayrollAmounts, type PayrollProjection, type W2Boxes } from "./facts/payroll.ts";
import { type FiledCheck } from "./filedCheck.ts";
import { type K1Adds, type K1Gap, type K1Items } from "./k1.ts";
import { type PassiveOutcome } from "./passive.ts";
import { type K1Detail } from "./k1DetailStore.ts";

import { type TaxYearParams } from "./params.ts";
import { type MfsResult } from "./scenarios.ts";
import { type NyResidency, type Residency, type TaxProfile, type YearInputs } from "./profile.ts";

/** A brokerage statement's tax figures for one account, as stored in the Book. */
export type FidelitySnapshot = BookBrokerage;

/**
 * The tax page's whole picture for one year, from the Book: per-person W-2 build-up from
 * proven pay stubs, investment income from brokerage statements and bank interest, tax
 * payments from the bank ledger, the joint and separate returns, the dependent's effect,
 * and whether a true-up payment is needed before year end. A year whose pay, investment
 * income or bank coverage isn't proven returns only its blockers.
 */

export type InvestmentFigures = {
  ordinaryDividends: number;
  qualifiedDividends: number;
  moneyMarketDividends: number;
  interest: number;
  capGainDistShort: number;
  capGainDistLong: number;
  shortTermGain: number;
  longTermGain: number;
  foreignTax: number;
  taxExempt: number;
  /** 1099-DIV box 5 (REIT dividends, eligible for the QBI deduction). */
  section199a: number;
  /** 1099-INT box 3 (US Treasury interest, exempt from state tax). */
  usTreasury: number;
};

export const ZERO_INV: InvestmentFigures = {
  ordinaryDividends: 0,
  qualifiedDividends: 0,
  moneyMarketDividends: 0,
  interest: 0,
  capGainDistShort: 0,
  capGainDistLong: 0,
  shortTermGain: 0,
  longTermGain: 0,
  foreignTax: 0,
  taxExempt: 0,
  section199a: 0,
  usTreasury: 0,
};

export type AccountIncome = {
  accountNumber: string;
  label: string;
  kind: FidelitySnapshot["kind"];
  ownerId: string;
  ownerLine: string;
  latestStatement: string;
  ytd: InvestmentFigures;
  projected: InvestmentFigures;
  /** Multiplier from YTD to full-year dividends/interest, and how it was chosen. */
  projection: { factor: number; method: "FINAL" | "SEASONAL" | "LINEAR" };
  distributions: DistributionRow[];
  contributionsYtd: number | null;
  isChet: boolean;
  endingValue: number | null;
  /** The type the statement says (`kind` is this unless overridden under Inputs). */
  statementKind: AccountTaxKind;
  /** A custodial account's child (a dependent's name, else the statement's owner line). */
  child: string | null;
  /**
   * Where the figures come from: the statements, or the year's 1099 (a finished year with
   * the form on file), whose figures replace the statements'. `fromStatements` keeps what
   * the statements said, to check one against the other.
   */
  source: "STATEMENTS" | "1099";
  doc: DocRef | null;
  fromStatements: InvestmentFigures | null;
  /**
   * The statements' dividends paid in January that aren't money-market (ISO date, cents).
   * A fund's December-declared dividend paid in January is taxed in the year before (IRC
   * §852(b)(7)), so the year's 1099 may not print it.
   */
  januaryDividends: { date: string; amount: number }[];
  /** Qualified and REIT (199A) shares of dividends taken from last year's 1099 for the account, when there is one. */
  calibratedFrom: number | null;
};

/** A partnership K-1 counted on a person's return (or, for a year in progress, last year's repeated as an estimate). */
export type K1Use = {
  partnership: string;
  doc: DocRef;
  estimate: boolean;
  /** Where a year in progress gets it: the partnership's expected figures (K-1 details file), or last year's K-1 again, scaled to twelve months when it covered fewer. */
  basis: "DOCUMENT" | "EXPECTED" | "REPEATED" | "ANNUALIZED";
  /** The K-1 as read (or as expected), and what its attached statements say (the K-1 details file). */
  form: K1Form;
  detail: K1Detail | null;
  /** What of it hasn't been read yet (tax/k1.ts k1Gaps): its lettered boxes with no line in the details file. */
  gaps: K1Gap[];
  /** The K-1 sorted into the return's places (tax/k1.ts). */
  items: K1Items;
  /** Its passive-loss outcome for the year (Form 8582); null when its activity isn't passive for this partner. */
  passive: PassiveOutcome | null;
  /** What it adds to each line of its owner's return, after the passive-loss limit: the model without it is the return less these. */
  adds: K1Adds;
  /** Its trade or business for the 20% deduction, when it reports one. */
  qbi: QbiBusiness | null;
};

/** One payroll employer's W-2 figures, with where they came from. */
export type PayrollEntry = PayrollProjection & {
  active: boolean;
  /** The W-2 form on file (a finished year): its boxes replace the stubs' arithmetic. */
  w2Doc: DocRef | null;
  /** The W-2 the pay stubs imply, kept when a form replaced it. */
  stubW2: W2Boxes | null;
};

/**
 * A child's own investment income (custodial accounts). It's the child's, so it's not on
 * the parents' return: under `exempt` it's untaxed; above, a return is due for the child,
 * and above `threshold` the excess is taxed at the parents' rate (Form 8615). Parents may
 * report it on their return instead (Form 8814), which this estimate doesn't model.
 */
export type ChildIncome = {
  name: string;
  accounts: string[];
  ytd: number;
  projected: number;
  rule: "UNDER_EXEMPT" | "CHILD_RATE" | "KIDDIE_TAX";
  /** Form 8814 needs only interest, dividends and capital-gain distributions, under the cap. */
  parentElectionAllowed: boolean;
  limits: TaxYearParams["federal"]["kiddie"];
};

export type PersonReport = {
  id: string;
  name: string;
  /**
   * The year in progress takes its paycheck basis and the bonuses still to come from the
   * shared forecast (lib/forecast): `bonus` is what it pays after the latest stub counted
   * here, on top of any extra typed under Inputs. Null for other years.
   */
  fromForecast: { paycheck: "LATEST" | "TYPICAL"; bonus: number; items: ({ label: string; gross: number } & Partial<Pick<TaxForecastLink["bonuses"][number], "key" | "date" | "source" | "window">>)[] } | null;
  payrollSource: "STUBS" | "W2" | "NONE";
  /** Pay taken from year-to-date totals only (earlier stubs not available). */
  partial: string[];
  /** The amounts those partial notes print (their inferences' title amounts, lib/book/said.ts). */
  partialAmounts: Amount[];
  payroll: PayrollEntry[];
  accounts: AccountIncome[];
  retirement: { conversions: number; basis: number; rollovers: number; otherDistributions: number; taxable: number; source: "STATEMENTS" | "1099-R" };
  /**
   * 401(k) deferrals across employers (W-2 box 12 D + AA) against the limit. An excess is
   * counted in other income for the year; `excessDeferral` says whether the plan returned it.
   */
  k401: { limit: number; deferred: { ytd: number; projected: number }; excess: { ytd: number; projected: number }; excessDeferral: ExcessDeferral | null };
  k1s: K1Use[];
  /** Income from Connecticut sources (part-year or nonresident), and how it was worked out; null for a full-year resident. */
  ctSource: { total: number; wages: number; investment: number; other: number; investmentShare: number } | null;
  /** New York's amount column (part-year or nonresident New York), worked out the same way; null when not filed or a full-year resident. */
  nySource: { total: number; wages: number; investment: number; other: number; investmentShare: number } | null;
  /** Return inputs projected to Dec 31 (what the scenarios use). */
  income: PersonIncome;
  /** Return inputs as of the latest stubs/statements: what the year would look like if it ended today. */
  incomeYtd: PersonIncome;
  /** Pay-stub totals across employers, year to date and projected. */
  payrollTotals: { ytd: PayrollAmounts; projected: PayrollAmounts };
  /** The year's bonus paychecks (bonusChecksOf): stubs paid so far, then the forecast's bonuses still to come. */
  bonusChecks: BonusCheck[];
  /** Taxes actually paid so far this year (withholding to date + estimates paid). */
  paidToDate: { federal: number; socialSecurity: number; medicare: number; ct: number; ctPfml: number; otherState: number; estimatesFederal: number; estimatesCt: number };
};

export type { MfsResult };
export type { BonusCheck };

export type TaxReport = {
  blocked: false;
  year: number;
  today: string;
  isCurrentYear: boolean;
  paramsNotes: string[];
  profile: TaxProfile;
  inputs: YearInputs;
  people: PersonReport[];
  /** Every investment account with statements this year, whoever it belongs to. */
  accounts: AccountIncome[];
  /** CHET 529 contributions for the year (book/taxAdvantaged.ts, shared with the Tax-advantaged accounts page). */
  chet: ChetYear;
  children: ChildIncome[];
  dependents: { name: string; age: number }[];
  payments: TaxPaymentRow[];
  /**
   * How the year is filed: jointly, or Single when the year's filed federal return says so
   * (before the marriage). A Single year has one person in `people`, the filer, and
   * `scenarios.mfj` holds their Single return; there's no joint-vs-separate choice.
   */
  filingStatus: "MFJ" | "SINGLE";
  scenarios: {
    /** The household's return: joint, or the filer's Single return (see filingStatus). */
    mfj: ReturnResult;
    mfjNoDependents: ReturnResult;
    mfs: MfsResult;
    mfsNoDependents: MfsResult;
  };
  marginal: { federal: number; ct: number; ny: number; payroll: number };
  /** New York's, where the year has a New York return. */
  safeHarbor: { federal: SafeHarbor; ct: SafeHarbor; ny: SafeHarbor | null };
  /**
   * Where last year's federal tax for the safe harbor came from: the filed return as
   * entered under Inputs, last year's filed return in the tax documents folder, or this
   * model's own estimate of last year from the Book.
   */
  priorYearSource: "ENTERED" | "FILED" | "ESTIMATED" | "NONE";
  /** Connecticut residency used for the year, and where it came from. */
  residency: Residency & { source: "INPUTS" | "FILED_RETURN" | "DEFAULT" };
  /**
   * New York for the year (null: no New York return): as entered, from the filed New York
   * return, or from New York withholding on the W-2s and pay stubs. `filing` is what the
   * return engine takes.
   */
  ny: (NyResidency & { source: "INPUTS" | "FILED_RETURN" | "WITHHOLDING"; filing: NyFiling }) | null;
  /** Last year's figures the safe harbor and the Inputs tab show, with where each came from. */
  priorYear: {
    federalTax: number | null;
    federalAgi: number | null;
    ctTax: number | null;
    /** The filed returns they were read from (tax documents folder), when they were. */
    file: string | null;
    ctFile: string | null;
  };
  /**
   * The year's tax documents (tax documents folder): what's on file, the filed returns'
   * figures, and the line-by-line check of this model against them. Null when the folder
   * isn't set up or holds nothing for the year.
   */
  documents: {
    files: { id: string; file: string; kind: TaxDoc["kind"]; superseded: string | null; warnings: string[]; personId: string | null }[];
    filed: { federal: FiledReturn | null; ct: FiledReturn | null; ny: FiledReturn | null };
    check: FiledCheck | null;
  } | null;
  /**
   * A year still in progress is a forecast: it's shown even while recent documents
   * aren't cross-checked yet (e.g. pay stubs newer than the bank statements). These are
   * the open findings that would block the year once it's over.
   */
  unverified: BlockerRef[];
  /**
   * Bank interest as counted (1099-INT): each account's ledger interest from January 1
   * through `through`, or its 1099-INT (a finished year), with its owner ("JOINT" splits
   * evenly); a year in progress runs it to December 31 by `factor` (365 ÷ days so far).
   */
  bankInterest: {
    through: string;
    factor: number;
    /** `ledgerCents`: with a 1099-INT counted, what the account's bank statements show for the year (null: no tracked account), checked against it (tax.documents-tie). */
    parts: { accountId: string | null; name: string; ownerId: string; cents: number; doc: DocRef | null; rowIds: string[]; ledgerCents?: number | null }[];
  };
  /** How far each source goes: the forecast fills in everything after these dates. */
  dataThrough: { payStubs: { person: string; employer: string; date: string }[]; statements: string | null; bank: string };
  plan: {
    /** Pay dates still ahead of today for the person with the most left (a W-4 change can only reach these). */
    remainingPaychecks: number;
    paycheckPerson: string | null;
    federal: TruePlan;
    ct: TruePlan;
    ny: TruePlan | null;
    q4DueDate: string;
    filingDate: string;
  };
  warnings: string[];
  assumptions: string[];
  /** The amounts the notes print (warnings, assumptions, the filed check's notes), each filed under its sentence (lib/book/said.ts). */
  said?: Amount[];
  /** The rules the estimate follows (tax law, and the choices under Inputs): words, never a figure read from the data. */
  rules: string[];
};

export type TruePlan = {
  /** To avoid the underpayment penalty (safe harbor). */
  safeHarborShortfall: number;
  /** To owe ~nothing at filing. */
  projectedBalanceDue: number;
  perPaycheckForSafeHarbor: number | null;
  perPaycheckToBreakEven: number | null;
  /** The estimated-tax dates still to come, with what each asks for (installmentsDue). */
  installments: { quarter: number; date: string; cents: number }[];
};

export type TaxReportBlocked = { blocked: true; year: number; today: string; profile: TaxProfile; inputs: YearInputs; blockers: BlockerRef[] };
