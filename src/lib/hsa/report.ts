import type { BlockerRef } from "../book/reports/blockerRef.ts";
import { daysBetween } from "../dates/isoDate.ts";
import type { RowFingerprint } from "../review/rowDecisions.ts";
import { ownerFiled, qualifyPayee, type ExpenseKind, type Qualification, type Tier } from "./qualify.ts";
import { sameFp, type HsaExpense, type HsaFile, type HsaSettings } from "./store.ts";
import { hsaAfterTax, strategyRows, taxableAfterTax, type StrategyAssumptions, type StrategyRow } from "./strategy.ts";

/**
 * The HSA page: the receipts log joined to the ledger. Pure (no I/O), so it's tested on
 * its own; the route feeds it the Book's rows and the saved log.
 *
 *  - Each logged expense is tied to the card or bank row that paid it: the one the owner
 *    picked, else the only spending row of the same amount within ±10 days (the log's
 *    date is often the visit, the charge a few days later).
 *  - Spending rows that look like qualified care (qualify.ts) and aren't in the log yet
 *    are suggested, unless the owner dismissed the row or the merchant, or a refund of
 *    the same amount from the same merchant followed.
 *  - Money out of the HSA is one of two things. A card swipe or bill paid straight to a
 *    provider is the HSA paying for care directly: nothing to reimburse, never tied to the
 *    log. A distribution to the owner (a transfer to the bank) is a reimbursement, and is
 *    offered for tying to the receipts it paid back, with a set of unreimbursed expenses
 *    that adds up to it exactly as a starting point the owner confirms.
 *  - Logged expenses whose paying row no longer looks medical (it was added from a
 *    statement before the rules were tightened, or the row was refiled) are flagged, and
 *    so are reimbursements tied to an HSA card payment instead of a distribution.
 *  - Growth: what waiting earns. An unreimbursed dollar stays invested in the HSA, growing
 *    tax-free, while still being withdrawable tax-free at any time against its receipt.
 */

export type LedgerAccountIn = { id: string; name: string; institution: string | null; group: string; identifiers: string[] };
export type LedgerRowIn = {
  id: string;
  date: string;
  amountCents: number;
  lane: string;
  accountId: string;
  payee: string;
  detail?: string | null;
  merchantKey: string | null;
  category: string;
  classifiedBy: string | null;
};
export type HsaAccountIn = { name: string; balanceCents: number; asOf: string | null; annualizedReturn: number | null };
/** HSA money from pay stubs for one year, everyone's together: the fallback when the HSA's statements don't say who put it in. */
export type PayrollHsaIn = {
  year: number;
  employeeCents: number;
  employerCents: number;
  /** Payroll tax a contributed dollar avoids, from the contributor's wages that year (payrollTaxSaved). */
  payrollRate: number | null;
  /** The part of it that's the Additional Medicare surtax (the Taxes page counts that in federal income tax). */
  surtaxRate?: number;
};

/** The Taxes page's marginal rates on the next wage dollar (lib/hsa/load.ts hsaTaxMarginal). */
export type TaxMarginalIn = { year: number; incomeRate: number; payrollRate: number; source: "TAX_REPORT" | "PRIOR_YEAR" };

/**
 * Payroll tax not paid on a dollar put into the HSA through payroll. Social Security only
 * if the contributor's wages for the year stay under the wage base (above it, the cap is
 * reached either way and the dollar saves nothing); Medicare always; the Additional
 * Medicare surtax when the household's Medicare wages are over its threshold.
 */
export function payrollTaxSaved(p: { personWagesCents: number; householdWagesCents: number; wageBaseCents: number; ssRate: number; medicareRate: number; additionalMedicareRate: number; surtaxThresholdCents: number }): number {
  return (p.personWagesCents < p.wageBaseCents ? p.ssRate : 0) + p.medicareRate + (p.householdWagesCents > p.surtaxThresholdCents ? p.additionalMedicareRate : 0);
}

export type ReportInput = {
  today: string;
  file: HsaFile;
  rows: LedgerRowIn[];
  accounts: LedgerAccountIn[];
  hsaAccounts: HsaAccountIn[];
  /** Household members' names, for the patient picker and guesses. */
  persons: string[];
  /** The Retirement page's marginal rate, when set. */
  marginalRate: number | null;
  /** Latest year of HSA payroll money on the pay stubs, if any. */
  payrollHsa?: PayrollHsaIn | null;
  /** The Taxes page's marginal rates, when its figures are proven. */
  taxMarginal?: TaxMarginalIn | null;
  /**
   * The shared figures the strategy's rates default to (lib/hsa/load.ts hsaLinkedRates): the
   * forecast's return, the dividend yield the taxable statements show, and the tax engine's
   * rate on a long-term gain. A rate typed on Settings still wins, as a labelled assumption.
   */
  linked?: { returnRate: number | null; dividendYield: number | null; taxableRate: number | null };
  /**
   * What withholds the ledger side (lib/hsa/load.ts): `balance`, the HSA's balance at the
   * data edge; `rows`, any bank or card finding while the HSA was open (a missing statement
   * leaves the paying rows, suggestions and withdrawals incomplete).
   */
  blockers?: { balance: BlockerRef[]; rows: BlockerRef[] };
  /** The HSA's opening day as its first statement proves it (opening at $0), for when none is typed. */
  openedOn?: string | null;
};

export type LedgerRef = {
  rowId: string | null;
  fp: RowFingerprint;
  date: string;
  /** Positive cents. */
  amountCents: number;
  payee: string;
  account: string;
};

export type ExpenseFlag = "DUPLICATE" | "BEFORE_OPEN" | "NO_RECEIPT" | "PAID_ROW_MISSING" | "NOT_MEDICAL" | "BAD_TIE";

export type ExpenseView = HsaExpense & {
  paid: LedgerRef | null;
  /** The paying row was found by amount and date, not picked by the owner. */
  paidAuto: boolean;
  withdrawal: LedgerRef | null;
  flags: ExpenseFlag[];
  /** Days since paid (unreimbursed) or between paid and reimbursed. */
  daysWaiting: number;
  /** Estimated tax-free growth on the money left in the HSA for those days. */
  growthCents: number;
  /** When nothing is tied to it: unclaimed charges of the same amount within 45 days, to tie by hand. */
  candidates: LedgerRef[];
  /** Why the paying row doesn't look medical (NOT_MEDICAL), or why the reimbursement's tie is wrong (BAD_TIE). */
  doubt: string | null;
};

export type Suggestion = LedgerRef & { merchant: string; tier: Tier; kind: ExpenseKind; reason: string; patient: string };

/**
 * Money out of the HSA. DIRECT: the HSA paid a provider (its debit card, a bill pay):
 * the care is paid for, nothing comes back to you, so it never reimburses a logged
 * expense. DISTRIBUTION: money to you (a transfer to your bank): what reimburses receipts.
 */
export type WithdrawalKind = "DIRECT" | "DISTRIBUTION";

export type Withdrawal = LedgerRef & {
  kind: WithdrawalKind;
  /** Expenses marked reimbursed by this withdrawal. */
  linkedIds: string[];
  /** DISTRIBUTION only: unreimbursed expenses whose amounts add up to it exactly (none when it's linked), for the owner to confirm. */
  exactMatch: string[] | null;
};

export type YearRow = { year: number; count: number; totalCents: number; reimbursedCents: number; unreimbursedCents: number; reimbursedInYearCents: number };
export type Breakdown = { key: string; count: number; totalCents: number; unreimbursedCents: number };

/**
 * Who funded the HSA: from the HSA's own statements (contributions labelled employee or
 * employer) for the latest year they cover, else the latest year's pay stubs, else
 * unknown (the page then assumes it's all you).
 */
export type Funding = {
  source: "STATEMENTS" | "PAY_STUBS" | "NONE";
  /** The contribution (tax) year read. */
  year: number | null;
  from: string | null;
  through: string | null;
  employeeCents: number;
  employerCents: number;
  /** Your part of the money, 0–1; 1 when nothing is known. */
  employeeShare: number;
};

export type HsaReport = {
  today: string;
  settings: HsaSettings;
  expenses: ExpenseView[];
  suggestions: Suggestion[];
  withdrawals: Withdrawal[];
  /** Every withdrawal by kind: distributions to the bank (which can reimburse receipts) and payments straight to a provider. */
  withdrawalTotals: { distributionCents: number; directCents: number };
  totals: {
    count: number;
    loggedCents: number;
    unreimbursedCents: number;
    unreimbursedCount: number;
    reimbursedCents: number;
    reimbursedCount: number;
    /** Tax-free growth to date on money left invested instead of reimbursed. */
    growthCents: number;
    /** Unreimbursed and with the receipt saved: withdrawable today with nothing to dig up. */
    readyCents: number;
    missingReceiptCount: number;
    missingReceiptCents: number;
    oldestUnreimbursed: string | null;
    /** Average days an unreimbursed dollar has waited (amount-weighted). */
    avgDaysWaiting: number;
  };
  hsa: { accounts: HsaAccountIn[]; balanceCents: number | null; asOf: string | null; measuredReturn: number | null; blockers: { balance: BlockerRef[]; rows: BlockerRef[] }; openedOn: string | null; openedFrom: "SETTING" | "STATEMENTS" | null };
  growth: {
    rate: number;
    rateSource: "SETTING" | "MEASURED" | "FORECAST" | "DEFAULT";
    dividendSource: "SETTING" | "STATEMENTS" | "DEFAULT";
    taxableSource: "SETTING" | "TAX_ENGINE" | "DEFAULT";
    marginalRate: number;
    marginalSource: "SETTING" | "RETIREMENT" | "TAX_REPORT" | "DEFAULT";
    payrollSource: "SETTING" | "PAY_STUBS" | "TAX_REPORT" | "DEFAULT";
    /** The assumptions behind the comparison, defaults filled in. */
    assumptions: StrategyAssumptions;
    planYear: number;
    years: number;
    /** The unreimbursed total left invested until the plan year, taken out then after any tax. */
    futureValueCents: number;
    /** The same money in a taxable account by then, after selling (dividends taxed yearly, the gain at sale). */
    taxableValueCents: number;
    /** Year by year to the plan year: both after tax if taken out that year. */
    path: { year: number; hsaCents: number; taxableCents: number }[];
    /** Per $1,000 of medical bills: pay from the HSA now or out of pocket (strategy.ts), the HSA maxed either way. */
    strategy: StrategyRow[];
    /** Who put the HSA money in (backs the contribution figures). */
    funding: Funding;
  };
  years: YearRow[];
  byPatient: Breakdown[];
  byKind: Breakdown[];
  patients: string[];
  ignoredMerchants: string[];
  dismissed: LedgerRef[];
};

const AUTO_MATCH_DAYS = 10;
const CANDIDATE_DAYS = 45;
const REFUND_DAYS = 90;
const DEFAULT_RATE = 0.07;
const DEFAULT_MARGINAL = 0.32;
const DEFAULT_DIVIDEND_YIELD = 0.015;
const DEFAULT_TAXABLE_RATE = 0.2;
/** Medicare's 1.45% applies to every wage dollar; Social Security's 6.2% only below its wage base. */
const DEFAULT_PAYROLL_RATE = 0.0145;
const DAYS_PER_YEAR = 365.25;

const growthOn = (cents: number, rate: number, days: number) => (days <= 0 ? 0 : Math.round(cents * (Math.pow(1 + rate, days / DAYS_PER_YEAR) - 1)));

const EMPLOYER_PAYEE = /\bEMPLOYER\b/i;
const EMPLOYEE_PAYEE = /\bEMPLOYEE\b|PAYROLL|CONTRIBUTION/i;

/** Whose money an HSA deposit is, by its lane or what the statement calls it; null: not a contribution the split counts. */
export const contributionKind = (r: Pick<LedgerRowIn, "lane" | "payee">): "EMPLOYER" | "EMPLOYEE" | null =>
  r.lane === "CONTRIBUTION_EMPLOYER" || EMPLOYER_PAYEE.test(r.payee) ? "EMPLOYER"
  : r.lane === "CONTRIBUTION_EMPLOYEE" || EMPLOYEE_PAYEE.test(r.payee) ? "EMPLOYEE"
  : null;

/**
 * The tax year a contribution counts for: "Employer Contribution for 2025" deposited in
 * January 2026 is 2025's. One year, not a rolling 12 months: an employer's first-year
 * catch-up lumps would otherwise skew the split.
 */
export const contributionTaxYear = (r: Pick<LedgerRowIn, "date" | "payee">) => Number(/\bFOR (\d{4})\b/i.exec(r.payee)?.[1] ?? r.date.slice(0, 4));

/** Who funded the HSA (see Funding): the latest contribution year on the statements, else the pay stubs. */
export function hsaFunding(rows: LedgerRowIn[], isHsa: (accountId: string) => boolean, payroll: PayrollHsaIn | null | undefined): Funding {
  const kind = contributionKind;
  const taxYear = contributionTaxYear;
  const ins = rows.filter((r) => r.amountCents > 0 && isHsa(r.accountId) && kind(r));
  const share = (ee: number, er: number) => (ee + er > 0 ? ee / (ee + er) : 1);
  const latest = Math.max(...ins.filter((r) => kind(r) === "EMPLOYER").map(taxYear));
  if (Number.isFinite(latest)) {
    const window = ins.filter((r) => taxYear(r) === latest);
    const sumOf = (k: "EMPLOYER" | "EMPLOYEE") => window.filter((r) => kind(r) === k).reduce((s, r) => s + r.amountCents, 0);
    const employeeCents = sumOf("EMPLOYEE");
    const employerCents = sumOf("EMPLOYER");
    const dates = window.map((r) => r.date).sort();
    return { source: "STATEMENTS", year: latest, from: dates[0]!, through: dates.at(-1)!, employeeCents, employerCents, employeeShare: share(employeeCents, employerCents) };
  }
  if (payroll && payroll.employeeCents + payroll.employerCents > 0) {
    return { source: "PAY_STUBS", year: payroll.year, from: `${payroll.year}-01-01`, through: `${payroll.year}-12-31`, employeeCents: payroll.employeeCents, employerCents: payroll.employerCents, employeeShare: share(payroll.employeeCents, payroll.employerCents) };
  }
  return { source: "NONE", year: null, from: null, through: null, employeeCents: 0, employerCents: 0, employeeShare: 1 };
}

/** Out of the HSA to the owner rather than to a provider: a transfer, or a payee that says distribution. */
const DISTRIBUTION_PAYEE = /DISTRIBUTION|DISBURSE|REIMBURSE|WITHDRAWAL|TRANSFER|\bXFER\b|\bACH\b|\bEFT\b|TO CHECKING|TO SAVINGS/i;
/** The HSA's debit card or bill pay paying a provider. */
const DIRECT_PAYEE = /^CARD\b|\bDEBIT CARD\b|\bPOS\b|PURCHASE|BILL ?PAY/i;

export function withdrawalKind(r: Pick<LedgerRowIn, "lane" | "payee">): WithdrawalKind {
  if (DIRECT_PAYEE.test(r.payee)) return "DIRECT";
  if (r.lane !== "EXPENSE" || DISTRIBUTION_PAYEE.test(r.payee)) return "DISTRIBUTION";
  return "DIRECT";
}

/** Every subset of `items` (≤ 4 of them) whose amounts sum to exactly `target`, first found; bounded work. */
export function exactSubset(items: { id: string; amountCents: number }[], target: number, maxSize = 4): string[] | null {
  const xs = items.filter((x) => x.amountCents <= target).sort((a, b) => b.amountCents - a.amountCents);
  let budget = 200_000;
  const pick: string[] = [];
  const go = (start: number, left: number): boolean => {
    if (left === 0) return true;
    if (pick.length >= maxSize || --budget <= 0) return false;
    for (let i = start; i < xs.length; i++) {
      if (xs[i]!.amountCents > left) continue;
      pick.push(xs[i]!.id);
      if (go(i + 1, left - xs[i]!.amountCents)) return true;
      pick.pop();
    }
    return false;
  };
  return go(0, target) ? [...pick] : null;
}

export function buildHsaReport(input: ReportInput): HsaReport {
  const { today, file } = input;
  const settings = file.settings;
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const isHsa = (accountId: string) => accountById.get(accountId)?.group === "Health savings";
  const fpOf = (r: LedgerRowIn): RowFingerprint => {
    const a = accountById.get(r.accountId);
    return { institution: a?.institution ?? "", identifiers: a?.identifiers ?? [], date: r.date, amountCents: r.amountCents, payee: r.payee };
  };
  const refOf = (r: LedgerRowIn): LedgerRef => ({ rowId: r.id, fp: fpOf(r), date: r.date, amountCents: Math.abs(r.amountCents), payee: r.payee, account: accountById.get(r.accountId)?.name ?? "" });
  const refOfFp = (fp: RowFingerprint): LedgerRef => {
    const row = input.rows.find((r) => r.date === fp.date && r.amountCents === fp.amountCents && sameFp(fpOf(r), fp));
    return row ? refOf(row) : { rowId: null, fp, date: fp.date, amountCents: Math.abs(fp.amountCents), payee: fp.payee, account: fp.institution };
  };

  const rowById = new Map(input.rows.map((r) => [r.id, r]));
  const qualify = (r: LedgerRowIn): Qualification | null => qualifyPayee(r.payee, r.detail, { category: r.category, byOwner: ownerFiled(r.classifiedBy) });

  // Spending that could have paid a medical bill: outflows from anything but the HSA.
  const spending = input.rows.filter((r) => r.amountCents < 0 && r.lane === "EXPENSE" && !isHsa(r.accountId));
  const claimed = new Set<string>();

  // The day the HSA opened: as typed, else as its first statement shows it (opening at $0).
  const openedOn = settings.openedOn ?? input.openedOn ?? null;

  // ------------------------------------------------------------ rates
  const hsaAccounts = input.hsaAccounts;
  const measured = hsaAccounts.find((a) => a.annualizedReturn != null && Math.abs(a.annualizedReturn) < 0.5)?.annualizedReturn ?? null;
  // Growth: your setting, else the HSA's own measured return, else the forecast's return (the one the
  // whole app assumes), and only with none of those a long-run assumption.
  const linked = input.linked ?? { returnRate: null, dividendYield: null, taxableRate: null };
  const rate = settings.growthRate ?? measured ?? linked.returnRate ?? DEFAULT_RATE;
  const rateSource = settings.growthRate != null ? "SETTING" : measured != null ? "MEASURED" : linked.returnRate != null ? "FORECAST" : "DEFAULT";
  const dividendYield = settings.dividendYield ?? linked.dividendYield ?? DEFAULT_DIVIDEND_YIELD;
  const dividendSource = settings.dividendYield != null ? "SETTING" : linked.dividendYield != null ? "STATEMENTS" : "DEFAULT";
  const taxableRate = settings.taxableRate ?? linked.taxableRate ?? DEFAULT_TAXABLE_RATE;
  const taxableSource = settings.taxableRate != null ? "SETTING" : linked.taxableRate != null ? "TAX_ENGINE" : "DEFAULT";
  const taxM = input.taxMarginal ?? null;
  const marginal = settings.marginalRate ?? input.marginalRate ?? taxM?.incomeRate ?? DEFAULT_MARGINAL;
  const marginalSource = settings.marginalRate != null ? "SETTING" : input.marginalRate != null ? "RETIREMENT" : taxM ? "TAX_REPORT" : "DEFAULT";
  // Payroll tax: the contributor's own (pay stubs). The Taxes page's federal rate already
  // holds the Additional Medicare surtax, so it comes out of the payroll side then.
  const stubPayroll = input.payrollHsa?.payrollRate ?? null;
  const payroll =
    settings.payrollRate != null ? { rate: settings.payrollRate, source: "SETTING" as const }
    : marginalSource === "TAX_REPORT" ? { rate: stubPayroll != null ? stubPayroll - (input.payrollHsa?.surtaxRate ?? 0) : taxM!.payrollRate, source: stubPayroll != null ? ("PAY_STUBS" as const) : ("TAX_REPORT" as const) }
    : stubPayroll != null ? { rate: stubPayroll, source: "PAY_STUBS" as const }
    : { rate: DEFAULT_PAYROLL_RATE, source: "DEFAULT" as const };

  // ------------------------------------------------------------ expenses
  // Owner-picked paying rows first, so an automatic match never takes one of them.
  const pinned = new Map<string, LedgerRef>();
  for (const e of file.expenses) {
    if (!e.paidWith) continue;
    const ref = refOfFp(e.paidWith);
    pinned.set(e.id, ref);
    if (ref.rowId) claimed.add(ref.rowId);
  }
  const auto = new Map<string, LedgerRef>();
  for (const e of [...file.expenses].sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.paidWith || e.source === "LEDGER") continue;
    const near = spending
      .filter((r) => !claimed.has(r.id) && -r.amountCents === e.amountCents && Math.abs(daysBetween(e.date, r.date)) <= AUTO_MATCH_DAYS)
      .sort((a, b) => Math.abs(daysBetween(e.date, a.date)) - Math.abs(daysBetween(e.date, b.date)));
    if (!near.length) continue;
    const best = near[0]!;
    // Two equally close rows of the same amount: don't guess.
    if (near.length > 1 && Math.abs(daysBetween(e.date, near[1]!.date)) === Math.abs(daysBetween(e.date, best.date))) continue;
    claimed.add(best.id);
    auto.set(e.id, refOf(best));
  }

  // Money out of the HSA, each judged direct payment or distribution.
  const hsaOut = input.rows.filter((r) => r.amountCents < 0 && isHsa(r.accountId)).map((r) => ({ ...refOf(r), kind: withdrawalKind(r) }));

  const dupKey = (e: HsaExpense) => `${e.date}|${e.amountCents}`;
  const dupCount = new Map<string, number>();
  for (const e of file.expenses) dupCount.set(dupKey(e), (dupCount.get(dupKey(e)) ?? 0) + 1);

  const expenses: ExpenseView[] = file.expenses.map((e) => {
    const paid = pinned.get(e.id) ?? auto.get(e.id) ?? null;
    const flags: ExpenseFlag[] = [];
    if ((dupCount.get(dupKey(e)) ?? 0) > 1) flags.push("DUPLICATE");
    if (openedOn && e.date < openedOn) flags.push("BEFORE_OPEN");
    if (!e.receipt) flags.push("NO_RECEIPT");
    if (e.paidWith && paid && !paid.rowId) flags.push("PAID_ROW_MISSING");
    let doubt: string | null = null;
    // Added from a statement row that doesn't pass today's rules: probably not medical at all.
    const paidRow = e.source === "LEDGER" && paid?.rowId ? rowById.get(paid.rowId) : undefined;
    if (paidRow && !e.kept && !qualify(paidRow)) {
      flags.push("NOT_MEDICAL");
      doubt = `The charge it came from (${paidRow.payee}, filed under ${paidRow.category}) doesn't look like medical care.`;
    }
    const tiedTo = e.reimbursement?.withdrawal ? hsaOut.find((w) => sameFp(w.fp, e.reimbursement!.withdrawal!)) : undefined;
    if (tiedTo?.kind === "DIRECT") {
      flags.push("BAD_TIE");
      doubt = (doubt ? `${doubt} ` : "") + `Marked reimbursed by an HSA card payment (${tiedTo.payee}, ${tiedTo.date}). That's the HSA paying a provider directly, not paying you back, so this expense hasn't been reimbursed.`;
    }
    const end = e.reimbursement ? (e.reimbursement.date ?? e.date) : today;
    const daysWaiting = Math.max(0, daysBetween(e.date, end));
    return {
      ...e,
      paid,
      paidAuto: !e.paidWith && paid != null,
      withdrawal: e.reimbursement?.withdrawal ? refOfFp(e.reimbursement.withdrawal) : null,
      flags,
      daysWaiting,
      growthCents: flags.includes("BEFORE_OPEN") ? 0 : growthOn(e.amountCents, rate, daysWaiting),
      candidates: paid
        ? []
        : spending.filter((r) => !claimed.has(r.id) && -r.amountCents === e.amountCents && Math.abs(daysBetween(e.date, r.date)) <= CANDIDATE_DAYS).map(refOf),
      doubt,
    };
  });

  // ------------------------------------------------------------ suggestions
  const ignored = new Set(file.ignoredMerchants.map((m) => m.toUpperCase()));
  const isDismissed = (r: LedgerRowIn) => {
    const fp = fpOf(r);
    return file.dismissed.some((d) => sameFp(d, fp));
  };
  // Logged expenses not tied to a row still hide a same-amount row within the window
  // (e.g. two equally close candidates): better to miss a suggestion than to log twice.
  const unmatchedLogged = expenses.filter((e) => !e.paid);
  const refunds = input.rows.filter((r) => r.amountCents > 0 && !isHsa(r.accountId));
  const suggestions: Suggestion[] = [];
  for (const r of spending) {
    if (claimed.has(r.id) || isDismissed(r)) continue;
    if (openedOn && r.date < openedOn) continue;
    const merchant = r.merchantKey || r.payee;
    if (ignored.has(merchant.toUpperCase())) continue;
    const q = qualify(r);
    if (!q) continue;
    const refunded = refunds.some(
      (x) => x.accountId === r.accountId && x.amountCents === -r.amountCents && (x.merchantKey ?? x.payee) === merchant && daysBetween(r.date, x.date) >= 0 && daysBetween(r.date, x.date) <= REFUND_DAYS,
    );
    if (refunded) continue;
    if (unmatchedLogged.some((e) => e.amountCents === -r.amountCents && Math.abs(daysBetween(e.date, r.date)) <= AUTO_MATCH_DAYS)) continue;
    suggestions.push({ ...refOf(r), merchant, tier: q.tier, kind: q.kind, reason: q.reason, patient: "" });
  }
  suggestions.sort((a, b) => (a.tier === b.tier ? b.date.localeCompare(a.date) : a.tier === "LIKELY" ? -1 : 1));

  // ------------------------------------------------------------ HSA withdrawals
  const unreimbursed = expenses.filter((e) => (!e.reimbursement || e.flags.includes("BAD_TIE")) && !e.flags.includes("BEFORE_OPEN") && !e.flags.includes("NOT_MEDICAL"));
  const withdrawals: Withdrawal[] = hsaOut
    .map((w) => {
      const linkedIds = expenses.filter((e) => e.reimbursement?.withdrawal && sameFp(e.reimbursement.withdrawal, w.fp)).map((e) => e.id);
      const exactMatch = w.kind === "DISTRIBUTION" && !linkedIds.length ? exactSubset(unreimbursed.filter((e) => e.date <= w.date), w.amountCents) : null;
      return { ...w, linkedIds, exactMatch };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // ------------------------------------------------------------ totals
  const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);
  const open = expenses.filter((e) => !e.reimbursement);
  const done = expenses.filter((e) => e.reimbursement);
  // Paid before the HSA opened, or doubtfully medical: kept in the log, left out of what's reimbursable.
  const eligibleOpen = open.filter((e) => !e.flags.includes("BEFORE_OPEN") && !e.flags.includes("NOT_MEDICAL"));
  const missing = open.filter((e) => !e.receipt);
  const openCents = sum(eligibleOpen);
  const totals: HsaReport["totals"] = {
    count: expenses.length,
    loggedCents: sum(expenses),
    unreimbursedCents: openCents,
    unreimbursedCount: eligibleOpen.length,
    reimbursedCents: sum(done),
    reimbursedCount: done.length,
    growthCents: eligibleOpen.reduce((s, e) => s + e.growthCents, 0),
    readyCents: sum(eligibleOpen.filter((e) => e.receipt)),
    missingReceiptCount: missing.length,
    missingReceiptCents: sum(missing),
    oldestUnreimbursed: eligibleOpen.reduce<string | null>((m, e) => (m == null || e.date < m ? e.date : m), null),
    avgDaysWaiting: openCents ? Math.round(eligibleOpen.reduce((s, e) => s + e.daysWaiting * e.amountCents, 0) / openCents) : 0,
  };

  // ------------------------------------------------------------ growth & strategy
  const thisYear = Number(today.slice(0, 4));
  const planYear = settings.planYear && settings.planYear > thisYear ? settings.planYear : thisYear + 20;
  const years = planYear - thisYear;
  const assumptions: StrategyAssumptions = {
    rate,
    dividendYield,
    taxableRate,
    marginalRate: marginal,
    payrollRate: payroll.rate,
    growthCovered: settings.growthCovered ?? true,
    exitRate: settings.exitRate ?? marginal,
    years,
  };
  // Both lines are what the money is worth if taken out that year, after every tax.
  const path: HsaReport["growth"]["path"] = [];
  for (let y = 0; y <= years; y++) {
    path.push({ year: thisYear + y, hsaCents: Math.round(openCents * hsaAfterTax(assumptions, y)), taxableCents: Math.round(openCents * taxableAfterTax(assumptions, y)) });
  }
  const funding = hsaFunding(input.rows, isHsa, input.payrollHsa);
  const strategy = strategyRows(assumptions, 100_000, planYear);

  // ------------------------------------------------------------ breakdowns
  const yearMap = new Map<number, YearRow>();
  const yr = (y: number) => yearMap.get(y) ?? yearMap.set(y, { year: y, count: 0, totalCents: 0, reimbursedCents: 0, unreimbursedCents: 0, reimbursedInYearCents: 0 }).get(y)!;
  for (const e of expenses) {
    const row = yr(Number(e.date.slice(0, 4)));
    row.count++;
    row.totalCents += e.amountCents;
    if (e.reimbursement) row.reimbursedCents += e.amountCents;
    else row.unreimbursedCents += e.amountCents;
    if (e.reimbursement?.date) yr(Number(e.reimbursement.date.slice(0, 4))).reimbursedInYearCents += e.amountCents;
  }
  const breakdown = (key: (e: ExpenseView) => string): Breakdown[] => {
    const m = new Map<string, Breakdown>();
    for (const e of expenses) {
      const k = key(e);
      const b = m.get(k) ?? m.set(k, { key: k, count: 0, totalCents: 0, unreimbursedCents: 0 }).get(k)!;
      b.count++;
      b.totalCents += e.amountCents;
      if (!e.reimbursement) b.unreimbursedCents += e.amountCents;
    }
    return [...m.values()].sort((a, b) => b.totalCents - a.totalCents);
  };

  const patients = [...new Set([...input.persons, ...file.expenses.map((e) => e.patient)].filter(Boolean))];
  const hsaBalance = hsaAccounts.length ? hsaAccounts.reduce((s, a) => s + a.balanceCents, 0) : null;
  const asOf = hsaAccounts.reduce<string | null>((m, a) => (a.asOf && (!m || a.asOf > m) ? a.asOf : m), null);

  return {
    today,
    settings,
    expenses: expenses.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    suggestions,
    withdrawals,
    withdrawalTotals: {
      distributionCents: withdrawals.filter((w) => w.kind === "DISTRIBUTION").reduce((s, w) => s + w.amountCents, 0),
      directCents: withdrawals.filter((w) => w.kind === "DIRECT").reduce((s, w) => s + w.amountCents, 0),
    },
    totals,
    hsa: { accounts: hsaAccounts, balanceCents: hsaBalance, asOf, measuredReturn: measured, blockers: input.blockers ?? { balance: [], rows: [] }, openedOn, openedFrom: settings.openedOn ? "SETTING" : openedOn ? "STATEMENTS" : null },
    growth: {
      rate,
      rateSource,
      dividendSource,
      taxableSource,
      marginalRate: marginal,
      marginalSource,
      payrollSource: payroll.source,
      assumptions,
      planYear,
      years,
      futureValueCents: path.at(-1)!.hsaCents,
      taxableValueCents: path.at(-1)!.taxableCents,
      path,
      strategy,
      funding,
    },
    years: [...yearMap.values()].sort((a, b) => b.year - a.year),
    byPatient: breakdown((e) => e.patient || "Unassigned"),
    byKind: breakdown((e) => e.kind),
    patients,
    ignoredMerchants: file.ignoredMerchants,
    dismissed: file.dismissed.map(refOfFp),
  };
}
