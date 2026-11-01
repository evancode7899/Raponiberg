import { taxBlockers, taxYearThrough, yearProvenToEnd } from "../book/blockers.ts";
import type { Book, BookBrokerage, BookStub } from "../book/load.ts";
import { personPayYear } from "../book/pay.ts";
import { refs, type BlockerRef } from "../book/reports/blockerRef.ts";
import { chetYear, excessDeferral, excessDeferralMessage, iraYear, k401Limit, statementContributionsYtd, taxableConversion, type ChetYear, type ExcessDeferral } from "../book/taxAdvantaged.ts";
import { taxRows } from "../book/taxPayments.ts";
import type { TaxForecastLink } from "../forecast/forecast.ts";
import type { FiledReturn, TaxDoc } from "../taxdocs/types.ts";
import { computeReturn, safeHarbor, type NyFiling, type PersonIncome, type ReturnResult, type SafeHarbor, type W2 } from "./computeReturn.ts";
import {
  ctResidentShares,
  filedBalance,
  k1Income,
  matchW2s,
  NYC_LOCALITY,
  safeHarborTax,
  w2FromForm,
  yearDocs,
  type DocRef,
  type YearDocs,
} from "./documents.ts";
import { ACCOUNT_KIND_LABEL, CHILD_KINDS, type AccountTaxKind, type DistributionRow } from "./facts/investments.ts";
import { taxPaymentsFrom, type FiledBalances, type TaxPaymentRow } from "./facts/payments.ts";
import { amountsFromLines, projectPayroll, w2FromAmounts, ZERO_AMOUNTS, type PayrollAmounts, type PayrollProjection, type W2Boxes } from "./facts/payroll.ts";
import { checkFiled, type FiledCheck } from "./filedCheck.ts";
import { TAX_YEARS, taxYearParams, type TaxYearParams } from "./params.ts";
import { bestSeparate, type MfsResult } from "./scenarios.ts";
import { ageAtYearEnd, EXTRA_FIELDS, yearInputs, type NyResidency, type PayForecast, type Residency, type TaxPerson, type TaxProfile, type YearInputs } from "./profile.ts";

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

const ZERO_INV: InvestmentFigures = {
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
  figures: ReturnType<typeof k1Income>;
  /** A net passive loss with no passive income to absorb it: carried forward (Form 8582), not deducted. */
  suspendedLoss: number;
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
  /** Taxes actually paid so far this year (withholding to date + estimates paid). */
  paidToDate: { federal: number; socialSecurity: number; medicare: number; ct: number; ctPfml: number; otherState: number; estimatesFederal: number; estimatesCt: number };
};

export type { MfsResult };

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
  safeHarbor: { federal: SafeHarbor; ct: SafeHarbor };
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
    q4DueDate: string;
    filingDate: string;
  };
  warnings: string[];
  assumptions: string[];
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
};

export type TaxReportBlocked = { blocked: true; year: number; today: string; profile: TaxProfile; inputs: YearInputs; blockers: BlockerRef[] };

const pos = (n: number) => Math.max(0, n);
const minIso = (a: string, b: string) => (a < b ? a : b);
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/**
 * Income tax on one more dollar of the top earner's wages: federal (which already holds the
 * 0.9% Additional Medicare surtax) + Connecticut + New York. The one "marginal rate" every
 * page means by it (Account limits' pre-tax steps, the HSA's tax saved); payroll tax is
 * `marginal.payroll`, apart. A 401(k) or HSA dollar avoids all three: New York follows the
 * federal treatment of both.
 */
export const incomeTaxMarginal = (t: Pick<TaxReport, "marginal">): number => t.marginal.federal + t.marginal.ct + t.marginal.ny;

export function buildTaxReport(
  book: Book,
  year: number,
  opts: { estimatePriorYear?: boolean; forecast?: TaxForecastLink | null } = {},
): TaxReport | TaxReportBlocked {
  const today = book.today;
  const params = taxYearParams(year);
  const fp = params.federal;
  const profile = book.taxProfile;
  const inputs = yearInputs(profile, year);
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const isCurrentYear = Number(today.slice(0, 4)) === year;
  // The current year runs through the data edge: stubs after it count once the bank
  // statements showing their deposits are on file.
  const through = taxYearThrough(book, year);

  // ---------------------------------------------------------------- proof
  // Pay, investment income and the bank accounts holding interest and tax payments must
  // all be proven for the year (through the cash-flow horizon for the current year). A
  // finished year with open findings shows only its blockers; the year in progress is a
  // forecast, so its open findings are listed alongside it instead of hiding it.
  const bankIds = book.accounts.filter((a) => a.group === "Cash").map((a) => a.id);
  const blockers = refs(taxBlockers(book, year));
  const isForecast = Number(today.slice(0, 4)) <= year;
  // A finished year's W-2s, 1099s and filed return (tax documents folder) are its figures of
  // record: with the filed return on file, open ledger findings don't hide the year.
  const docs = yearDocs(book.taxDocs, year, profile.persons);
  const lastYearDocs = yearDocs(book.taxDocs, year - 1, profile.persons);
  const useDocs = !isForecast;
  // A finished year whose statements don't reach December 31st yet (the spring, before every
  // account's December statement is on file) would show part of a year as the whole: it
  // waits for them, unless its filed return is on file as the year's figures of record.
  if (!isForecast && !yearProvenToEnd(book, year) && !docs.federal)
    blockers.push({
      id: `tax.year-awaiting:${year}`,
      status: "MISSING",
      title: `${year} is proven only through ${through}`,
      fix: `Add every account's statements through December 31, ${year}: until then the year's pay, interest and payments would cover only part of it.`,
    });
  if (blockers.length && !isForecast && !docs.federal) return { blocked: true, year, today, profile, inputs, blockers };
  // A Single year (its filed return says so) is the filer's return alone: the person whose
  // W-2s are on file, else the first. Everyone's names still decide whose accounts and forms
  // are left off it.
  const filingStatus: TaxReport["filingStatus"] = useDocs && docs.federal?.filingStatus === "SINGLE" ? "SINGLE" : "MFJ";
  const w2Owners = [...new Set(docs.w2s.flatMap((w) => (w.personId ? [w.personId] : [])))];
  const filers = filingStatus === "SINGLE" ? [profile.persons.find((p) => w2Owners.length === 1 && p.id === w2Owners[0]) ?? profile.persons[0]!] : profile.persons;

  const personFor = (text: string): TaxPerson | undefined => {
    const u = text.toUpperCase();
    return profile.persons.find((p) => p.match.some((m) => u.includes(m)));
  };

  // ---------------------------------------------------------------- payroll
  const stubsByPerson = new Map<string, BookStub[]>();
  const partialByPerson = new Map<string, string[]>();
  for (const p of profile.persons) {
    const pay = personPayYear(book, p.id, year, through);
    stubsByPerson.set(p.id, pay.employers.flatMap((e) => e.stubs));
    partialByPerson.set(p.id, pay.partial.map((i) => i.title));
  }

  // ---------------------------------------------------------------- payments
  // The filed returns say whether a spring payment settled last year or started this one.
  const filedBalances: FiledBalances = {};
  for (const d of [lastYearDocs, docs]) {
    filedBalances[d.year] = { FEDERAL: filedBalance(d.federal), CT: filedBalance(d.ct), OTHER_STATE: filedBalance(d.ny) };
  }
  const payments = taxPaymentsFrom(taxRows(book, `${year}-01-01`, minIso(`${year + 1}-04-30`, book.horizon.cashFlow)), inputs.paymentOverrides, filedBalances);
  const forYear = (a: TaxPaymentRow["authority"], kind: string) =>
    payments.filter((p) => p.authority === a && p.attribution.taxYear === year && p.attribution.kind === kind);
  const estFederal = forYear("FEDERAL", "ESTIMATE").reduce((s, p) => s + p.amount, 0);
  const estCt = forYear("CT", "ESTIMATE").reduce((s, p) => s + p.amount, 0);
  const estFederalToDate = forYear("FEDERAL", "ESTIMATE").filter((p) => p.date <= today).reduce((s, p) => s + p.amount, 0);
  const estCtToDate = forYear("CT", "ESTIMATE").filter((p) => p.date <= today).reduce((s, p) => s + p.amount, 0);
  const estNy = forYear("OTHER_STATE", "ESTIMATE").reduce((s, p) => s + p.amount, 0);
  const estNyToDate = forYear("OTHER_STATE", "ESTIMATE").filter((p) => p.date <= today).reduce((s, p) => s + p.amount, 0);
  // CT balance-due payments made during this calendar year are deductible SALT this year.
  const ctPaidForPrior = payments
    .filter((p) => p.authority !== "FEDERAL" && p.date.startsWith(String(year)) && p.attribution.kind === "BALANCE_DUE" && p.attribution.taxYear < year)
    .reduce((s, p) => s + p.amount, 0);

  // ---------------------------------------------------------------- investments
  const accounts = investmentAccounts(book.brokerage, year, profile, personFor, warnings);
  applyBrokerage1099s(accounts, useDocs ? docs : null, lastYearDocs, profile, warnings);
  const children = childIncome(accounts, fp.kiddie, year, isForecast, warnings, assumptions);

  // Bank interest (1099-INT): an account named for one person is theirs, else joint. A
  // finished year's 1099-INT replaces the ledger's interest for its account.
  const interestThrough = minIso(`${year}-12-31`, book.horizon.cashFlow);
  const interestByAccount = new Map<string, number>();
  const interestRows = new Map<string, string[]>();
  for (const r of book.rows) {
    if (r.lane !== "INCOME" || r.category !== "Interest" || !bankIds.includes(r.accountId) || r.date < `${year}-01-01` || r.date > interestThrough) continue;
    interestByAccount.set(r.accountId, (interestByAccount.get(r.accountId) ?? 0) + r.amountCents);
    interestRows.set(r.accountId, [...(interestRows.get(r.accountId) ?? []), r.id]);
  }
  // Each part as counted, for the estimate's proof (book/proof/taxEstimateProof).
  const interestParts: TaxReport["bankInterest"]["parts"] = [];
  const interestYtd = new Map<string, number>();
  const interestForms = new Set<string>();
  const add = (owner: string, cents: number, part: Omit<TaxReport["bankInterest"]["parts"][number], "ownerId" | "cents">) => {
    interestYtd.set(owner, (interestYtd.get(owner) ?? 0) + cents);
    interestParts.push({ ...part, ownerId: owner, cents });
  };
  const ownerOfAccount = (id: string) => {
    const name = book.accounts.find((a) => a.id === id)?.name.toUpperCase() ?? "";
    return profile.persons.find((p) => p.match.some((m) => name.includes(m)))?.id ?? "JOINT";
  };
  const intForms = useDocs ? docs.ints : [];
  for (const id of bankIds) {
    const acct = book.accounts.find((a) => a.id === id)!;
    const form = intForms.find((f) => f.form.account && acct.identifiers.some((i) => i.endsWith(f.form.account!)));
    if (form) {
      interestForms.add(form.doc.id);
      add(form.personId ?? ownerOfAccount(id), form.form.interest, { accountId: id, name: acct.name, doc: form.doc, rowIds: [], ledgerCents: interestByAccount.get(id) ?? 0 });
    } else if (interestByAccount.has(id)) add(ownerOfAccount(id), interestByAccount.get(id)!, { accountId: id, name: acct.name, doc: null, rowIds: interestRows.get(id)! });
  }
  // A 1099-INT for an account the ledger doesn't track still counts.
  for (const f of intForms.filter((f) => !interestForms.has(f.doc.id))) add(f.personId ?? "JOINT", f.form.interest, { accountId: null, name: `${f.form.payer} ••${f.form.account ?? "?"}`, doc: f.doc, rowIds: [], ledgerCents: null });
  const daysIn = (Date.parse(interestThrough) - Date.parse(`${year}-01-01`)) / 86_400_000 + 1;
  const interestFactor = isCurrentYear && daysIn > 0 ? 365 / daysIn : 1;
  const bankInterest = (personId: string, pick: "ytd" | "projected") => {
    const own = (interestYtd.get(personId) ?? 0) + (interestYtd.get("JOINT") ?? 0) / filers.length;
    return Math.round(pick === "ytd" ? own : own * interestFactor);
  };

  // Connecticut residency: as entered, else what the year's filed CT return shows (a
  // CT-1040NR/PY is a part-year return; a New York return and no CT one, a nonresident).
  const residency = residencyFor(inputs.residency, docs, year);
  // New York: as entered, else the filed New York return, else New York withholding this year.
  const nyWithheld = { state: false, city: false };
  for (const w of useDocs ? docs.w2s : []) {
    if (w.form.states.some((s) => s.state === "NY" && (s.wages > 0 || s.withheld > 0))) nyWithheld.state = true;
    if (w.form.locals.some((l) => NYC_LOCALITY.test(l.name) && l.withheld > 0)) nyWithheld.city = true;
  }
  for (const stubs of stubsByPerson.values()) {
    for (const st of stubs) {
      const a = amountsFromLines(st.lines, "current");
      if (a.nyWithheld > 0) nyWithheld.state = true;
      if (a.nycWithheld > 0) nyWithheld.city = true;
    }
  }
  const ny = nyFor(inputs.nyResidency, docs, residency, nyWithheld, year);
  const nyFiling = ny?.filing ?? null;

  // CHET 529 contributions, the same figures the Tax-advantaged accounts page shows.
  const chet = chetYear(book, year);
  warnings.push(...chet.mismatches);
  const chetByAccount = new Map(chet.accounts.map((a) => [a.accountNumber, a.cents]));

  const nPeople = filers.length;
  const people: PersonReport[] = filers.map((person) => {
    const { extras, pay: typedPay } = inputs.people[person.id]!;
    const stubs = stubsByPerson.get(person.id) ?? [];
    // The year in progress follows the forecast: its paycheck basis, and the bonuses it pays after the latest stub counted here.
    const lastStub = stubs.reduce((m, s) => (s.payDate > m ? s.payDate : m), "");
    const link = isCurrentYear && opts.forecast ? opts.forecast : null;
    const items = (link?.bonuses ?? []).filter((b) => b.personId === person.id && b.key.startsWith(`${year}-`) && (b.date ? b.date > lastStub : b.key >= lastStub.slice(0, 7)));
    const fromForecast: PersonReport["fromForecast"] = link
      ? { paycheck: link.paycheck[person.id] ?? typedPay.paycheck, bonus: items.reduce((t, b) => t + b.gross, 0), items: items.map((b) => ({ label: b.label, gross: b.gross, key: b.key, date: b.date, source: b.source, ...(b.window ? { window: b.window } : {}) })) }
      : null;
    const pay = fromForecast ? { ...typedPay, paycheck: fromForecast.paycheck } : typedPay;
    if (!stubs.length && isForecast) warnings.push(`No ${year} pay stubs for ${person.name}, so the forecast counts no wages for them. Upload their latest stub.`);
    const payroll: PayrollEntry[] = projectEmployers(stubs, params, extras.expectedBonus + (fromForecast?.bonus ?? 0), pay, isCurrentYear, through, warnings, person.name, !!fromForecast).map(
      (p) => ({ ...p, w2Doc: null, stubW2: null }),
    );
    // A finished year's W-2 forms replace what the stubs imply (each paired to its payroll by wages).
    const w2Forms = useDocs ? docs.w2s.filter((w) => w.personId === person.id) : [];
    if (w2Forms.length) {
      const { pairs, formsOnly, stubsOnly } = matchW2s(payroll, w2Forms);
      for (const [p, f] of pairs) {
        p.stubW2 = p.w2Ytd;
        p.w2Ytd = p.w2Projected = w2FromForm(f.form, p.w2Ytd);
        p.w2Doc = f.doc;
      }
      for (const f of formsOnly) payroll.push(formOnlyPayroll(f.form, f.doc, person.name));
      for (const p of stubsOnly) warnings.push(`${person.name}'s ${year} pay from ${p.employer} has no W-2 in the tax documents folder, so the pay stubs' figures are used. Add the W-2.`);
    } else if (useDocs && docs.federal && stubs.length) {
      warnings.push(`No ${year} W-2s for ${person.name} are in the tax documents folder; wages come from the pay stubs.`);
    }
    const payrollSource: PersonReport["payrollSource"] = payroll.some((p) => p.w2Doc) ? "W2" : stubs.length ? "STUBS" : "NONE";

    const mine = accounts.flatMap((a) => (a.ownerId === person.id ? [{ a, share: 1 }] : a.ownerId === "JOINT" ? [{ a, share: 1 / nPeople }] : []));
    const inv = (pick: "ytd" | "projected") => {
      const t = { ...ZERO_INV };
      for (const { a, share } of mine) {
        if (a.kind !== "TAXABLE") continue;
        for (const k of Object.keys(t) as (keyof InvestmentFigures)[]) t[k] += Math.round(a[pick][k] * share);
      }
      return t;
    };
    const invP = inv("projected");
    const invY = inv("ytd");

    // IRA: Roth conversions are taxable beyond basis (non-deductible contributions);
    // direct rollovers to an employer plan never are.
    const iras = mine.filter(({ a }) => ["TRADITIONAL_IRA", "ROLLOVER_IRA", "ROTH_IRA"].includes(a.kind)).map(({ a }) => a);
    const dists = iras.flatMap((a) => a.distributions);
    // Contributions and conversions come from the IRAs' ledger rows (every custodian's
    // statements carry them), shared with the Tax-advantaged accounts page.
    const ira = iraYear(book, person.id, year);
    warnings.push(...ira.mismatches);
    const conversions = ira.conversions;
    const rollovers = dists.filter((d) => d.kind === "ROLLOVER").reduce((s, d) => s + d.amount, 0);
    const otherDistributions = iras
      .filter((a) => a.kind !== "ROTH_IRA")
      .flatMap((a) => a.distributions)
      .filter((d) => d.kind === "DISTRIBUTION")
      .reduce((s, d) => s + d.amount, 0);
    const basis = ira.traditionalContributions + extras.iraBasisCarryforward;
    const pretaxLeft = ira.pretaxAccounts.reduce((s, a) => s + a.cents, 0);
    if (conversions > 0 && pretaxLeft > 100_000) {
      warnings.push(
        `${person.name} converted to Roth this year but still holds pre-tax IRA money (≈$${Math.round(pretaxLeft / 100).toLocaleString()}). The pro-rata rule makes part of the conversion taxable (Form 8606); this estimate applies it with the December 31 balance, or the latest one for a year in progress.`,
      );
    }
    if (otherDistributions > 0) warnings.push(`${person.name} took IRA withdrawals that aren't rollovers or conversions; they're counted as fully taxable (a 10% penalty may also apply before age 59½).`);
    // A finished year's 1099-Rs are what was reported; a rollover (code G/H) is never taxable,
    // and an undetermined taxable amount falls back to the statements' conversion arithmetic.
    const rForms = useDocs ? docs.rs.filter((r) => r.personId === person.id) : [];
    const fromStatementsTaxable = taxableConversion(conversions, basis, pretaxLeft) + otherDistributions;
    const retirementTaxable = rForms.length
      ? rForms.reduce((s, r) => s + (/[GH]/.test(r.form.codes) ? 0 : r.form.taxableNotDetermined ? 0 : r.form.taxable), 0) +
        (rForms.some((r) => r.form.taxableNotDetermined) ? fromStatementsTaxable : 0)
      : fromStatementsTaxable;

    // Partnership K-1s: a finished year's forms; for the year in progress, last year's again
    // (an estimate) for any partnership that didn't mark its K-1 final.
    const k1s: K1Use[] = [];
    const k1Forms = useDocs ? docs.k1s : isForecast ? lastYearDocs.k1s.filter((k) => !k.form.final) : [];
    for (const k of k1Forms.filter((k) => k.personId === person.id)) {
      const figures = k1Income(k.form);
      k1s.push({ partnership: k.form.partnership, doc: k.doc, estimate: !useDocs, figures, suspendedLoss: k.form.limitedPartner && figures.passive < 0 ? -figures.passive : 0 });
    }
    const k1 = (f: keyof ReturnType<typeof k1Income>) => k1s.reduce((s, k) => s + k.figures[f], 0);
    const k1Passive = k1s.reduce((s, k) => s + (k.suspendedLoss ? 0 : k.figures.passive), 0);
    for (const k of k1s.filter((k) => k.suspendedLoss)) {
      assumptions.push(
        `${person.name}'s K-1 from ${k.partnership}${k.estimate ? ` (last year's, as an estimate)` : ""} has a ${usd(k.suspendedLoss)} passive loss (boxes 1–3). As a limited partner with no passive income to offset, it's carried forward on Form 8582, not deducted.`,
      );
    }

    const chetCents = mine.filter(({ a }) => a.isChet).reduce((s, { a, share }) => s + Math.round((chetByAccount.get(a.accountNumber) ?? 0) * share), 0);

    // 401(k) deferrals above the limit (all employers together) are income for this year,
    // whether or not the plan hands the excess back; the return only decides whether it's
    // taxed a second time. Shared, word for word, with the Tax-advantaged accounts page.
    // Birth years come from the Book (Settings → Household), the copy every page's return reads.
    const birthYear = book.birthYears?.[person.id];
    const { limit: k401Cap } = k401Limit(fp, birthYear ? year - birthYear : null);
    const deferred = (w: "w2Ytd" | "w2Projected") => payroll.reduce((s, p) => s + p[w].box12.D + p[w].box12.AA, 0);
    const k401Deferred = { ytd: deferred("w2Ytd"), projected: deferred("w2Projected") };
    const k401Excess = { ytd: pos(k401Deferred.ytd - k401Cap), projected: pos(k401Deferred.projected - k401Cap) };
    const k401: PersonReport["k401"] = { limit: k401Cap, deferred: k401Deferred, excess: k401Excess, excessDeferral: excessDeferral(book, person.id, year, k401Excess.projected) };
    if (k401.excessDeferral) {
      const m = excessDeferralMessage(person.name, year, k401Cap, k401Deferred.projected, k401.excessDeferral);
      (m.ok ? assumptions : warnings).push(m.text);
    }
    const w2s: W2[] = payroll.map((p) => p.w2Projected);
    const half = (n: number) => Math.round(n / nPeople);
    const projectedIncome: PersonIncome = {
      id: person.id,
      name: person.name,
      w2s,
      taxableInterest: invP.interest + bankInterest(person.id, "projected") + k1("interest") + extras.extraInterest,
      ordinaryDividends: invP.ordinaryDividends + invP.capGainDistShort + k1("ordinaryDividends"),
      qualifiedDividends: invP.qualifiedDividends + k1("qualifiedDividends"),
      section199aDividends: invP.section199a,
      taxExemptInterest: invP.taxExempt,
      usObligationIncome: Math.round(invP.moneyMarketDividends * profile.moneyMarketUsGovShare) + invP.usTreasury + extras.usObligationIncome,
      capitalGainDistributions: invP.capGainDistLong,
      shortTermGain: invP.shortTermGain + extras.extraShortTermGain - extras.capitalLossCarryover + k1("shortTermGain"),
      longTermGain: invP.longTermGain + extras.extraLongTermGain + k1("longTermGain"),
      foreignTaxPaid: invP.foreignTax + k1("foreignTax"),
      retirementTaxable,
      otherIncome: extras.otherIncome + k1("otherIncome") + k1Passive + k401Excess.projected,
      businessIncome: 0,
      adjustments: extras.hsaOutsidePayroll + extras.otherAdjustments,
      ctChetContributions: chetCents,
      ctOtherSubtractions: 0,
      ctOtherAdditions: 0,
      estimatedFederal: half(estFederal) + extras.estimatedFederalExtra,
      estimatedCt: half(estCt) + extras.estimatedCtExtra,
      estimatedNy: nyFiling ? half(estNy) : 0,
      mortgageInterest: half(inputs.household.mortgageInterest),
      propertyTax: half(inputs.household.propertyTax),
      charitableCash: half(inputs.household.charitableCash),
      charitableOther: half(inputs.household.charitableOther),
      otherItemized: 0,
      dependentCareExpenses: half(inputs.household.dependentCareExpenses),
      dependentCareFsa: payroll.reduce((s, p) => s + p.w2Projected.box10, 0),
      otherStateTax: extras.otherStateTax,
      priorYearStateTaxPaid: half(ctPaidForPrior),
    };
    // Year to date: stubs and statements as they stand, no expected bonus or future sales.
    const incomeYtd: PersonIncome = {
      ...projectedIncome,
      w2s: payroll.map((p) => p.w2Ytd),
      taxableInterest: invY.interest + bankInterest(person.id, "ytd") + (useDocs ? k1("interest") : 0) + extras.extraInterest,
      ordinaryDividends: invY.ordinaryDividends + invY.capGainDistShort + (useDocs ? k1("ordinaryDividends") : 0),
      qualifiedDividends: invY.qualifiedDividends + (useDocs ? k1("qualifiedDividends") : 0),
      section199aDividends: invY.section199a,
      taxExemptInterest: invY.taxExempt,
      usObligationIncome: Math.round(invY.moneyMarketDividends * profile.moneyMarketUsGovShare) + invY.usTreasury + extras.usObligationIncome,
      capitalGainDistributions: invY.capGainDistLong,
      shortTermGain: invY.shortTermGain - extras.capitalLossCarryover + (useDocs ? k1("shortTermGain") : 0),
      longTermGain: invY.longTermGain + (useDocs ? k1("longTermGain") : 0),
      foreignTaxPaid: invY.foreignTax,
      otherIncome: extras.otherIncome + (useDocs ? k1("otherIncome") + k1Passive : 0) + k401Excess.ytd,
      estimatedFederal: half(estFederalToDate) + extras.estimatedFederalExtra,
      estimatedCt: half(estCtToDate) + extras.estimatedCtExtra,
      estimatedNy: nyFiling ? half(estNyToDate) : 0,
      dependentCareFsa: payroll.reduce((s, p) => s + p.w2Ytd.box10, 0),
    };
    // Schedule CT-SI and IT-203's New York column work in whole dollars, line by line.
    const whole = (c: number) => Math.round(c / 100) * 100;
    // Part-year / nonresident Connecticut (CT-1040NR/PY): income from Connecticut sources.
    // Wages: a W-2's Connecticut state line, else stubs paid while a resident (as a
    // nonresident, stubs with Connecticut withholding); investment income: the resident
    // share of the year's; other income (Schedule 1): all of it while a part-year resident.
    let ctSource: PersonReport["ctSource"] = null;
    if (residency.ct !== "FULL") {
      const wages = payroll.reduce((s, p) => {
        if (p.w2Doc) return s + whole(p.w2Projected.box16StateWages);
        const own = stubs.filter((st) => st.employer === p.employer);
        const paidHere = own.filter((st) => (residency.ct === "PART_YEAR" ? !!residency.movedIn && st.payDate >= residency.movedIn : amountsFromLines(st.lines, "current").stateWithheld > 0));
        return s + paidHere.reduce((t, st) => t + w2FromAmounts(p.employer, amountsFromLines(st.lines, "current"), fp).box1Wages, 0);
      }, 0);
      const i = projectedIncome;
      const share = residency.investmentShare ?? 0;
      const investment = [i.taxableInterest, i.ordinaryDividends, i.capitalGainDistributions + i.shortTermGain + i.longTermGain].reduce((s, x) => s + whole(x * share), 0);
      const other = residency.ct === "PART_YEAR" ? i.otherIncome : 0;
      ctSource = { total: wages + investment + other, wages, investment, other, investmentShare: share };
      // An entered CT-source total replaces the worked-out one (all of it on the first person's return).
      if (residency.sourceIncome != null) ctSource = { ...ctSource, total: person.id === filers[0]!.id ? residency.sourceIncome : 0 };
      projectedIncome.ctSourceIncome = ctSource.total;
      incomeYtd.ctSourceIncome = ctSource.total;
    }
    // Part-year or nonresident New York (IT-203): the New York amount column. Wages: the W-2s'
    // New York lines, else stubs paid while a resident or with New York withholding;
    // investment income: the share of the year lived there; other income: a part-year
    // resident's, unless Connecticut's part-year return already counts it as Connecticut's.
    let nySource: PersonReport["nySource"] = null;
    if (ny && ny.state !== "RESIDENT") {
      const residentOn = (d: string) => ny.state === "PART_YEAR" && !!ny.movedOut && d < ny.movedOut;
      const wages = payroll.reduce((s, p) => {
        if (p.w2Doc) return s + whole(p.w2Projected.nyStateWages ?? 0);
        const own = stubs.filter((st) => st.employer === p.employer);
        const latest = own.reduce<BookStub | null>((m, st) => (!m || st.payDate > m.payDate ? st : m), null);
        // A nonresident still working in New York: the projection's paychecks are New York's too.
        if (ny.state === "NONRESIDENT" && latest && amountsFromLines(latest.lines, "current").nyWithheld > 0) return s + whole(p.w2Projected.box1Wages);
        const here = own.filter((st) => residentOn(st.payDate) || amountsFromLines(st.lines, "current").nyWithheld > 0);
        return s + whole(here.reduce((t, st) => t + w2FromAmounts(p.employer, amountsFromLines(st.lines, "current"), fp).box1Wages, 0));
      }, 0);
      const i = projectedIncome;
      const share = ny.state === "PART_YEAR" ? (residency.ct === "PART_YEAR" ? 1 - (residency.investmentShare ?? 0) : (beforeMove(ny.movedOut, year) ?? 0)) : 0;
      const investment = [i.taxableInterest, i.ordinaryDividends, i.capitalGainDistributions + i.shortTermGain + i.longTermGain].reduce((s, x) => s + whole(x * share), 0);
      const other = ny.state === "PART_YEAR" && residency.ct !== "PART_YEAR" ? whole(i.otherIncome * share) : 0;
      nySource = { total: wages + investment + other, wages, investment, other, investmentShare: share };
      projectedIncome.nySourceIncome = nySource.total;
      incomeYtd.nySourceIncome = nySource.total;
    }
    const ytd = payroll.reduce((acc, p) => addAmounts(acc, p.ytd), { ...ZERO_AMOUNTS });
    const projectedPay = payroll.reduce((acc, p) => addAmounts(acc, p.projected), { ...ZERO_AMOUNTS });
    return {
      id: person.id,
      name: person.name,
      fromForecast,
      payrollSource,
      partial: partialByPerson.get(person.id) ?? [],
      payroll,
      accounts: mine.map(({ a }) => a),
      retirement: { conversions, basis, rollovers, otherDistributions, taxable: retirementTaxable, source: rForms.length ? "1099-R" : "STATEMENTS" },
      k401,
      k1s,
      ctSource,
      nySource,
      income: projectedIncome,
      incomeYtd,
      payrollTotals: { ytd, projected: projectedPay },
      paidToDate: {
        federal: ytd.federalWithheld,
        socialSecurity: ytd.ssWithheld,
        medicare: ytd.medicareWithheld,
        ct: ytd.stateWithheld,
        ctPfml: ytd.statePayroll,
        otherState: ytd.otherStateWithheld,
        estimatesFederal: half(estFederalToDate),
        estimatesCt: half(estCtToDate),
      },
    };
  });

  // ---------------------------------------------------------------- scenarios
  // A child born after the year isn't that year's dependent.
  const dependents = profile.dependents.map((d) => ({ name: d.name, age: ageAtYearEnd(d, year) })).filter((d) => d.age >= 0);
  const incomes = people.map((p) => p.income);
  const mfj = computeReturn({ params, filingStatus, people: incomes, dependents, ny: nyFiling });
  const mfjNoDependents = computeReturn({ params, filingStatus, people: incomes, dependents: [], ny: nyFiling });
  const mfs = bestSeparate(params, incomes, dependents, profile.mfsDependentClaimant, nyFiling);
  const mfsNoDependents = bestSeparate(params, incomes, [], profile.mfsDependentClaimant, nyFiling);

  // Marginal rates: one more $1,000 of wages for the highest earner.
  const top = [...people].sort((a, b) => sumW2(b.income) - sumW2(a.income))[0];
  const bumped = incomes.map((i) => (i.id === top?.id && i.w2s.length ? bumpWages(i, 100_000) : i));
  const mfjBumped = computeReturn({ params, filingStatus, people: bumped, dependents, ny: nyFiling });
  const marginal = {
    federal: (mfjBumped.federal.totalTax - mfj.federal.totalTax) / 100_000,
    ct: (mfjBumped.ct.totalTax - mfj.ct.totalTax) / 100_000,
    ny: ((mfjBumped.ny?.totalTax ?? 0) - (mfj.ny?.totalTax ?? 0)) / 100_000,
    payroll: (mfjBumped.fica.socialSecurity + mfjBumped.fica.medicare - mfj.fica.socialSecurity - mfj.fica.medicare) / 100_000,
  };

  // Figures typed under Inputs stand on the owner's word alone (no statement, stub or tax
  // document shows them): listed, so none of them passes for a proven figure.
  const typedNow = [
    ...filers.flatMap((p) =>
      EXTRA_FIELDS.filter(([k]) => inputs.people[p.id]!.extras[k]).map(([k, label]) => `${p.name}: ${label.toLowerCase()} ${usd(inputs.people[p.id]!.extras[k])}`),
    ),
    ...(
      [
        ["mortgage interest", inputs.household.mortgageInterest],
        ["property tax", inputs.household.propertyTax],
        ["charity (cash)", inputs.household.charitableCash],
        ["charity (other)", inputs.household.charitableOther],
        ["dependent care expenses", inputs.household.dependentCareExpenses],
      ] as const
    )
      .filter(([, v]) => v)
      .map(([label, v]) => `${label} ${usd(v)}`),
  ];
  if (typedNow.length) assumptions.push(`Typed under Inputs, not shown by any statement, stub or tax document: ${typedNow.join("; ")}.`);

  // ---------------------------------------------------------------- safe harbor & plan
  const py = inputs.priorYear;
  // Until last year's filed figures are entered, the model's own estimate of last year
  // (when that year is proven) stands in for the prior-year safe harbor.
  // Last year's filed return (tax documents folder) is the figure of record: it wins over
  // anything typed under Inputs, which counts only for a figure no filed return prints.
  let priorYearSource: TaxReport["priorYearSource"] = "NONE";
  const filedFederalTax = safeHarborTax(lastYearDocs.federal);
  const filedAgi = lastYearDocs.federal?.federal?.agi ?? null;
  const filedCt = lastYearDocs.ct?.state?.totalTax ?? null;
  let priorFederal = { tax: filedFederalTax ?? py.federalTotalTax, agi: filedAgi ?? py.federalAgi };
  let priorCt = filedCt ?? py.ctTotalTax;
  if (filedFederalTax != null) priorYearSource = "FILED";
  else if (py.federalTotalTax != null) priorYearSource = "ENTERED";
  const typedAgainstFiled: [string, number | null, number | null][] = [
    ["federal total tax (Form 1040 line 24)", py.federalTotalTax, filedFederalTax],
    ["federal AGI", py.federalAgi, filedAgi],
    ["Connecticut income tax", py.ctTotalTax, filedCt],
  ];
  for (const [what, typed, filed] of typedAgainstFiled)
    if (typed != null && filed != null && Math.abs(typed - filed) > 100)
      warnings.push(`${year - 1}'s ${what} typed under Inputs (${usd(typed)}) differs from the filed return in the tax documents folder (${usd(filed)}); the filed return is used. Clear the typed figure.`);
  if (priorYearSource === "NONE" && opts.estimatePriorYear !== false && TAX_YEARS[year - 1]) {
    const prev = buildTaxReport(book, year - 1, { estimatePriorYear: false });
    if (!prev.blocked) {
      const f = prev.scenarios.mfj.federal;
      priorFederal = { tax: f.totalTax - f.refundableChildCredit, agi: py.federalAgi ?? f.agi };
      priorCt ??= prev.scenarios.mfj.ct.totalTax;
      priorYearSource = "ESTIMATED";
    }
  }
  const priorYear: TaxReport["priorYear"] = {
    federalTax: priorFederal.tax,
    federalAgi: priorFederal.agi,
    ctTax: priorCt,
    file: lastYearDocs.federal?.doc.file ?? null,
    ctFile: lastYearDocs.ct?.doc.file ?? null,
  };
  const fedWithholding = mfj.federal.withholding + mfj.federal.additionalMedicareWithheld + mfj.federal.excessSsCredit;
  const federal = safeHarbor({
    currentYearTax: mfj.federal.totalTax - mfj.federal.refundableChildCredit,
    withholding: fedWithholding,
    estimatesPaid: mfj.federal.estimatedPayments,
    priorYearTax: priorFederal.tax,
    priorYearAgi: priorFederal.agi,
    highAgiThreshold: fp.safeHarborHighAgi[filingStatus],
    rules: fp.safeHarborRules,
  });
  const ct = safeHarbor({
    currentYearTax: mfj.ct.totalTax,
    withholding: mfj.ct.withholding,
    estimatesPaid: mfj.ct.estimatedPayments,
    priorYearTax: priorCt,
    priorYearAgi: null,
    highAgiThreshold: null,
    rules: fp.safeHarborRules,
  });
  if (filedCt != null && priorCt === filedCt && lastYearDocs.ct?.form === "CT-1040NR/PY") {
    assumptions.push(`Connecticut's prior-year safe harbor uses ${year - 1}'s part-year return (under Inputs). It covered all twelve months, but only part of the income; check CT-2210 before leaning on it.`);
  }
  if (priorYearSource === "NONE") {
    warnings.push(`No ${year - 1} return is in the tax documents folder, so the prior-year safe harbor isn't used (the 90%-of-this-year test is). Add the filed return to the folder, or type its figures under Inputs.`);
  } else if (priorYearSource === "ESTIMATED") {
    warnings.push(
      `The prior-year safe harbor uses this app's estimate of ${year - 1} federal tax (under Inputs): no filed ${year - 1} return is in the tax documents folder yet. Add it (or type Form 1040 line 24 under Inputs) before relying on it.`,
    );
  }
  // A W-4 change only reaches paychecks still to come.
  const active = people.flatMap((p) => p.payroll.filter((x) => x.active).map((x) => ({ person: p.name, n: x.remainingPayDates.filter((d) => d > today).length })));
  const main = active.sort((a, b) => b.n - a.n)[0];
  const remaining = main?.n ?? 0;
  const per = (amount: number) => (remaining > 0 && amount > 0 ? Math.ceil(amount / remaining / 100) * 100 : null);
  const plan = {
    remainingPaychecks: remaining,
    paycheckPerson: main?.person ?? null,
    federal: {
      safeHarborShortfall: federal.underDeMinimis ? 0 : federal.shortfall,
      projectedBalanceDue: mfj.federal.balanceDue,
      perPaycheckForSafeHarbor: per(federal.underDeMinimis ? 0 : federal.shortfall),
      perPaycheckToBreakEven: per(mfj.federal.balanceDue),
    },
    ct: {
      safeHarborShortfall: ct.underDeMinimis ? 0 : ct.shortfall,
      projectedBalanceDue: mfj.ct.balanceDue,
      perPaycheckForSafeHarbor: per(ct.underDeMinimis ? 0 : ct.shortfall),
      perPaycheckToBreakEven: per(mfj.ct.balanceDue),
    },
    q4DueDate: `${year + 1}-01-15`,
    filingDate: `${year + 1}-04-15`,
  };

  // The rules the estimate follows: tax law and the choices under Inputs, never a figure read from the data.
  const rules = [
    "Paychecks after the latest stub repeat the latest regular (non-bonus) paycheck, or the typical recent one where chosen under Inputs; 401(k) deferrals stop at the annual limit and Social Security at the wage base.",
    "Expected bonuses are withheld at the 22% federal supplemental rate and 6.99% CT.",
    "Dividends and interest are projected to year end from last year's month-by-month pattern in the same account (or a straight-line run rate); realized gains are not projected — add expected sales under Inputs.",
    `Fund and stock dividends are treated as ${Math.round(profile.qualifiedDividendShare * 100)}% qualified; money-market and bond-fund dividends as ordinary.`,
    filingStatus === "SINGLE"
      ? `Filed Single (the ${year} federal return names no spouse): only ${filers[0]!.name}'s wages, accounts and forms are on it; joint accounts count in full.`
      : "Married filing separately: each spouse reports their own wages and accounts; joint accounts, joint estimated payments, and household deductions are split evenly; both spouses itemize or both take the standard deduction, whichever costs less in total.",
    `Additional Medicare tax and the 3.8% net investment income tax are included in federal tax. The 0.9% employers withhold above $200k is credited back against the ${filingStatus === "SINGLE" ? "return's" : "joint"} liability.`,
    "Connecticut: 2025 CT-1040 schedule (Connecticut does not index its brackets); CHET 529 contributions are subtracted up to the per-return cap; the CT property-tax credit is not modeled.",
  ];
  if (isCurrentYear && through < today)
    assumptions.push(`Pay and bank figures run through ${through}, the latest date every account's statements reach; later pay stubs count once the bank statements showing their deposits are on file.`);
  if (!isCurrentYear && Number(today.slice(0, 4)) > year) {
    assumptions.push(
      docs.all.length
        ? `${year} is a past year: figures are the year's W-2s, 1099s and K-1s in the tax documents folder where they're on file, else what the stubs and statements show through year end.`
        : `${year} is a past year: figures are what the stubs and statements show through year end, no projection.`,
    );
  }
  if (residency.ct === "PART_YEAR") {
    assumptions.push(
      `Connecticut part-year resident${residency.movedIn ? ` from ${residency.movedIn}` : ""} (CT-1040NR/PY): the tax on the whole year's income is cut to the Connecticut-source share — wages from the W-2s' Connecticut lines${useDocs ? "" : " (else stubs paid after the move)"} and ${Math.round((residency.investmentShare ?? 0) * 1000) / 10}% of investment income.`,
    );
  } else if (residency.ct === "NONRESIDENT") {
    assumptions.push("Not a Connecticut resident this year: Connecticut taxes only Connecticut-source income (CT-1040NR/PY).");
  }
  if (ny) {
    const where = ny.source === "FILED_RETURN" ? `the filed ${docs.ny?.form ?? "New York return"}` : ny.source === "INPUTS" ? "Inputs" : "New York withholding on the W-2s and pay stubs";
    const city = ny.city === "RESIDENT" ? " and New York City resident tax" : ny.city === "PART_YEAR" ? ` and part-year New York City tax (IT-360.1, ${ny.filing.cityMonths} months)` : "";
    assumptions.push(
      ny.state === "RESIDENT"
        ? `New York: full-year resident (IT-201, per ${where}) — State tax${city} on all income, with the tax computation worksheets' recapture above $107,650 of AGI, the standard deduction and the NYC school tax credit.`
        : `New York: ${ny.state === "PART_YEAR" ? `part-year resident${ny.movedOut ? ` until ${ny.movedOut}` : ""}` : "nonresident"} (IT-203, per ${where}) — the tax on all income is cut to the New York share: wages from the W-2s' New York lines and ${Math.round((people[0]?.nySource?.investmentShare ?? 0) * 1000) / 10}% of investment income${city}.`,
      "New York itemized deductions and credits other than the NYC school tax credit (household, child, college tuition) aren't modeled; they phase out well below this household's income.",
    );
  }
  hsaCheck(people, fp, warnings);
  // The household's own caveats for the year (household file), e.g. part of it lived in another state.
  const caveat = book.household.taxYearWarnings[String(year)];
  if (caveat) warnings.push(caveat);

  const report: TaxReport = {
    blocked: false,
    year,
    today,
    isCurrentYear,
    paramsNotes: params.notes,
    profile,
    inputs,
    people,
    accounts,
    chet,
    children,
    dependents,
    payments,
    filingStatus,
    scenarios: { mfj, mfjNoDependents, mfs, mfsNoDependents },
    marginal,
    safeHarbor: { federal, ct },
    priorYearSource,
    priorYear,
    residency,
    ny,
    documents: null,
    unverified: blockers,
    bankInterest: { through: interestThrough, factor: interestFactor, parts: interestParts },
    dataThrough: {
      payStubs: people.flatMap((p) => p.payroll.filter((x) => x.active).map((x) => ({ person: p.name, employer: x.employer, date: x.latestPayDate }))),
      statements: accounts.filter((a) => a.kind === "TAXABLE").reduce<string | null>((m, a) => (m == null || a.latestStatement < m ? a.latestStatement : m), null),
      bank: interestThrough,
    },
    plan,
    warnings,
    assumptions,
    rules,
  };
  if (docs.all.length) {
    const ownerOfDoc = new Map<string, string | null>();
    for (const list of [docs.w2s, docs.brokerage, docs.ints, docs.rs, docs.k1s] as { doc: DocRef; personId: string | null }[][]) for (const o of list) ownerOfDoc.set(o.doc.id, o.personId);
    report.documents = {
      files: docs.all.map((d) => ({ id: d.id, file: d.file, kind: d.kind, superseded: d.superseded, warnings: d.warnings, personId: ownerOfDoc.get(d.id) ?? null })),
      filed: { federal: docs.federal, ct: docs.ct, ny: docs.ny },
      check: docs.federal || docs.ct ? checkFiled(report, docs) : null,
    };
  }
  return report;
}

/** Employer and payroll HSA contributions (W-2 box 12 W) above the year's family limit are taxable and draw a 6% excise tax. */
function hsaCheck(people: PersonReport[], fp: TaxYearParams["federal"], warnings: string[]) {
  const total = people.reduce((s, p) => s + p.payroll.reduce((t, x) => t + x.w2Projected.box12.W, 0), 0);
  // Whole dollars: a projection a few cents over the limit isn't an excess contribution.
  if (Math.round(total / 100) > Math.round(fp.limits.hsaFamily / 100)) {
    warnings.push(
      `HSA contributions through payroll (W-2 box 12 W) total ${usd(total)}, over the ${usd(fp.limits.hsaFamily)} family limit (plus $1,000 each at 55+). The excess is taxable wages unless withdrawn by the filing deadline (Form 8889).`,
    );
  }
}

/**
 * A W-2 form from an employer with no pay stubs on file: its boxes stand alone (nothing
 * to project; the year is over).
 */
function formOnlyPayroll(form: import("../taxdocs/types.ts").W2Form, doc: DocRef, name: string): PayrollEntry {
  const w2 = w2FromForm(form, null);
  const ytd: PayrollAmounts = {
    ...ZERO_AMOUNTS,
    gross: form.medicareWages,
    federalWithheld: form.federalWithheld,
    ssWithheld: form.ssWithheld,
    medicareWithheld: form.medicareWithheld,
    stateWithheld: w2.stateWithheld,
    otherStateWithheld: w2.otherStateWithheld,
  };
  return {
    employer: form.employer,
    employee: name,
    source: "W2" as PayrollProjection["source"],
    latestPayDate: "",
    frequency: "SEMIMONTHLY",
    remainingPayDates: [],
    regularPaycheck: null,
    basis: "LATEST",
    latestRegular: null,
    typicalRegular: null,
    payThrough: null,
    extraBonus: 0,
    ytd,
    projected: ytd,
    w2Ytd: w2,
    w2Projected: w2,
    lines: [],
    federalFilingStatus: null,
    active: false,
    w2Doc: doc,
    stubW2: null,
  };
}

/**
 * A finished year's brokerage 1099s replace the statements' figures for their accounts
 * (matched by the last four digits). For a year in progress, last year's 1099 for the
 * same account sets how much of its dividends are qualified and how much is REIT (199A)
 * income — better than one household-wide guess.
 */
function applyBrokerage1099s(accounts: AccountIncome[], docs: YearDocs | null, lastYear: YearDocs, profile: TaxProfile, warnings: string[]) {
  for (const a of accounts) {
    a.source = "STATEMENTS";
    a.doc = null;
    a.fromStatements = null;
    a.calibratedFrom = null;
  }
  const tail = (n: string) => n.replace(/\D/g, "").slice(-4);
  for (const f of docs?.brokerage ?? []) {
    const a = accounts.find((x) => x.kind === "TAXABLE" && f.form.account && tail(x.accountNumber) === f.form.account);
    const d = f.form.div;
    const figures: InvestmentFigures = {
      ordinaryDividends: d.ordinary,
      qualifiedDividends: d.qualified,
      moneyMarketDividends: a?.ytd.moneyMarketDividends ?? 0,
      interest: f.form.int.interest,
      capGainDistShort: 0,
      capGainDistLong: d.capitalGainDistributions,
      shortTermGain: f.form.b.shortTermGain,
      longTermGain: f.form.b.longTermGain + f.form.b.unknownTermGain,
      foreignTax: d.foreignTax + f.form.int.foreignTax,
      taxExempt: d.exemptInterest + f.form.int.taxExempt,
      section199a: d.section199a,
      usTreasury: f.form.int.usTreasury,
    };
    if (a) {
      a.fromStatements = a.ytd;
      a.ytd = figures;
      a.projected = figures;
      a.source = "1099";
      a.doc = f.doc;
    } else {
      warnings.push(`The ${f.form.payer} 1099 for account ••${f.form.account ?? "?"} matches no investment statements on file; its figures are counted as filed.`);
      accounts.push({
        accountNumber: f.form.account ?? f.doc.id,
        label: `${f.form.payer} ••${f.form.account ?? "?"} (1099 only)`,
        kind: "TAXABLE",
        ownerId: f.personId ?? profile.persons[0]!.id,
        ownerLine: f.form.recipient,
        latestStatement: "",
        ytd: figures,
        projected: figures,
        projection: { factor: 1, method: "FINAL" },
        distributions: [],
        contributionsYtd: null,
        isChet: false,
        endingValue: null,
        statementKind: "TAXABLE",
        child: null,
        source: "1099",
        doc: f.doc,
        fromStatements: null,
        januaryDividends: [],
        calibratedFrom: null,
      });
    }
  }
  if (docs) {
    for (const a of accounts.filter((x) => x.kind === "TAXABLE" && x.source === "STATEMENTS" && x.ytd.ordinaryDividends + x.ytd.interest > 1_000)) {
      if (docs.federal) warnings.push(`No 1099 for ${a.label} is in the tax documents folder; its income comes from the statements.`);
    }
    return;
  }
  for (const a of accounts.filter((x) => x.kind === "TAXABLE")) {
    const prev = lastYear.brokerage.find((f) => f.form.account && tail(a.accountNumber) === f.form.account);
    if (!prev || prev.form.div.ordinary <= 0) continue;
    const q = prev.form.div.qualified / prev.form.div.ordinary;
    const reit = prev.form.div.section199a / prev.form.div.ordinary;
    for (const pick of ["ytd", "projected"] as const) {
      a[pick] = { ...a[pick], qualifiedDividends: Math.round(a[pick].ordinaryDividends * q), section199a: Math.round(a[pick].ordinaryDividends * reit) };
    }
    a.calibratedFrom = lastYear.year;
  }
  // No 1099 from last year to read the split from: the qualified share is the one typed under Inputs.
  for (const a of accounts.filter((x) => x.kind === "TAXABLE" && x.source === "STATEMENTS" && x.calibratedFrom == null && x.ytd.ordinaryDividends > 0))
    warnings.push(`${a.label}: no ${lastYear.year} 1099 to read the qualified share of its dividends from, so the qualified share set under Inputs counts for its fund and stock dividends. The year's 1099 will settle it.`);
}

/** The share of the year before `d` (a move out), or null without a date. */
function beforeMove(d: string | null, year: number): number | null {
  if (!d) return null;
  const daysInYear = (Date.parse(`${year + 1}-01-01`) - Date.parse(`${year}-01-01`)) / 86_400_000;
  return Math.min(1, Math.max(0, (Date.parse(d) - Date.parse(`${year}-01-01`)) / 86_400_000 / daysInYear));
}

/**
 * New York for the year: as entered under Inputs; else the filed New York return (IT-201: a
 * full-year resident; IT-203 with a move date: part-year; IT-203 alone: nonresident; City
 * tax on it: the City too); else New York withholding (moved to Connecticut during the
 * year: part-year until the move; otherwise a nonresident working there, or a resident
 * when not living in Connecticut at all).
 */
function nyFor(entered: NyResidency | null, docs: YearDocs, ct: TaxReport["residency"], withheld: { state: boolean; city: boolean }, year: number): TaxReport["ny"] {
  const make = (r: NyResidency, source: NonNullable<TaxReport["ny"]>["source"]): TaxReport["ny"] => {
    if (r.state === "NONE") return null;
    // IT-360.1's proration: whole months lived in the City (a part month counts from 15 days).
    const months = r.city === "PART_YEAR" ? Math.round((beforeMove(r.movedOut, year) ?? 0) * 12) : r.city === "RESIDENT" ? 12 : 0;
    const state = r.state === "RESIDENT" ? "RESIDENT" : r.state === "PART_YEAR" ? "PART_YEAR" : "NONRESIDENT";
    return { ...r, source, filing: { state, city: r.city, cityMonths: months } };
  };
  if (entered) return make(entered, "INPUTS");
  const f = docs.ny;
  if (f) {
    const city = (f.state?.cityTax ?? 0) > 0 || f.lines.some((l) => l.form === "IT-360.1");
    if (f.form === "IT-201") return make({ state: "RESIDENT", city: city ? "RESIDENT" : "NONE", movedOut: null }, "FILED_RETURN");
    if (f.movedOn) return make({ state: "PART_YEAR", city: city ? "PART_YEAR" : "NONE", movedOut: f.movedOn }, "FILED_RETURN");
    return make({ state: "NONRESIDENT", city: "NONE", movedOut: null }, "FILED_RETURN");
  }
  if (!withheld.state && !withheld.city) return null;
  if (ct.ct === "PART_YEAR" && ct.movedIn) return make({ state: "PART_YEAR", city: withheld.city ? "PART_YEAR" : "NONE", movedOut: ct.movedIn }, "WITHHOLDING");
  if (ct.ct === "NONRESIDENT") return make({ state: "RESIDENT", city: withheld.city ? "RESIDENT" : "NONE", movedOut: null }, "WITHHOLDING");
  return make({ state: "NONRESIDENT", city: "NONE", movedOut: null }, "WITHHOLDING");
}

function residencyFor(entered: Residency | null, docs: YearDocs, year: number): TaxReport["residency"] {
  const daysInYear = (Date.parse(`${year + 1}-01-01`) - Date.parse(`${year}-01-01`)) / 86_400_000;
  const afterMove = (d: string | null) => (d ? Math.min(1, Math.max(0, ((Date.parse(`${year}-12-31`) - Date.parse(d)) / 86_400_000 + 1) / daysInYear)) : null);
  const filedShare = ctResidentShares(docs.ct).investment;
  if (entered) {
    const share = entered.ct === "FULL" ? 1 : entered.ct === "NONRESIDENT" ? 0 : (entered.investmentShare ?? filedShare ?? afterMove(entered.movedIn) ?? 1);
    return { ...entered, investmentShare: share, source: "INPUTS" };
  }
  if (docs.ct?.form === "CT-1040NR/PY") {
    const movedIn = docs.ny?.movedOn ?? null;
    if (movedIn || filedShare) return { ct: "PART_YEAR", movedIn, investmentShare: filedShare ?? afterMove(movedIn) ?? 1, sourceIncome: null, source: "FILED_RETURN" };
    return { ct: "NONRESIDENT", movedIn: null, investmentShare: 0, sourceIncome: null, source: "FILED_RETURN" };
  }
  if (docs.ny && !docs.ct) return { ct: "NONRESIDENT", movedIn: null, investmentShare: 0, sourceIncome: null, source: "FILED_RETURN" };
  return { ct: "FULL", movedIn: null, investmentShare: 1, sourceIncome: null, source: "DEFAULT" };
}

function addAmounts(a: PayrollAmounts, b: PayrollAmounts): PayrollAmounts {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof PayrollAmounts)[]) out[k] += b[k];
  return out;
}

const sumW2 = (i: PersonIncome) => i.w2s.reduce((s, w) => s + w.box1Wages, 0);

function bumpWages(i: PersonIncome, cents: number): PersonIncome {
  const [first, ...rest] = i.w2s;
  return {
    ...i,
    w2s: [
      { ...first!, box1Wages: first!.box1Wages + cents, box5MedicareWages: first!.box5MedicareWages + cents, box16StateWages: first!.box16StateWages + cents, box3SsWages: first!.box3SsWages + cents },
      ...rest,
    ],
  };
}

/** One projection per employer; only the most recent employer keeps paying through year end. */
function projectEmployers(
  stubs: BookStub[],
  params: TaxYearParams,
  expectedBonus: number,
  pay: PayForecast,
  isCurrentYear: boolean,
  asOf: string,
  warnings: string[],
  name: string,
  basisFromForecast = false,
): (PayrollProjection & { active: boolean })[] {
  const byEmployer = new Map<string, BookStub[]>();
  for (const s of stubs) byEmployer.set(s.employerKey, [...(byEmployer.get(s.employerKey) ?? []), s]);
  const latestOf = (ss: BookStub[]) => ss.reduce((m, s) => (s.payDate > m ? s.payDate : m), "");
  const groups = [...byEmployer.values()].sort((a, b) => latestOf(b).localeCompare(latestOf(a)));
  return groups.map((g, i) => {
    const active = i === 0;
    const p = projectPayroll(g, params.federal, active ? { extraBonus: expectedBonus, basis: pay.paycheck, payThrough: pay.payThrough } : {});
    if (!active) return { ...p, active, remainingPayDates: [], projected: p.ytd, w2Projected: p.w2Ytd, extraBonus: 0 };
    const ageDays = (Date.parse(asOf) - Date.parse(p.latestPayDate)) / 86_400_000;
    if (isCurrentYear && ageDays > 45) {
      warnings.push(`${name}'s latest ${p.employer} pay stub is from ${p.latestPayDate}; upload newer stubs for a sharper projection.`);
    }
    // A latest paycheck far from the typical one (reduced hours, leave, a raise) moves the
    // whole forecast; say which one is being repeated so it can be switched.
    const latest = p.latestRegular?.amounts.gross ?? 0;
    const typical = p.typicalRegular?.amounts.gross ?? 0;
    if (isCurrentYear && p.remainingPayDates.length && typical > 0 && Math.abs(latest - typical) / typical > 0.15) {
      const change = `${name}'s latest regular ${p.employer} paycheck (${p.latestRegular!.payDate}, ${usd(latest)} gross) is ${Math.round((Math.abs(latest - typical) / typical) * 100)}% ${latest < typical ? "below" : "above"} the typical recent one (${usd(typical)})`;
      const where = basisFromForecast ? "on the Forecast page" : "under Inputs";
      warnings.push(
        p.basis === "LATEST"
          ? `${change}. The forecast repeats the latest; if it was a one-off, switch ${name}'s paycheck to "typical" ${where}.`
          : `${change}. The forecast repeats the typical paycheck, as chosen ${where}.`,
      );
    }
    return { ...p, active };
  });
}


export function investmentAccounts(
  snapshots: FidelitySnapshot[],
  year: number,
  profile: TaxProfile,
  personFor: (t: string) => TaxPerson | undefined,
  warnings: string[],
): AccountIncome[] {
  const y = String(year);
  const byAccount = new Map<string, FidelitySnapshot[]>();
  for (const s of snapshots) byAccount.set(s.accountNumber, [...(byAccount.get(s.accountNumber) ?? []), s]);
  const out: AccountIncome[] = [];
  for (const [acct, all] of byAccount) {
    const inYear = all.filter((s) => s.periodEnd.startsWith(y)).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || Number(a.isYearEnd) - Number(b.isYearEnd));
    if (!inYear.length) continue;
    const latest = inYear.at(-1)!;
    const monthly = inYear.filter((s) => !s.isYearEnd);
    const kind = profile.accountKinds[acct] ?? latest.kind;
    // A type set under Inputs beats the statement; when the statement reads one, say they disagree.
    if (profile.accountKinds[acct] && latest.kind !== "OTHER" && profile.accountKinds[acct] !== latest.kind)
      warnings.push(`Account ••${acct.slice(-4)} is taxed as ${ACCOUNT_KIND_LABEL[kind]} (set under Inputs), though its statement reads ${ACCOUNT_KIND_LABEL[latest.kind]}.`);
    // A custodial account or Trump Account is the child's: no parent owns its income.
    const child = CHILD_KINDS.includes(kind) ? (profile.dependents.find((d) => latest.ownerLine.toUpperCase().includes(d.name.toUpperCase()))?.name ?? latest.ownerLine) : null;
    const ownerId = child
      ? "CHILD"
      : (profile.accountOwners[acct] ?? (/JOINT/i.test(latest.ownerLine) ? "JOINT" : personFor(latest.ownerLine)?.id ?? profile.persons[0]!.id));

    const inc = latest.income ?? { dividends: 0, interest: 0, capGainDistShort: 0, capGainDistLong: 0, taxExempt: 0, taxDeferred: 0 };
    const realized = [...inYear].reverse().find((s) => s.realized)?.realized ?? { shortTerm: 0, longTerm: 0 };
    // Split dividends using the individual payments seen this year.
    const rows = monthly.flatMap((s) => s.incomeRows).filter((r) => r.kind === "DIVIDEND");
    const rowTotal = rows.reduce((s, r) => s + r.amount, 0);
    const nqRows = rows.filter((r) => r.nonQualified).reduce((s, r) => s + r.amount, 0);
    const mmRows = rows.filter((r) => r.moneyMarket).reduce((s, r) => s + r.amount, 0);
    const nqShare = rowTotal > 0 ? nqRows / rowTotal : 0;
    const mmShare = rowTotal > 0 ? mmRows / rowTotal : 0;
    const foreign = Math.abs(monthly.flatMap((s) => s.incomeRows).filter((r) => r.kind === "FOREIGN_TAX").reduce((s, r) => s + r.amount, 0));
    const ordinary = inc.dividends;
    const ytd: InvestmentFigures = {
      ordinaryDividends: ordinary,
      qualifiedDividends: Math.round(ordinary * (1 - nqShare) * profile.qualifiedDividendShare),
      moneyMarketDividends: Math.round(ordinary * mmShare),
      interest: inc.interest,
      capGainDistShort: inc.capGainDistShort,
      capGainDistLong: inc.capGainDistLong,
      shortTermGain: realized.shortTerm,
      longTermGain: realized.longTerm,
      foreignTax: foreign,
      taxExempt: inc.taxExempt,
      section199a: 0,
      usTreasury: 0,
    };

    // Year-end projection of income (not of gains, which depend on future sales).
    let projection: AccountIncome["projection"] = { factor: 1, method: "FINAL" };
    const endMonth = Number(latest.periodEnd.slice(5, 7));
    if (latest.periodEnd < `${y}-12-31` && !latest.isYearEnd) {
      const prior = all.filter((s) => s.periodEnd.startsWith(String(year - 1)) && s.income);
      const sameMonth = prior.find((s) => Number(s.periodEnd.slice(5, 7)) === endMonth && !s.isYearEnd);
      const dec = prior.find((s) => s.periodEnd.endsWith("-12-31"));
      const linear = 12 / endMonth;
      if (sameMonth?.income && dec?.income && sameMonth.income.dividends > 0 && dec.income.dividends >= sameMonth.income.dividends) {
        projection = { factor: Math.min(dec.income.dividends / sameMonth.income.dividends, linear * 1.5), method: "SEASONAL" };
      } else {
        projection = { factor: linear, method: "LINEAR" };
      }
    }
    const scale = (n: number) => Math.round(n * projection.factor);
    const projected: InvestmentFigures = {
      ...ytd,
      ordinaryDividends: scale(ytd.ordinaryDividends),
      qualifiedDividends: scale(ytd.qualifiedDividends),
      moneyMarketDividends: scale(ytd.moneyMarketDividends),
      interest: scale(ytd.interest),
      foreignTax: scale(ytd.foreignTax),
      taxExempt: scale(ytd.taxExempt),
    };
    if (kind === "OTHER")
      warnings.push(`${latest.institution} account ${acct} (${latest.ownerLine}) has an unrecognized type, so its income is not counted. Set its type under Inputs → Investment accounts.`);
    out.push({
      accountNumber: acct,
      label: accountLabel(latest, kind),
      kind,
      statementKind: latest.kind,
      child,
      ownerId,
      ownerLine: latest.ownerLine,
      latestStatement: latest.periodEnd,
      ytd,
      projected,
      projection,
      distributions: monthly.flatMap((s) => s.distributions),
      contributionsYtd: statementContributionsYtd(inYear, year),
      isChet: latest.isChet,
      endingValue: latest.endingValue,
      source: "STATEMENTS",
      doc: null,
      fromStatements: null,
      januaryDividends: rows.filter((r) => !r.moneyMarket && r.date.slice(5, 7) === "01").map((r) => ({ date: r.date, amount: r.amount })),
      calibratedFrom: null,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function accountLabel(s: FidelitySnapshot, kind: AccountTaxKind): string {
  const tail = s.accountNumber.slice(-4);
  return `${s.institution} ${kind === "529" && s.isChet ? "CHET 529" : ACCOUNT_KIND_LABEL[kind]} ••${tail}`;
}

const unearned = (f: InvestmentFigures) => f.ordinaryDividends + f.interest + f.capGainDistShort + f.capGainDistLong + f.shortTermGain + f.longTermGain;

/** Custodial accounts, one entry per child, with the rule their income falls under. */
export function childIncome(
  accounts: AccountIncome[],
  limits: TaxYearParams["federal"]["kiddie"],
  year: number,
  isForecast: boolean,
  warnings: string[],
  assumptions: string[],
): ChildIncome[] {
  const byChild = new Map<string, AccountIncome[]>();
  // A Trump Account's income is tax-deferred: it's no one's until withdrawn.
  for (const a of accounts) if (a.child && a.kind === "CUSTODIAL") byChild.set(a.child, [...(byChild.get(a.child) ?? []), a]);
  return [...byChild].map(([name, as]) => {
    const ytd = pos(as.reduce((s, a) => s + unearned(a.ytd), 0));
    const projected = pos(as.reduce((s, a) => s + unearned(a.projected), 0));
    // The rule is decided on the full-year figure; a finished year's projection is its total.
    const rule: ChildIncome["rule"] = projected <= limits.exempt ? "UNDER_EXEMPT" : projected <= limits.threshold ? "CHILD_RATE" : "KIDDIE_TAX";
    const parentElectionAllowed = projected < limits.parentElectionMax && as.every((a) => a.projected.shortTermGain === 0 && a.projected.longTermGain === 0);
    const amount = `${usd(projected)}${isForecast ? " projected" : ""} for ${year}`;
    const where = `${name}'s custodial account income (${as.map((a) => a.label).join(", ")}: ${amount})`;
    if (rule === "UNDER_EXEMPT") {
      assumptions.push(`${where} is ${name}'s, not yours, so it's left off your return. It's under ${usd(limits.exempt)}: no tax and no return for ${name}.`);
    } else {
      const election = parentElectionAllowed
        ? ` Or you can report it on your own return with Form 8814 instead; this estimate leaves it off.`
        : ` Form 8814 (reporting it on your return) isn't available: ${projected >= limits.parentElectionMax ? `it's ${usd(limits.parentElectionMax)} or more` : "it includes realized gains from sales"}.`;
      warnings.push(
        rule === "CHILD_RATE"
          ? `${where} is over ${usd(limits.exempt)}, so a return must be filed for ${name}: the part over ${usd(limits.exempt)} is taxed at ${name}'s rate.${election}`
          : `${where} is over ${usd(limits.threshold)}, so the kiddie tax applies: ${name}'s return (Form 8615) taxes the part over ${usd(limits.threshold)} at your rate.${election}`,
      );
    }
    return { name, accounts: as.map((a) => a.label), ytd, projected, rule, parentElectionAllowed, limits };
  });
}
