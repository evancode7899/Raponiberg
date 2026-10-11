import { daysBetween } from "../dates/isoDate.ts";
import type { RowFingerprint } from "../review/rowDecisions.ts";
import { qualifyPayee, type ExpenseKind, type Tier } from "./qualify.ts";
import { sameFp, type HsaExpense, type HsaFile, type HsaSettings } from "./store.ts";

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
 *  - Withdrawals from the HSA are listed for tying reimbursements to, with the unreimbursed
 *    expenses whose amounts add up to each one exactly.
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
  merchantKey: string | null;
  category: string;
  classifiedBy: string | null;
};
export type HsaAccountIn = { name: string; balanceCents: number; asOf: string | null; annualizedReturn: number | null };

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

export type ExpenseFlag = "DUPLICATE" | "BEFORE_OPEN" | "NO_RECEIPT" | "PAID_ROW_MISSING";

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
};

export type Suggestion = LedgerRef & { merchant: string; tier: Tier; kind: ExpenseKind; reason: string; patient: string };

export type Withdrawal = LedgerRef & {
  /** Expenses already marked reimbursed by this withdrawal. */
  linkedIds: string[];
  /** Unreimbursed expenses whose amounts add up to this withdrawal exactly (none when it's linked). */
  exactMatch: string[] | null;
};

export type YearRow = { year: number; count: number; totalCents: number; reimbursedCents: number; unreimbursedCents: number; reimbursedInYearCents: number };
export type Breakdown = { key: string; count: number; totalCents: number; unreimbursedCents: number };

export type HsaReport = {
  today: string;
  settings: HsaSettings;
  expenses: ExpenseView[];
  suggestions: Suggestion[];
  withdrawals: Withdrawal[];
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
  hsa: { accounts: HsaAccountIn[]; balanceCents: number | null; asOf: string | null; measuredReturn: number | null };
  growth: {
    rate: number;
    rateSource: "SETTING" | "MEASURED" | "DEFAULT";
    marginalRate: number;
    marginalSource: "SETTING" | "RETIREMENT" | "DEFAULT";
    planYear: number;
    years: number;
    /** The unreimbursed total left invested until the plan year. */
    futureValueCents: number;
    /** The same money in a taxable account, growth taxed yearly at the marginal rate. */
    taxableValueCents: number;
    /** Year by year to the plan year: tax-free vs taxable. */
    path: { year: number; hsaCents: number; taxableCents: number }[];
    /** Per $1,000 of medical bills: the three ways to pay (the spreadsheet's comparison). */
    strategy: { label: string; pretaxCostCents: number; taxSavedCents: number; growthCents: number; netBenefitCents: number; note: string }[];
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
const DAYS_PER_YEAR = 365.25;

const growthOn = (cents: number, rate: number, days: number) => (days <= 0 ? 0 : Math.round(cents * (Math.pow(1 + rate, days / DAYS_PER_YEAR) - 1)));

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

  // Spending that could have paid a medical bill: outflows from anything but the HSA.
  const spending = input.rows.filter((r) => r.amountCents < 0 && r.lane === "EXPENSE" && !isHsa(r.accountId));
  const claimed = new Set<string>();

  // ------------------------------------------------------------ rates
  const hsaAccounts = input.hsaAccounts;
  const measured = hsaAccounts.find((a) => a.annualizedReturn != null && Math.abs(a.annualizedReturn) < 0.5)?.annualizedReturn ?? null;
  const rate = settings.growthRate ?? measured ?? DEFAULT_RATE;
  const rateSource = settings.growthRate != null ? "SETTING" : measured != null ? "MEASURED" : "DEFAULT";
  const marginal = settings.marginalRate ?? input.marginalRate ?? DEFAULT_MARGINAL;
  const marginalSource = settings.marginalRate != null ? "SETTING" : input.marginalRate != null ? "RETIREMENT" : "DEFAULT";

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

  const dupKey = (e: HsaExpense) => `${e.date}|${e.amountCents}`;
  const dupCount = new Map<string, number>();
  for (const e of file.expenses) dupCount.set(dupKey(e), (dupCount.get(dupKey(e)) ?? 0) + 1);

  const expenses: ExpenseView[] = file.expenses.map((e) => {
    const paid = pinned.get(e.id) ?? auto.get(e.id) ?? null;
    const flags: ExpenseFlag[] = [];
    if ((dupCount.get(dupKey(e)) ?? 0) > 1) flags.push("DUPLICATE");
    if (settings.openedOn && e.date < settings.openedOn) flags.push("BEFORE_OPEN");
    if (!e.receipt) flags.push("NO_RECEIPT");
    if (e.paidWith && paid && !paid.rowId) flags.push("PAID_ROW_MISSING");
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
    if (settings.openedOn && r.date < settings.openedOn) continue;
    const merchant = r.merchantKey || r.payee;
    if (ignored.has(merchant.toUpperCase())) continue;
    const ownerHealth = r.category === "Health & insurance" && (r.classifiedBy === "user-merchant-rule" || r.classifiedBy === "USER");
    const q = qualifyPayee(r.payee, null, ownerHealth);
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
  const unreimbursed = expenses.filter((e) => !e.reimbursement && !e.flags.includes("BEFORE_OPEN"));
  const withdrawals: Withdrawal[] = input.rows
    .filter((r) => r.amountCents < 0 && isHsa(r.accountId))
    .map((r) => {
      const ref = refOf(r);
      const linkedIds = expenses.filter((e) => e.reimbursement?.withdrawal && sameFp(e.reimbursement.withdrawal, ref.fp)).map((e) => e.id);
      const exactMatch = linkedIds.length ? null : exactSubset(unreimbursed.filter((e) => e.date <= r.date), ref.amountCents);
      return { ...ref, linkedIds, exactMatch };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // ------------------------------------------------------------ totals
  const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);
  const open = expenses.filter((e) => !e.reimbursement);
  const done = expenses.filter((e) => e.reimbursement);
  const eligibleOpen = open.filter((e) => !e.flags.includes("BEFORE_OPEN"));
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
  const afterTaxRate = rate * (1 - marginal);
  const path: HsaReport["growth"]["path"] = [];
  for (let y = 0; y <= years; y++) {
    path.push({ year: thisYear + y, hsaCents: Math.round(openCents * Math.pow(1 + rate, y)), taxableCents: Math.round(openCents * Math.pow(1 + afterTaxRate, y)) });
  }
  const per = 100_000; // $1,000
  const hsaGrowth = Math.round(per * (Math.pow(1 + rate, years) - 1));
  const taxableGrowth = Math.round(per * (Math.pow(1 + afterTaxRate, years) - 1));
  const taxSaved = Math.round(per * marginal);
  const strategy = [
    { label: "No HSA", pretaxCostCents: Math.round(per / (1 - marginal)), taxSavedCents: 0, growthCents: 0, netBenefitCents: 0, note: "Paid with after-tax money: it takes more pay than the bill to cover it." },
    { label: "Pay from the HSA now", pretaxCostCents: per, taxSavedCents: taxSaved, growthCents: 0, netBenefitCents: taxSaved, note: "Pre-tax dollars pay the bill: the income tax on them is saved, but that money stops growing." },
    {
      label: `Pay out of pocket, reimburse in ${planYear}`,
      pretaxCostCents: per,
      taxSavedCents: taxSaved,
      growthCents: hsaGrowth - taxableGrowth,
      netBenefitCents: taxSaved + hsaGrowth - taxableGrowth,
      note: `The same tax saved, and the $1,000 keeps compounding tax-free in the HSA. The cash you paid with would otherwise have grown in a taxable account (${(afterTaxRate * 100).toFixed(1)}% after tax), so the edge is the difference.`,
    },
  ];

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
    totals,
    hsa: { accounts: hsaAccounts, balanceCents: hsaBalance, asOf, measuredReturn: measured },
    growth: {
      rate,
      rateSource,
      marginalRate: marginal,
      marginalSource,
      planYear,
      years,
      futureValueCents: path.at(-1)!.hsaCents,
      taxableValueCents: path.at(-1)!.taxableCents,
      path,
      strategy,
    },
    years: [...yearMap.values()].sort((a, b) => b.year - a.year),
    byPatient: breakdown((e) => e.patient || "Unassigned"),
    byKind: breakdown((e) => e.kind),
    patients,
    ignoredMerchants: file.ignoredMerchants,
    dismissed: file.dismissed.map(refOfFp),
  };
}
