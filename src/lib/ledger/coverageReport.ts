import { addDays, daysBetween, endOfMonth, periodsBetween, startOfMonth } from "../dates/isoDate.ts";
import type { Ledger } from "./loadLedger.ts";
import { chainBreaks, coverageGaps, type CoverageGap } from "./timeline.ts";

/** IDLE: no statement because the issuer sends none for a month without activity (proven; counts as covered). */
export type MonthCell = "FULL" | "IDLE" | "PARTIAL" | "DERIVED" | "MISSING" | "INACTIVE";

export type AccountCoverage = {
  accountId: string;
  name: string;
  group: string;
  statementCount: number;
  firstDay: string;
  lastDay: string;
  closed: boolean;
  /** Typical days per statement (30 monthly, 91 quarterly). */
  cadenceDays: number;
  /** When the next statement should exist; null for closed accounts. */
  nextExpectedBy: string | null;
  overdue: boolean;
  gaps: CoverageGap[];
  chainBreaks: { at: string; priorClosingCents: number; openingCents: number }[];
  months: MonthCell[];
};

/** A card we know existed (the bank paid it) but have no statements for. */
export type UntrackedCardCoverage = {
  name: string;
  firstPayment: string;
  lastPayment: string;
  paymentCount: number;
  totalCents: number;
  /** Months with no statement on file, YYYY-MM. */
  missingMonths: string[];
  /** Same length as the report's months: MISSING inside the card's life, INACTIVE outside. */
  months: MonthCell[];
};

/** A payment the bank made to a card that has no statements of its own. */
export type UntrackedCardPayment = { date: string; amountCents: number };

/** Paystubs from one employer: months with at least one stub are FULL, gaps inside the job are MISSING. */
export type PaystubSourceCoverage = {
  employer: string;
  stubCount: number;
  firstPayDate: string;
  lastPayDate: string;
  /** Median days between pay dates (14 biweekly, 15/30 semi-monthly/monthly). */
  cadenceDays: number;
  /** Months inside the job's span with no stub, YYYY-MM. */
  missingMonths: string[];
  months: MonthCell[];
};

export function buildPaystubCoverage(employer: string, payDates: string[], months: string[]): PaystubSourceCoverage | null {
  if (payDates.length === 0) return null;
  const dates = [...payDates].sort();
  const first = dates[0]!;
  const last = dates.at(-1)!;
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d)).sort((x, y) => x - y);
  const have = new Set(dates.map((d) => d.slice(0, 7)));
  const cells = months.map<MonthCell>((m) => {
    if (have.has(m.slice(0, 7))) return "FULL";
    return m >= startOfMonth(first) && m <= last ? "MISSING" : "INACTIVE";
  });
  return {
    employer,
    stubCount: dates.length,
    firstPayDate: first,
    lastPayDate: last,
    cadenceDays: gaps[Math.floor(gaps.length / 2)] ?? 14,
    missingMonths: months.filter((_, i) => cells[i] === "MISSING").map((m) => m.slice(0, 7)),
    months: cells,
  };
}

export type CoverageReport = {
  months: string[];
  accounts: AccountCoverage[];
  untrackedCards: UntrackedCardCoverage[];
  paystubSources: PaystubSourceCoverage[];
  completeThrough: string | null;
};

/**
 * Coverage for a card we only know from the payments made to it. Its life runs from the
 * first payment's month to the month after the last payment (the closing statement);
 * every month in between is missing.
 */
export function buildUntrackedCardCoverage(
  name: string,
  payments: UntrackedCardPayment[],
  months: string[],
): UntrackedCardCoverage | null {
  if (payments.length === 0) return null;
  const dates = payments.map((p) => p.date).sort();
  const firstPayment = dates[0]!;
  const lastPayment = dates.at(-1)!;
  const lastMonth = startOfMonth(addDays(endOfMonth(lastPayment), 1));
  const cells = months.map<MonthCell>((m) => (m >= startOfMonth(firstPayment) && m <= lastMonth ? "MISSING" : "INACTIVE"));
  return {
    name,
    firstPayment,
    lastPayment,
    paymentCount: payments.length,
    totalCents: payments.reduce((n, p) => n - p.amountCents, 0),
    missingMonths: months.filter((_, i) => cells[i] === "MISSING").map((m) => m.slice(0, 7)),
    months: cells,
  };
}

/**
 * Statement coverage per account: which months are fully covered, which are derived
 * from a year-end summary, which are missing (so old gaps are easy to find and fill),
 * whether consecutive statements chain balance-to-balance, and whether a newer
 * statement is overdue.
 */
export function buildCoverageReport(
  ledger: Ledger,
  today: string,
  untrackedPayments: { name: string; payments: UntrackedCardPayment[] }[] = [],
  paystubs: { employer: string; payDates: string[] }[] = [],
): CoverageReport {
  const first = ledger.firstDay ?? today;
  const months = periodsBetween(startOfMonth(first), endOfMonth(today), "month").map((m) => m.start);
  const accounts = ledger.accounts.map<AccountCoverage>((a) => {
    const t = a.timeline;
    // Typical statement length, ignoring a short first statement (account opened mid-cycle).
    const real = t.segments.filter((s) => !s.derived && !s.idle);
    const lengths = (real.length > 1 ? real.slice(1) : real).map((s) => s.days).sort((x, y) => x - y);
    const cadence = Math.max(28, lengths[Math.floor(lengths.length / 2)] ?? 31);
    // Institutions publish a statement a week or two after it closes.
    const nextExpectedBy = a.closed ? null : addDays(t.lastDay!, cadence + 15);
    const cells = months.map<MonthCell>((m) => {
      const end = endOfMonth(m);
      if (end < t.firstDay! || (a.closed && m > t.lastDay!)) return "INACTIVE";
      const lo = m < t.firstDay! ? t.firstDay! : m;
      // A closed account stays at $0 after its last statement: nothing to cover there.
      const stop = a.closed && t.lastDay! < today ? t.lastDay! : today;
      const hi = end > stop ? stop : end;
      if (lo > hi) return "INACTIVE";
      const days = daysBetween(lo, hi) + 1;
      let covered = 0;
      let derived = 0;
      let idle = 0;
      for (const s of t.segments) {
        const sLo = new Date(s.start * 86_400_000).toISOString().slice(0, 10);
        const sHi = new Date(s.end * 86_400_000).toISOString().slice(0, 10);
        const x = sLo > lo ? sLo : lo;
        const y = sHi < hi ? sHi : hi;
        if (x > y) continue;
        const n = daysBetween(x, y) + 1;
        if (s.derived) derived += n;
        else if (s.idle) idle += n;
        else covered += n;
      }
      if (covered + idle >= days) return covered > 0 ? "FULL" : "IDLE";
      if (covered + idle + derived >= days) return "DERIVED";
      return covered > 0 || idle > 0 || derived > 0 ? "PARTIAL" : "MISSING";
    });
    return {
      accountId: a.id,
      name: a.name,
      group: a.group,
      statementCount: a.statementCount,
      firstDay: t.firstDay!,
      lastDay: t.lastDay!,
      closed: a.closed,
      cadenceDays: cadence,
      nextExpectedBy,
      overdue: nextExpectedBy != null && nextExpectedBy < today,
      gaps: coverageGaps(t),
      chainBreaks: chainBreaks(t),
      months: cells,
    };
  });
  const untrackedCards = untrackedPayments
    .map((c) => buildUntrackedCardCoverage(c.name, c.payments, months))
    .filter((c): c is UntrackedCardCoverage => c != null);
  const paystubSources = paystubs
    .map((p) => buildPaystubCoverage(p.employer, p.payDates, months))
    .filter((p): p is PaystubSourceCoverage => p != null);
  return { months, accounts, untrackedCards, paystubSources, completeThrough: ledger.completeThrough };
}
