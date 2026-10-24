import { minIso } from "../dates/isoDate.ts";
import { valueAt } from "../ledger/timeline.ts";
import { taxYearThrough } from "./blockers.ts";
import type { FederalParams } from "../tax/params.ts";
import type { Book, BookAccount, BookBrokerage, BookRow } from "./load.ts";

/**
 * Money going into tax-advantaged accounts, read once from the Book so the Taxes page and
 * the Tax-advantaged accounts page can't disagree: 401(k) deferrals against the limit and
 * the return of any excess, IRA contributions and Roth conversions, and CHET 529
 * contributions. Each figure is checked against a second source where one exists (the
 * custodian's year-to-date line against the ledger's deposits; a corrective 401(k)
 * withdrawal against the bank deposit it became), and any disagreement is reported.
 */

const pos = (n: number) => Math.max(0, n);
const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

export const IRA_SUBTYPES = ["TRADITIONAL_IRA", "ROLLOVER_IRA", "ROTH_IRA"];
export const RETIREMENT_SUBTYPES = [...IRA_SUBTYPES, "401K"];

// ---------------------------------------------------------------------------- accounts

/** The brokerage statements of a ledger account (by account number). */
export function snapshotsOf(book: Book, acct: BookAccount): BookBrokerage[] {
  return book.brokerage.filter((b) => acct.identifiers.includes(b.accountNumber));
}

/** Whose account it is: the tax profile's owner, else the name on its statements or the account. */
export function accountOwner(book: Book, accountId: string): string | null {
  const acct = book.accounts.find((a) => a.id === accountId);
  if (!acct) return null;
  for (const idn of acct.identifiers) {
    const o = book.taxProfile.accountOwners[idn];
    if (o && o !== "JOINT") return o;
  }
  const line = snapshotsOf(book, acct)[0]?.ownerLine ?? acct.name;
  const u = line.toUpperCase();
  const named = book.persons.find((p) => p.match.some((m) => u.includes(m)))?.id;
  if (named) return named;
  // A workplace plan is named for the employer: it's the person whose pay stubs name it.
  if (acct.subtype === "401K") {
    const name = acct.name.toUpperCase();
    const stub = book.stubs.find((s) => s.personId && s.employer && name.includes(s.employer.toUpperCase().split(/\s+/).slice(0, 2).join(" ")));
    if (stub) return stub.personId;
  }
  return book.persons.length === 1 ? book.persons[0]!.id : null;
}

/** The subtype of the account on the other side of a paired transfer. */
function otherLegSubtype(book: Book, row: BookRow): string | null {
  const m = row.transferMatchId ? book.matches.find((x) => x.id === row.transferMatchId) : null;
  const leg = m?.legs.find((l) => l.transactionId !== row.id);
  return leg ? (book.accounts.find((a) => a.id === leg.accountId)?.subtype ?? null) : null;
}

/**
 * A statement's "contributions year to date" for the year: the largest any of the year's
 * statements prints. The figure only grows during a year, and a statement for a month
 * with no contribution may leave the line out — that doesn't mean nothing went in.
 */
export function statementContributionsYtd(snaps: BookBrokerage[], year: number): number | null {
  const figures = snaps.filter((s) => s.periodEnd.startsWith(String(year)) && s.contributionsYtd != null).map((s) => s.contributionsYtd!);
  return figures.length ? Math.max(...figures) : null;
}

// ---------------------------------------------------------------------------- 401(k)

/** The 401(k) elective-deferral limit for someone this age at year end, with catch-up. */
export function k401Limit(fp: FederalParams, age: number | null): { limit: number; catchUp: number } {
  const lim = fp.retirement;
  const catchUp = age == null || age < 50 ? 0 : age >= 60 && age <= 63 ? lim.k401CatchUp60to63 : lim.k401CatchUp;
  return { limit: fp.limits.k401 + catchUp, catchUp };
}

/** A withdrawal from a 401(k) that returned an excess deferral, and the deposit it became. */
export type CorrectiveReturn = {
  account: string;
  /** The date the plan's statement prints (often its period end), and that statement's period. */
  date: string;
  statement: { start: string; end: string };
  cents: number;
  deposit: { account: string; date: string } | null;
};

export type ExcessDeferral = {
  /** Deferred above the limit across all employers' plans (cents). */
  excess: number;
  /** The excess must be out of the plan by this date or it's taxed again when withdrawn. */
  deadline: string;
  returned: CorrectiveReturn | null;
  /**
   * RETURNED: the plan's statements show it paid back by the deadline. RETURNED_LATE: paid
   * back, but not provably by the deadline. AWAITING: not seen yet, and the deadline (or
   * the plan statements covering it) is still to come. NOT_RETURNED: the statements
   * through the deadline show no such withdrawal.
   */
  status: "RETURNED" | "RETURNED_LATE" | "AWAITING" | "NOT_RETURNED";
};

const CORRECTIVE = /withdraw|distribut|refund|corrective|excess|return/i;

/**
 * Looks for the return of an excess 401(k) deferral: a withdrawal from one of the person's
 * plans, from the start of the year through the next June, within 25% of the excess (it
 * comes back with its earnings or losses) and not a rollover; and the bank deposit of the
 * same amount it turned into.
 */
export function excessDeferral(book: Book, personId: string, year: number, excess: number): ExcessDeferral | null {
  if (excess <= 0) return null;
  const deadline = `${year + 1}-04-15`;
  const plans = book.accounts.filter((a) => a.subtype === "401K" && accountOwner(book, a.id) === personId);
  const candidates = book.rows.filter(
    (r) =>
      plans.some((p) => p.id === r.accountId) &&
      r.date >= `${year}-01-01` &&
      r.date <= `${year + 1}-06-30` &&
      r.amountCents < 0 &&
      CORRECTIVE.test(r.payee) &&
      !/roll/i.test(r.payee) &&
      !RETIREMENT_SUBTYPES.includes(otherLegSubtype(book, r) ?? "") &&
      Math.abs(-r.amountCents - excess) <= excess * 0.25,
  );
  const row = candidates.sort((a, b) => Math.abs(-a.amountCents - excess) - Math.abs(-b.amountCents - excess))[0];
  let returned: CorrectiveReturn | null = null;
  if (row) {
    const cash = new Set(book.accounts.filter((a) => a.group === "Cash").map((a) => a.id));
    const deposit = book.rows.find((r) => cash.has(r.accountId) && r.amountCents === -row.amountCents && r.date >= row.statement.start && r.date <= addDays(row.date, 30));
    returned = {
      account: book.accounts.find((a) => a.id === row.accountId)!.name,
      date: row.date,
      statement: row.statement,
      cents: -row.amountCents,
      deposit: deposit ? { account: book.accounts.find((a) => a.id === deposit.accountId)!.name, date: deposit.date } : null,
    };
  }
  // Paid back on time when the deposit, or the whole statement period that shows it, falls by the deadline.
  const onTime = returned && ((returned.deposit && returned.deposit.date <= deadline) || returned.statement.end <= deadline);
  const plansCovered = plans.length > 0 && plans.every((p) => book.statements.some((s) => s.accountId === p.id && s.periodEnd >= deadline));
  const status: ExcessDeferral["status"] = returned ? (onTime ? "RETURNED" : "RETURNED_LATE") : plansCovered ? "NOT_RETURNED" : "AWAITING";
  return { excess, deadline, returned, status };
}

/**
 * What both pages say about an excess deferral, word for word. `ok` is true when nothing
 * is left to do (returned on time); the excess is income for the year it was deferred
 * either way, and the Taxes page counts it.
 */
export function excessDeferralMessage(name: string, year: number, limit: number, deferred: number, e: ExcessDeferral): { ok: boolean; text: string } {
  const head = `${name}'s ${year} 401(k) deferrals (${dollars(deferred)}) were ${dollars(e.excess)} over the ${dollars(limit)} limit.`;
  const taxed = `The excess counts as ${year} income, in other income on the Taxes page.`;
  const r = e.returned;
  const proof = r
    ? `${r.account} shows a ${dollars(r.cents)} withdrawal (statement ${r.statement.start} to ${r.statement.end})${r.deposit ? `, deposited to ${r.deposit.account} on ${r.deposit.date}` : ", but no bank deposit of that amount was found"}.`
    : "";
  switch (e.status) {
    case "RETURNED":
      return { ok: true, text: `${head} It was returned before ${e.deadline}: ${proof} ${taxed}` };
    case "RETURNED_LATE":
      return { ok: false, text: `${head} It was returned, but not provably by ${e.deadline}: ${proof} If it came out after the deadline it's taxed again in the year withdrawn. ${taxed}` };
    case "AWAITING":
      return { ok: false, text: `${head} No corrective withdrawal is on the plan statements yet; ask the plan to return it by ${e.deadline}, or it's taxed again when withdrawn. ${taxed}` };
    case "NOT_RETURNED":
      return { ok: false, text: `${head} The plan statements through ${e.deadline} show no corrective withdrawal, so it's taxed again when it's eventually withdrawn. ${taxed}` };
  }
}

// ---------------------------------------------------------------------------- IRAs

export type IraYear = {
  /** Money arriving from a bank or taxable account, per IRA (rollovers and conversions aren't contributions). */
  contributions: { accountId: string; account: string; kind: string; cents: number; rowIds: string[] }[];
  /** Moved from a traditional or rollover IRA to a Roth. */
  conversions: number;
  /** This year's traditional-IRA contributions (non-deductible basis for Form 8606). */
  traditionalContributions: number;
  /** Pre-tax IRA money (traditional, rollover) on December 31, or at the data edge for the year in progress. */
  pretaxAccounts: { name: string; cents: number }[];
  /** Where the custodian's year-to-date contributions line disagrees with the ledger. */
  mismatches: string[];
};

/**
 * Form 8606: the taxable part of the year's Roth conversions. Basis (non-deductible
 * contributions) is spread over the year-end pre-tax IRA balance plus what was converted
 * (the pro-rata rule), so pre-tax money left in any IRA makes part of a conversion taxable.
 */
export function taxableConversion(conversions: number, basis: number, pretaxYearEnd: number): number {
  if (conversions <= 0) return 0;
  const nontaxable = Math.min(basis, Math.round((basis * conversions) / (pos(pretaxYearEnd) + conversions)));
  return pos(conversions - nontaxable);
}

/**
 * A person's IRA contributions and Roth conversions for the year, from the IRAs' ledger
 * rows. The year in progress runs through the data edge (taxYearThrough), as pay and every
 * other figure on the Taxes and Account limits pages do: an IRA statement already in past
 * it waits for the rest of the household's.
 */
export function iraYear(book: Book, personId: string, year: number): IraYear {
  const through = taxYearThrough(book, year);
  const iras = book.accounts.filter((a) => IRA_SUBTYPES.includes(a.subtype ?? "") && accountOwner(book, a.id) === personId);
  const contributions: IraYear["contributions"] = [];
  const mismatches: string[] = [];
  let conversions = 0;
  for (const a of iras) {
    let contributed = 0;
    let deposited = 0;
    const rowIds: string[] = [];
    for (const r of book.rows.filter((x) => x.accountId === a.id && x.date.startsWith(String(year)) && x.date <= through)) {
      if (r.amountCents > 0 && r.lane !== "INCOME") deposited += r.amountCents;
      const other = otherLegSubtype(book, r);
      const rollover = /roll|acat|transfer of assets/i.test(r.payee) && !/conver|to roth/i.test(r.payee);
      if (r.amountCents > 0 && r.lane !== "INCOME" && a.subtype !== "ROLLOVER_IRA" && !rollover && !RETIREMENT_SUBTYPES.includes(other ?? "") && !/conver/i.test(r.payee)) {
        contributed += r.amountCents;
        rowIds.push(r.id);
      }
      if (r.amountCents < 0 && a.subtype !== "ROTH_IRA" && (other === "ROTH_IRA" || /conver|to roth/i.test(r.payee))) conversions -= r.amountCents;
    }
    if (contributed) contributions.push({ accountId: a.id, account: a.name, kind: a.subtype!, cents: contributed, rowIds });
    // The custodian's "contributions" line counts every deposit (rollovers and conversions
    // in too), so it checks that no deposit is missing; which kind each is comes from the rows.
    const stated = statementContributionsYtd(snapshotsOf(book, a).filter((s) => s.periodEnd <= through), year);
    if (stated != null && stated !== deposited) {
      mismatches.push(`${a.name}: the ${year} statements show ${dollars(stated)} deposited, but the ledger's deposits into it add up to ${dollars(deposited)}.`);
    }
  }
  const traditionalContributions = contributions.filter((c) => c.kind === "TRADITIONAL_IRA").reduce((s, c) => s + c.cents, 0);
  const pretaxAccounts = iras
    .filter((a) => a.subtype !== "ROTH_IRA")
    .map((a) => {
      const t = book.ledger.accounts.find((l) => l.id === a.id)?.timeline;
      return { name: a.name, cents: t?.lastDay ? valueAt(t, minIso(through, t.lastDay)).cents : 0 };
    })
    .filter((x) => x.cents !== 0);
  return { contributions, conversions, traditionalContributions, pretaxAccounts, mismatches };
}

// ---------------------------------------------------------------------------- CHET 529

export type ChetYear = {
  accounts: {
    accountNumber: string;
    name: string;
    /** What counts: the statements' year-to-date line, else the ledger's deposits. */
    cents: number;
    statement: number | null;
    ledger: number | null;
    /** The ledger's deposits into it (the rows `ledger` adds up). */
    rowIds: string[];
  }[];
  total: number;
  mismatches: string[];
};

/**
 * Contributions to CHET (Connecticut's 529) for the year, per account: the statements'
 * year-to-date line, checked against the deposits the ledger shows going into the account.
 */
export function chetYear(book: Book, year: number): ChetYear {
  // The year in progress runs through the data edge, as iraYear does.
  const through = taxYearThrough(book, year);
  const numbers = [...new Set(book.brokerage.filter((b) => b.isChet && b.periodEnd.startsWith(String(year)) && b.periodEnd <= through).map((b) => b.accountNumber))];
  const mismatches: string[] = [];
  const accounts = numbers.map((n) => {
    const acct = book.accounts.find((a) => a.identifiers.includes(n));
    const statement = statementContributionsYtd(
      book.brokerage.filter((b) => b.accountNumber === n && b.periodEnd <= through),
      year,
    );
    const deposits = acct ? book.rows.filter((r) => r.accountId === acct.id && r.date.startsWith(String(year)) && r.date <= through && r.amountCents > 0 && r.lane !== "INCOME") : null;
    const ledger = deposits ? deposits.reduce((s, r) => s + r.amountCents, 0) : null;
    const name = acct?.name ?? `CHET 529 ••${n.slice(-4)}`;
    if (statement != null && ledger != null && statement !== ledger) {
      mismatches.push(`${name}: the ${year} statements show ${dollars(statement)} contributed, but the ledger's deposits into it add up to ${dollars(ledger)}.`);
    }
    return { accountNumber: n, name, cents: statement ?? ledger ?? 0, statement, ledger, rowIds: deposits?.map((r) => r.id) ?? [] };
  });
  return { accounts, total: accounts.reduce((s, a) => s + a.cents, 0), mismatches };
}
