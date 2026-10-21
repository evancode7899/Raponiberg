import { daysBetween, endOfMonth, startOfMonth } from "../../dates/isoDate.ts";
import { expenseFingerprint } from "../../profile/annualMath.ts";
import type { FinancialProfileSettings } from "../../profile/settings.ts";
import type { Book, BookRow } from "../load.ts";
import { oneOffSubject, withReimbursements } from "../reimbursements.ts";
import { countsOn, rentPayments, type RentPayment } from "../rent.ts";
import type { BlockerRef } from "./blockerRef.ts";
import { buildCashFlowReport, type CashFlowPeriod } from "./cashFlow.ts";

/**
 * The spending app's data: every proven calendar month with category and merchant
 * splits, the charges that recur (bills, subscriptions, habits) and the big one-off
 * expenses. Figures come only from months whose every statement and transfer is proven:
 * the window is the unbroken run of proven months ending at the latest complete one, so
 * a month still waiting on a statement never withholds the rest.
 */

/** The key the spending views group a row's merchant (or payer) by. */
export const merchantKeyOf = (r: Pick<BookRow, "merchantKey" | "payee">) => r.merchantKey ?? r.payee;

/** A merchant's (or payer's) net money in one month. Spending is positive. */
export type MerchantMonth = { key: string; name: string; category: string; cents: number; count: number };

export type SpendingMonth = CashFlowPeriod & {
  /** Spending by merchant (net of refunds), largest first. */
  merchants: MerchantMonth[];
  /** Income by payer, largest first. */
  payers: MerchantMonth[];
  /** Spending the owner counts as one-off (tagged on Annual report or Cash flow), included in spendingCents. */
  oneOffCents: number;
  /**
   * What kind of spending, adding up to spendingCents: recurring bills and subscriptions,
   * big one-offs (single charges of $1,500+ that aren't a bill, or anything counted as
   * one-off) and everyday spending (the rest).
   */
  kinds: SpendingKinds;
  /** Spending per day of the month (index 0 = the 1st), split the same way. */
  daily: { allCents: number[]; billCents: number[]; everydayCents: number[] };
  /** Charges (not refunds) by size, in CHARGE_BUCKETS order. */
  chargeSizes: { count: number; cents: number }[];
};

export type SpendingKinds = { billCents: number; bigCents: number; everydayCents: number };

/** Upper bounds (exclusive, cents) of the charge-size buckets; the last is open-ended. */
export const CHARGE_BUCKETS = [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 150_000, Infinity] as const;

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

export type RecurringCharge = {
  key: string;
  name: string;
  category: string;
  kind: "bill" | "habit";
  /** Bills only: how often the charge comes. */
  cadence: Cadence | null;
  count: number;
  monthsSeen: number;
  /** Median single charge. */
  typicalCents: number;
  /** Spending at this merchant over the last twelve window months. */
  last12Cents: number;
  /** Bills: typical charge × charges per year. Habits: the last twelve months' total. */
  annualCents: number;
  firstDate: string;
  lastDate: string;
  lastCents: number;
  /** Still charging: the last charge is recent for its cadence. */
  active: boolean;
  /** Bills that charged a fixed amount: the latest charge versus the ones before (null when unchanged). */
  changeCents: number | null;
};

export type OneOffExpense = {
  fingerprint: string;
  date: string;
  payee: string;
  merchant: string;
  account: string;
  category: string;
  cents: number;
  /** Counted as one-off (tagged by hand, or its category always is). */
  tagged: boolean;
  viaCategory: boolean;
  label: string;
};

export type WithheldMonth = { label: string; start: string; end: string; blockers: BlockerRef[] };

export type SpendingReport = {
  provenThrough: string;
  mergeDate: string;
  /** The unbroken run of proven, complete months (null when no month is proven). */
  window: { from: string; to: string; months: number } | null;
  /** Window months, oldest first. */
  months: SpendingMonth[];
  /** A proven month after the window that isn't over yet (figures through `through`). */
  current: SpendingMonth | null;
  /** Months after the window that can't be proven yet, and why. */
  withheldAfter: WithheldMonth[];
  /** What withholds the history before the window (the month just before it). */
  withheldBefore: WithheldMonth | null;
  recurring: RecurringCharge[];
  /** Rent paid for the window's months (and the current one), each in the month it covers, oldest first. */
  rent: RentPayment[];
  oneOffs: OneOffExpense[];
};

import { ONE_OFF_MIN_CENTS } from "../definitions.ts";
export { ONE_OFF_MIN_CENTS };

/** "WWW SWEETGREEN COM" → "Sweetgreen". */
export function merchantName(key: string): string {
  const words = key
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, a) => !(i === 0 && (w === "WWW" || w === "APLPAY" || w === "TST")) && !(i === a.length - 1 && w === "COM" && a.length > 1));
  return words.map((w) => (w.length <= 2 && /^[A-Z]+$/.test(w) && w !== "OF" ? w : w[0] + w.slice(1).toLowerCase())).join(" ") || key;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

const CADENCES: { id: Cadence; lo: number; hi: number; perYear: number }[] = [
  { id: "weekly", lo: 5, hi: 9, perYear: 52 },
  { id: "biweekly", lo: 12, hi: 17, perYear: 26 },
  { id: "monthly", lo: 25, hi: 36, perYear: 12 },
  { id: "quarterly", lo: 80, hi: 100, perYear: 4 },
  { id: "annual", lo: 340, hi: 390, perYear: 1 },
];

/**
 * Charges that recur at one merchant. A bill comes on a steady cadence for a steady
 * amount (rent, phone, insurance, subscriptions); a habit is a merchant visited often
 * for varying amounts (coffee, lunch, rides). Detected over the whole window; totals are
 * the last twelve months.
 */
export function detectRecurring(rows: BookRow[], windowEnd: string, last12From: string): RecurringCharge[] {
  const byKey = new Map<string, BookRow[]>();
  for (const r of rows) {
    if (r.lane !== "EXPENSE" || r.amountCents >= 0) continue;
    const k = merchantKeyOf(r);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  const out: RecurringCharge[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 3) continue;
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const amounts = list.map((r) => -r.amountCents);
    const monthsSeen = new Set(list.map((r) => r.date.slice(0, 7))).size;
    const typical = median(amounts);
    const spread = typical > 0 ? median(amounts.map((a) => Math.abs(a - typical))) / typical : 1;
    const gaps = list.slice(1).map((r, i) => daysBetween(list[i]!.date, r.date)).filter((g) => g > 0);
    const gap = median(gaps);
    const cadence = CADENCES.find((c) => gap >= c.lo && gap <= c.hi) ?? null;
    const steady = cadence != null && gaps.filter((g) => Math.abs(g - gap) <= Math.max(4, gap * 0.4)).length >= gaps.length * 0.75;
    const last12 = list.filter((r) => r.date >= last12From).reduce((s, r) => s - r.amountCents, 0);
    const first = list[0]!;
    const last = list.at(-1)!;
    // Weekly charges for varying amounts are a routine (a lunch order), not a bill.
    const weekly = cadence?.id === "weekly" || cadence?.id === "biweekly";
    const isBill = steady && spread <= (weekly ? 0.05 : 0.3) && monthsSeen >= 3;
    const isHabit = !isBill && monthsSeen >= 3 && list.length >= 6;
    if ((!isBill && !isHabit) || last12 <= 0) continue;
    // A price change: the charges before the latest were the same amount (a subscription
    // or premium), and the latest differs. Bills that vary every month (utilities) never flag.
    const prev = amounts.slice(-4, -1);
    const prevCents = prev.at(-1)!;
    const change = -last.amountCents - prevCents;
    const fixedBefore = prev.length >= 2 && prev.every((a) => Math.abs(a - prevCents) <= 100);
    out.push({
      key,
      name: merchantName(key),
      category: last.category,
      kind: isBill ? "bill" : "habit",
      cadence: isBill ? cadence!.id : null,
      count: list.length,
      monthsSeen,
      typicalCents: typical,
      last12Cents: last12,
      annualCents: isBill ? typical * cadence!.perYear : last12,
      firstDate: first.date,
      lastDate: last.date,
      lastCents: -last.amountCents,
      // Habits: seen within the last two months. Bills: within one and a half cycles.
      active: daysBetween(last.date, windowEnd) <= (isBill ? Math.round(gap * 1.5) + 10 : 62),
      changeCents: isBill && fixedBefore && Math.abs(change) >= Math.max(100, prevCents * 0.03) ? change : null,
    });
  }
  return out.sort((a, b) => b.annualCents - a.annualCents);
}

const monthsBack = (monthStart: string, n: number) => {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7)) - 1 - n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
};

/**
 * The unbroken run of proven, complete calendar months ending at the latest proven one,
 * plus what withholds the months around it. Shared by every page that shows months of
 * cash flow, so they all end at the same month.
 */
export function provenMonths(book: Book, accountIds?: string[]) {
  const report = buildCashFlowReport(book, { granularity: "month", accountIds });
  const all = report.periods;
  const ok = (p: CashFlowPeriod) => p.blockers.length === 0;
  // The latest whole month that's proven; a partial month at the end (cut at the
  // proven-through date) never anchors the window.
  let end = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (ok(all[i]!) && !all[i]!.through) {
      end = i;
      break;
    }
  }
  let start = end;
  while (start > 0 && ok(all[start - 1]!)) start--;
  const window = end < 0 ? [] : all.slice(start, end + 1);
  const after = end < 0 ? all : all.slice(end + 1);
  const current = after.length === 1 && ok(after[0]!) && after[0]!.through ? after[0]! : null;
  const withheld = (p: CashFlowPeriod): WithheldMonth => ({ label: p.label, start: p.start, end: p.end, blockers: p.blockers });
  return {
    report,
    window,
    current,
    withheldAfter: after.filter((p) => !ok(p)).map(withheld),
    withheldBefore: start > 0 ? withheld(all[start - 1]!) : null,
  };
}

/**
 * The rows the spending views read, and the day each counts on: every row counted in the
 * window (and the current month) on the accounts asked for, less charges reversed in full
 * (a charge and its exact credit on the same account within a week net to nothing: left
 * out so neither side shows on its own). Rows count in the month the period totals count
 * them: where the ledger books them (booking.ts), or for rent, the month it pays for
 * (rent.ts). A reimbursement link's pair counts too, so a paid-back charge's merchant
 * nets down when the payback arrives. The merchant proof reads these same rows
 * (proof/cashFlowProof.ts).
 */
export function spendingRows(book: Book, accountIds?: string[]) {
  const proven = provenMonths(book, accountIds);
  const accountFilter = accountIds?.length ? new Set(accountIds) : null;
  const from = proven.window[0]?.start;
  const to = (proven.current ?? proven.window.at(-1))?.end;
  const windowEnd = proven.window.at(-1)?.end;
  const dayOf = countsOn(book.rows, book.accounts, book.household.merchantRules);
  const inRange = withReimbursements(book).filter((r) => from && to && dayOf(r) >= from && dayOf(r) <= to && (!accountFilter || accountFilter.has(r.accountId)));
  const reversed = reversals(inRange);
  const inScope = inRange.filter((r) => !reversed.has(r.id));
  return {
    ...proven,
    from,
    to,
    windowEnd,
    dayOf,
    /** The reversed pairs left out, for a proof to name. */
    reversed: inRange.filter((r) => reversed.has(r.id)),
    inScope,
    /** What recurring charges are found in: the window's rows, without the current month. */
    windowRows: windowEnd ? inScope.filter((r) => dayOf(r) <= windowEnd) : [],
    /** Where a recurring charge's "last twelve months" start. */
    last12From: windowEnd ? monthsBack(startOfMonth(windowEnd), 11) : "",
  };
}

/** Each merchant's (and payer's) net money over the rows counted in a period, largest first. */
export function merchantsIn(rows: BookRow[], p: { start: string; end: string }, dayOf: (r: BookRow) => string): { merchants: MerchantMonth[]; payers: MerchantMonth[] } {
  const merchants = new Map<string, MerchantMonth>();
  const payers = new Map<string, MerchantMonth>();
  for (const r of rows) {
    if (dayOf(r) < p.start || dayOf(r) > p.end) continue;
    if (r.lane !== "EXPENSE" && r.lane !== "INCOME") continue;
    const key = merchantKeyOf(r);
    const m = r.lane === "EXPENSE" ? merchants : payers;
    const cur = m.get(key) ?? { key, name: merchantName(key), category: r.category, cents: 0, count: 0 };
    cur.cents += r.lane === "EXPENSE" ? -r.amountCents : r.amountCents;
    cur.count++;
    m.set(key, cur);
  }
  const sorted = (m: Map<string, MerchantMonth>) => [...m.values()].filter((x) => x.cents !== 0).sort((a, b) => b.cents - a.cents);
  return { merchants: sorted(merchants), payers: sorted(payers) };
}

/** Whether an expense row counts as one-off: tagged by hand, or its category always is. The one test the spending report and its proofs use. */
export const oneOffTest = (settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, rowById?: Map<string, BookRow>) => {
  const nonRecurring = new Set(settings.nonRecurringCategories);
  // A reimbursement credit counts the way its charge does (book/reimbursements.ts).
  return (row: BookRow) => {
    if (row.lane !== "EXPENSE") return false;
    const r = rowById ? oneOffSubject(row, rowById) : row;
    return nonRecurring.has(r.category) || expenseFingerprint(r) in settings.oneOffs;
  };
};

export function buildSpendingReport(book: Book, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, opts: { accountIds?: string[] } = {}): SpendingReport {
  const { report, window, current, withheldAfter, withheldBefore, from, to, windowEnd, dayOf, inScope, windowRows, last12From } = spendingRows(book, opts.accountIds);
  const accountFilter = opts.accountIds?.length ? new Set(opts.accountIds) : null;
  const accountName = new Map(book.accounts.map((a) => [a.id, a.name]));
  const recurring = windowEnd ? detectRecurring(windowRows, windowEnd, last12From) : [];
  const bills = new Set(recurring.filter((c) => c.kind === "bill").map((c) => c.key));
  const isOneOff = oneOffTest(settings, book.rowById);

  const enrich = (p: CashFlowPeriod): SpendingMonth => {
    let oneOffCents = 0;
    for (const r of inScope) if (r.lane === "EXPENSE" && dayOf(r) >= p.start && dayOf(r) <= p.end && isOneOff(r)) oneOffCents -= r.amountCents;
    return { ...p, ...merchantsIn(inScope, p, dayOf), oneOffCents, ...spendingShape(inScope, p, bills, isOneOff, dayOf) };
  };

  const months = window.map(enrich);
  // Candidates: anything already counted as one-off, and big charges that aren't a bill.
  const oneOffs: OneOffExpense[] = [];
  for (const r of windowRows) {
    if (r.lane !== "EXPENSE" || r.reimbursement) continue;
    const fp = expenseFingerprint(r);
    const viaCategory = settings.nonRecurringCategories.includes(r.category);
    const tagged = viaCategory || fp in settings.oneOffs;
    if (!tagged && (-r.amountCents < ONE_OFF_MIN_CENTS || bills.has(merchantKeyOf(r)))) continue;
    oneOffs.push({
      fingerprint: fp,
      date: r.date,
      payee: r.payee,
      merchant: merchantName(merchantKeyOf(r)),
      account: accountName.get(r.accountId) ?? "",
      category: r.category,
      cents: -r.amountCents,
      tagged,
      viaCategory,
      label: settings.oneOffs[fp] ?? "",
    });
  }
  oneOffs.sort((a, b) => b.cents - a.cents);

  return {
    provenThrough: report.provenThrough,
    mergeDate: report.mergeDate,
    window: window.length ? { from: window[0]!.start, to: window.at(-1)!.end, months: window.length } : null,
    months,
    current: current ? enrich(current) : null,
    withheldAfter,
    withheldBefore,
    recurring,
    rent: from && to ? rentPayments(book.rows, book.accounts, book.household.merchantRules).filter((p) => p.covers >= from && p.covers <= to && (!accountFilter || accountFilter.has(book.rowById.get(p.rowId)!.accountId))) : [],
    oneOffs,
  };
}

/**
 * One month's spending split three ways (bills, big one-offs, everyday), per day of the
 * month, and its charges by size. Everyday absorbs any difference from the period total
 * (full reversals are left out of the rows), so the three always add up to spendingCents.
 */
export function spendingShape(
  rows: BookRow[],
  p: Pick<CashFlowPeriod, "start" | "end" | "spendingCents">,
  bills: Set<string>,
  isOneOff: (r: BookRow) => boolean,
  /** The day a row counts on (rent counts in the month it pays for; see rent.ts). */
  dayOf: (r: BookRow) => string = (r) => r.bookedOn,
): Pick<SpendingMonth, "kinds" | "daily" | "chargeSizes"> {
  const days = Number(endOfMonth(p.start).slice(8, 10));
  const zeros = () => Array.from({ length: days }, () => 0);
  const daily = { allCents: zeros(), billCents: zeros(), everydayCents: zeros() };
  const chargeSizes = CHARGE_BUCKETS.map(() => ({ count: 0, cents: 0 }));
  let billCents = 0;
  let bigCents = 0;
  for (const r of rows) {
    const day = dayOf(r);
    if (r.lane !== "EXPENSE" || day < p.start || day > p.end) continue;
    const cents = -r.amountCents;
    const d = Number(day.slice(8, 10)) - 1;
    daily.allCents[d]! += cents;
    if (bills.has(merchantKeyOf(r))) {
      billCents += cents;
      daily.billCents[d]! += cents;
    } else if (Math.abs(cents) >= ONE_OFF_MIN_CENTS || isOneOff(r)) bigCents += cents;
    else daily.everydayCents[d]! += cents;
    if (cents > 0) {
      const b = chargeSizes[CHARGE_BUCKETS.findIndex((hi) => cents < hi)]!;
      b.count++;
      b.cents += cents;
    }
  }
  return { kinds: { billCents, bigCents, everydayCents: p.spendingCents - billCents - bigCents }, daily, chargeSizes };
}

/** Ids of expense rows that cancel in pairs: a charge and its exact credit on one account within seven days. */
export function reversals(rows: BookRow[]): Set<string> {
  const out = new Set<string>();
  for (const c of rows) {
    if (c.lane !== "EXPENSE" || c.amountCents <= 0) continue;
    const charge = rows.find((r) => !out.has(r.id) && r.lane === "EXPENSE" && r.accountId === c.accountId && r.amountCents === -c.amountCents && Math.abs(daysBetween(r.date, c.date)) <= 7);
    if (!charge) continue;
    out.add(charge.id);
    out.add(c.id);
  }
  return out;
}

/** Last day of the latest proven, complete month (null when none is). */
export function latestProvenMonthEnd(book: Book): string | null {
  const { window } = provenMonths(book);
  return window.at(-1)?.end ?? null;
}

