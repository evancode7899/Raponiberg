import type { Lane } from "../classifier/taxonomy.ts";
import {
  addDays,
  endOfPeriod,
  inclusiveDays,
  maxIso,
  minIso,
  periodLabel,
  periodsBetween,
  startOfPeriod,
  type Granularity,
} from "../dates/isoDate.ts";
import { GROUP_ORDER, type AccountGroup, type Ledger } from "./loadLedger.ts";
import { chainReturns, decompose, dietzParts, MIN_RETURN_CAPITAL_CENTS, valueAt, worstQuality, type Quality } from "./timeline.ts";

export type AccountPeriod = {
  accountId: string;
  openingCents: number;
  /**
   * Balance an account already had when its first statement on file begins (e.g. a
   * 401(k) whose earliest statement is mid-history). It enters the books here rather
   * than being guessed backwards, so period openings always equal prior closings.
   */
  newlyTrackedCents: number;
  /** Everything that moved money in/out of the account, internal transfers included. */
  contributionsCents: number;
  growthNetOfFeesCents: number;
  feesCents: number;
  unexplainedCents: number;
  closingCents: number;
  quality: Quality;
  /** Modified Dietz return for investment accounts. */
  returnRatio: number | null;
};

export type HouseholdPeriod = {
  openingCents: number;
  closingCents: number;
  /** Pre-existing balances of accounts whose statements begin this period. */
  newlyTrackedCents: number;
  /**
   * Net principal: money that entered or left the household's tracked books.
   * = income + spending + external transfers + payroll/employer retirement money.
   */
  principalCents: number;
  incomeCents: number;
  spendingCents: number;
  externalCents: number;
  retirementEmployeeCents: number;
  retirementEmployerCents: number;
  /**
   * Σ of transfers between tracked accounts. Zero when both legs are on file; nonzero
   * means money in transit across a period boundary or a leg not yet on file.
   */
  transferResidualCents: number;
  growthNetOfFeesCents: number;
  feesCents: number;
  unexplainedCents: number;
  quality: Quality;
  /** Investment portfolio Modified Dietz return (all market-valued accounts). */
  portfolioReturn: number | null;
};

export type NetWorthPeriod = {
  label: string;
  start: string;
  end: string;
  /** Set when the period is cut short at the `through` date. */
  through: string | null;
  household: HouseholdPeriod;
  byAccount: AccountPeriod[];
  byGroup: { group: AccountGroup; closingCents: number }[];
};

export type NetWorthReport = {
  granularity: Granularity;
  from: string;
  to: string;
  mergeDate: string;
  completeThrough: string | null;
  latestDay: string | null;
  accounts: {
    id: string;
    name: string;
    institution: string | null;
    group: AccountGroup;
    subtype: string | null;
    isInvestment: boolean;
    closed: boolean;
    firstDay: string;
    lastDay: string;
    currentCents: number;
    currentQuality: Quality;
    currentAsOf: string | null;
  }[];
  periods: NetWorthPeriod[];
  returns: {
    portfolio: { total: number; annualized: number | null } | null;
    byAccount: { accountId: string; total: number; annualized: number | null }[];
  };
  current: { asOf: string; totalCents: number; quality: Quality };
};

const lane = (f: Partial<Record<Lane, number>>, l: Lane) => f[l] ?? 0;

/**
 * Net worth over calendar periods, decomposed per account and for the household into
 * opening + net principal + growth (net of fees) = closing, with every estimate,
 * interpolation or stale value carried through as a quality flag.
 */
export function buildNetWorthReport(
  ledger: Ledger,
  opts: { granularity: Granularity; from?: string; to?: string; today?: string; through?: string },
): NetWorthReport {
  const g = opts.granularity;
  const latestDay = opts.through ?? (ledger.accounts.length ? ledger.accounts.map((a) => a.timeline.lastDay!).sort().at(-1)! : null);
  const from = startOfPeriod(opts.from ?? ledger.firstDay ?? opts.today ?? "2020-01-01", g);
  const wanted = endOfPeriod(opts.to ?? latestDay ?? from, g);
  // Nothing past `through`: the period containing it ends there.
  const to = opts.through && wanted > opts.through ? opts.through : wanted;
  const periods: NetWorthPeriod[] = [];
  const accountReturns = new Map<string, { r: number; days: number }[]>();
  const portfolioReturns: { r: number; days: number }[] = [];

  for (const { start, end: rawEnd } of from <= to ? periodsBetween(from, to, g) : []) {
    const end = rawEnd > to ? to : rawEnd;
    const byAccount: AccountPeriod[] = [];
    const h: HouseholdPeriod = {
      openingCents: 0,
      closingCents: 0,
      newlyTrackedCents: 0,
      principalCents: 0,
      incomeCents: 0,
      spendingCents: 0,
      externalCents: 0,
      retirementEmployeeCents: 0,
      retirementEmployerCents: 0,
      transferResidualCents: 0,
      growthNetOfFeesCents: 0,
      feesCents: 0,
      unexplainedCents: 0,
      quality: "EXACT",
      portfolioReturn: null,
    };
    const qualities: Quality[] = [];
    const groupTotals = new Map<AccountGroup, number>();
    let pGain = 0;
    let pCapital = 0;
    for (const a of ledger.accounts) {
      const t = a.timeline;
      if (t.firstDay! > end) continue;
      const d = decompose(t, start, end);
      // Lanes can net to zero (a card's purchase and its payoff) yet each still counts toward the household's lanes.
      const anyFlow = Object.values(d.flowsByLane).some((v) => v !== 0);
      if (d.openingCents === 0 && d.closingCents === 0 && !anyFlow && d.growthCents === 0 && d.feesCents === 0) continue;
      // An account first on file this period enters with whatever it already held.
      const entering = t.firstDay! >= start && t.firstDay! <= end;
      const newlyTracked = entering ? d.openingCents : 0;
      if (entering) {
        d.openingCents = 0;
        if (d.quality === "UNKNOWN") d.quality = "EXACT";
      }
      let ret: number | null = null;
      if (a.isInvestment) {
        const parts = dietzParts(t, start, end);
        pGain += parts.gainCents;
        pCapital += parts.capitalCents;
        ret = parts.capitalCents >= MIN_RETURN_CAPITAL_CENTS ? parts.gainCents / parts.capitalCents : null;
        if (ret != null) {
          // Only the days the account existed count toward annualizing its return.
          const activeDays = inclusiveDays(maxIso(start, t.firstDay!), minIso(end, a.closed ? t.lastDay! : end));
          accountReturns.set(a.id, [...(accountReturns.get(a.id) ?? []), { r: ret, days: activeDays }]);
        }
      }
      byAccount.push({
        accountId: a.id,
        openingCents: d.openingCents,
        newlyTrackedCents: newlyTracked,
        contributionsCents: d.contributionsCents,
        growthNetOfFeesCents: d.growthCents + d.feesCents,
        feesCents: d.feesCents,
        unexplainedCents: d.unexplainedCents,
        closingCents: d.closingCents,
        quality: d.quality,
        returnRatio: ret,
      });
      qualities.push(d.quality);
      groupTotals.set(a.group, (groupTotals.get(a.group) ?? 0) + d.closingCents);
      h.openingCents += d.openingCents;
      h.closingCents += d.closingCents;
      h.newlyTrackedCents += newlyTracked;
      h.incomeCents += lane(d.flowsByLane, "INCOME");
      h.spendingCents += lane(d.flowsByLane, "EXPENSE");
      h.externalCents += lane(d.flowsByLane, "EXTERNAL_TRANSFER");
      h.retirementEmployeeCents += lane(d.flowsByLane, "CONTRIBUTION_EMPLOYEE") + lane(d.flowsByLane, "CONTRIBUTION_PERSONAL");
      h.retirementEmployerCents += lane(d.flowsByLane, "CONTRIBUTION_EMPLOYER");
      h.transferResidualCents += lane(d.flowsByLane, "TRANSFER");
      h.growthNetOfFeesCents += d.growthCents + d.feesCents;
      h.feesCents += d.feesCents;
      h.unexplainedCents += d.unexplainedCents;
    }
    h.principalCents = h.incomeCents + h.spendingCents + h.externalCents + h.retirementEmployeeCents + h.retirementEmployerCents;
    h.quality = worstQuality(qualities);
    if (pCapital >= MIN_RETURN_CAPITAL_CENTS) {
      h.portfolioReturn = pGain / pCapital;
      portfolioReturns.push({ r: h.portfolioReturn, days: inclusiveDays(start, end) });
    }
    periods.push({
      label: periodLabel(start, g),
      start,
      end,
      through: end < rawEnd ? end : null,
      household: h,
      byAccount,
      byGroup: GROUP_ORDER.filter((gr) => groupTotals.has(gr)).map((gr) => ({ group: gr, closingCents: groupTotals.get(gr)! })),
    });
  }

  const asOf = latestDay ?? opts.today ?? to;
  const currentByAccount = ledger.accounts.map((a) => ({ a, v: valueAt(a.timeline, asOf) }));
  return {
    granularity: g,
    from,
    to,
    mergeDate: ledger.mergeDate,
    completeThrough: ledger.completeThrough,
    latestDay,
    accounts: currentByAccount.map(({ a, v }) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      group: a.group,
      subtype: a.subtype,
      isInvestment: a.isInvestment,
      closed: a.closed,
      firstDay: a.timeline.firstDay!,
      lastDay: a.timeline.lastDay!,
      currentCents: v.cents,
      currentQuality: v.quality,
      currentAsOf: v.asOf,
    })),
    periods,
    returns: {
      portfolio: portfolioReturns.length ? chainReturns(portfolioReturns) : null,
      byAccount: [...accountReturns].map(([accountId, rs]) => ({ accountId, ...chainReturns(rs) })),
    },
    current: {
      asOf,
      totalCents: currentByAccount.reduce((s, x) => s + x.v.cents, 0),
      quality: worstQuality(currentByAccount.map((x) => x.v.quality)),
    },
  };
}

/** Value of every account at each day (for a smooth chart), with quality. */
export function dailySeries(ledger: Ledger, from: string, to: string, stepDays: number) {
  const out: { date: string; totalCents: number; byGroup: Partial<Record<AccountGroup, number>>; quality: Quality }[] = [];
  for (let d = from; d <= to; d = addDays(d, stepDays)) {
    const byGroup: Partial<Record<AccountGroup, number>> = {};
    const qs: Quality[] = [];
    let total = 0;
    for (const a of ledger.accounts) {
      if (a.timeline.firstDay! > d) continue;
      const v = valueAt(a.timeline, d);
      byGroup[a.group] = (byGroup[a.group] ?? 0) + v.cents;
      total += v.cents;
      qs.push(v.quality);
    }
    out.push({ date: d, totalCents: total, byGroup, quality: worstQuality(qs) });
  }
  return out;
}
