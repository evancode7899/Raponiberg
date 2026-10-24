import { amountsFromLines } from "../../tax/facts/payroll.ts";
import { expenseFingerprint } from "../../profile/annualMath.ts";
import type { LivingTrail } from "../../profile/basePay.ts";
import type { FinancialProfileSettings } from "../../profile/settings.ts";
import type { Book, BookRow } from "../load.ts";
import { oneOffSubject } from "../reimbursements.ts";
import { countsOn } from "../rent.ts";
import { taxRows } from "../taxPayments.ts";
import { cashFlowContributions } from "./cashFlow.ts";
import { oneOffRules, provenMonths } from "./spending.ts";

/**
 * Living cost: the one definition every page uses (the Annual report, the forecast's
 * living seeds, the Goals emergency fund, the Home budget). Spending as Cash flow selects
 * it (cashFlowContributions), less tax payments (taxes, not living), less what the owner
 * counts as one-off, less expense reimbursements received (Zelle/Venmo rows and the
 * reimbursements paid inside paychecks).
 */

export type OneOffRow = {
  fingerprint: string;
  date: string;
  payee: string;
  account: string;
  category: string;
  cents: number;
  /** Counted as non-recurring: tagged by hand, or its category is. */
  tagged: boolean;
  viaCategory: boolean;
  label: string;
};

/** What every window over one Book shares (rent timing reads every row): worked out once per Book. */
const memo = new WeakMap<Book, { accountName: Map<string, string>; dayOf: (r: BookRow) => string }>();
function perBook(book: Book) {
  let m = memo.get(book);
  if (!m) {
    m = {
      accountName: new Map(book.accounts.map((a) => [a.id, a.name])),
      dayOf: countsOn(book.rows, book.accounts, book.household.merchantRules),
    };
    memo.set(book, m);
  }
  return m;
}

const NOT_OTHER_INCOME = new Set(["Paycheck", "P2P & reimbursements", "Interest"]);

/** Income and spending rows booked in a window (cashRowsIn). */
export type CashRows = {
  interest: number;
  other: number;
  reimbursements: number;
  /** Paycheck reimbursement lines linked to the charges they paid back: already counted in those charges' categories. */
  payLinked: number;
  nonRecurring: number;
  taxSpending: number;
  spending: Map<string, number>;
  candidates: OneOffRow[];
  otherByCategory: Map<string, number>;
  taxByCategory: { income: Map<string, number>; spending: Map<string, number> };
  /** Booked in the window but counted by Cash flow in another (or the reverse): rent paid ahead. Signed, as it moves saving. */
  timing: number;
};

// Income and spending in [from, to], tax payments excluded, selected exactly as Cash flow
// selects them (cashFlowContributions): rent in the month it pays for, a period total
// spread over its statement. So a year here is the sum of its months there. Where that
// differs from the day the ledger books a row (rent paid ahead), `timing` says by how
// much, and the bridge to net worth shows it.
export function cashRowsIn(book: Book, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, from: string, to: string, taxIds: Set<string>): CashRows {
  const nonRecurringCats = new Set(settings.nonRecurringCategories);
  const { accountName, dayOf } = perBook(book);
  const rules = oneOffRules(book, settings);
  let interest = 0;
  let other = 0;
  let reimbursements = 0;
  let payLinked = 0;
  let nonRecurring = 0;
  // Tax payments filed as spending: taxes, not living (Cash flow counts them as spending).
  let taxSpending = 0;
  const spending = new Map<string, number>();
  const candidates: OneOffRow[] = [];
  // The same, by category (the proof of each line).
  const otherByCategory = new Map<string, number>();
  const taxByCategory = { income: new Map<string, number>(), spending: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  // Rows the ledger books in the window less rows Cash flow counts in it: rent paid ahead (or late).
  let timing = 0;
  for (const r of book.rows) {
    if (taxIds.has(r.id) || (r.lane !== "INCOME" && r.lane !== "EXPENSE") || r.precision !== "EXACT") continue;
    const day = dayOf(r);
    if (day === r.bookedOn) continue;
    timing += (r.bookedOn >= from && r.bookedOn <= to ? r.amountCents : 0) - (day >= from && day <= to ? r.amountCents : 0);
  }
  // A reimbursement link's pair (book/reimbursements.ts) is among the contributions: its credit
  // nets the charge's category, its debit takes the payback off the income it came in with.
  for (const { row: r, cents } of cashFlowContributions(book, [{ start: from, end: to }], null)) {
    if (taxIds.has(r.id)) {
      if (r.lane === "EXPENSE") {
        taxSpending -= cents;
        bump(taxByCategory.spending, r.category, -cents);
      } else if (r.lane === "INCOME") bump(taxByCategory.income, r.category, cents);
      continue;
    }
    if (r.lane === "INCOME") {
      // Paid inside a paycheck: the stub line already offsets living, so it's taken off that instead.
      if (r.reimbursement?.source === "stub") payLinked -= cents;
      else if (r.category === "P2P & reimbursements") reimbursements += cents;
      else if (r.category === "Interest") interest += cents;
      else if (!NOT_OTHER_INCOME.has(r.category)) {
        other += cents;
        bump(otherByCategory, r.category, cents);
      }
      continue;
    }
    if (r.lane !== "EXPENSE") continue;
    // A reimbursement credit counts the way its charge does (living or one-off).
    const subject = oneOffSubject(r, book.rowById);
    const fp = expenseFingerprint({ accountId: subject.accountId, date: subject.date, amountCents: subject.amountCents, payee: subject.payee });
    const viaCategory = nonRecurringCats.has(subject.category);
    const tagged = rules.tagged(r);
    if (tagged) nonRecurring -= cents;
    else spending.set(r.category, (spending.get(r.category) ?? 0) - cents);
    // Offered for marking by the same test as Cash flow's list (spending.ts oneOffRules).
    if (rules.candidate(r)) {
      candidates.push({ fingerprint: fp, date: r.date, payee: r.payee, account: accountName.get(r.accountId) ?? "", category: r.category, cents: -r.amountCents, tagged, viaCategory, label: settings.oneOffs[fp] ?? "" });
    }
  }
  candidates.sort((a, b) => Number(b.tagged) - Number(a.tagged) || b.cents - a.cents);
  // A period total spread over its statement leaves fractions of a cent: rounded once, here (as Cash flow does).
  const round = (m: Map<string, number>) => new Map([...m].map(([k, v]) => [k, Math.round(v)]));
  return {
    interest: Math.round(interest),
    other: Math.round(other),
    reimbursements: Math.round(reimbursements),
    payLinked: Math.round(payLinked),
    nonRecurring: Math.round(nonRecurring),
    taxSpending: Math.round(taxSpending),
    spending: round(spending),
    candidates,
    otherByCategory: round(otherByCategory),
    taxByCategory: { income: round(taxByCategory.income), spending: round(taxByCategory.spending) },
    timing,
  };
}

/** A living-cost figure's parts, as the forecast's proof lists them. */
export function livingTrail(from: string, to: string, rows: CashRows, payReimbursements: number): LivingTrail {
  const tagged = rows.candidates.filter((c) => c.tagged);
  const byCategory = new Map<string, { cents: number; rows: number }>();
  for (const c of tagged.filter((x) => x.viaCategory)) {
    const cur = byCategory.get(c.category) ?? { cents: 0, rows: 0 };
    byCategory.set(c.category, { cents: cur.cents + c.cents, rows: cur.rows + 1 });
  }
  const spending = [...rows.spending.values()].reduce((s, v) => s + v, 0);
  return {
    from,
    to,
    spending,
    taxPayments: rows.taxSpending,
    oneOffs: tagged
      .filter((c) => !c.viaCategory)
      .map(({ date, payee, account, category, cents, label }) => ({ date, payee, account, category, cents, label }))
      .sort((a, b) => a.date.localeCompare(b.date) || b.cents - a.cents),
    oneOffCategories: [...byCategory].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.cents - a.cents),
    reimbursements: rows.reimbursements,
    payReimbursements,
    windowCents: spending - rows.reimbursements - payReimbursements,
  };
}

/** Reimbursements paid inside paychecks dated in [from, to] (they offset spending, as Zelle/Venmo ones do). */
export function payReimbursementsIn(book: Book, from: string, to: string): number {
  return book.stubs.filter((s) => s.personId && s.payDate >= from && s.payDate <= to).reduce((t, s) => t + amountsFromLines(s.lines, "current").nonTaxable, 0);
}

/** Living cost over [from, to] (inclusive days), with how it adds up. */
export function livingIn(book: Book, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, from: string, to: string): { cents: number; trail: LivingTrail; rows: CashRows } {
  const rows = cashRowsIn(book, settings, from, to, new Set(taxRows(book, from, to).map((r) => r.id)));
  // Paycheck lines already linked to their charges are counted in those charges' categories.
  const inPay = payReimbursementsIn(book, from, to) - rows.payLinked;
  const trail = livingTrail(from, to, rows, inPay);
  return { cents: trail.windowCents, trail, rows };
}

/** One month's living cost (and, apart, one category's part of it, for a page that leaves it out). */
export type LivingMonth = { start: string; end: string; cents: number; spendingCents: number; leftOutCents: number };

/**
 * The household's typical month: living cost averaged over the latest proven complete
 * months, up to a year — the window Cash flow shows (the unbroken run of proven months).
 * `leaveOut`: a category the page replaces with its own figure (the Home budget leaves out
 * housing, which a home's own costs replace); its part is reported apart. Null with no
 * proven month.
 */
export function typicalMonthlyLiving(
  book: Book,
  settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">,
  opts: { leaveOut?: string } = {},
): { cents: number; months: number; from: string; to: string; leftOutCents: number; periods: LivingMonth[] } | null {
  const window = buildCashFlowWindow(book).slice(-12);
  if (!window.length) return null;
  const periods = window.map(({ start, end, spendingCents }): LivingMonth => {
    const l = livingIn(book, settings, start, end);
    const leftOutCents = opts.leaveOut ? (l.rows.spending.get(opts.leaveOut) ?? 0) : 0;
    return { start, end, cents: l.cents - leftOutCents, spendingCents, leftOutCents };
  });
  const sum = (f: (p: LivingMonth) => number) => periods.reduce((s, p) => s + f(p), 0);
  return {
    cents: Math.round(sum((p) => p.cents) / periods.length),
    months: periods.length,
    from: periods[0]!.start,
    to: periods.at(-1)!.end,
    leftOutCents: Math.round(sum((p) => p.leftOutCents) / periods.length),
    periods,
  };
}

/** The proven complete months Cash flow shows, oldest first (the spending report's window). */
function buildCashFlowWindow(book: Book) {
  return provenMonths(book).window;
}
