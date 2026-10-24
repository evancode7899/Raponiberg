import { inclusiveDays, maxIso, minIso, type Granularity } from "../../dates/isoDate.ts";
import { buildNetWorthReport as buildFromLedger, type NetWorthPeriod, type NetWorthReport as LedgerNetWorthReport } from "../../ledger/netWorthReport.ts";
import { GROUP_ORDER } from "../../ledger/loadLedger.ts";
import { chainReturns } from "../../ledger/timeline.ts";
import { netWorthAtBlockers, netWorthBlockers } from "../blockers.ts";
import type { Book } from "../load.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";

export type NetWorthPeriodWithBlockers = NetWorthPeriod & { blockers: BlockerRef[] };

type ChainedReturn = { from: string; total: number; annualized: number | null };

/**
 * The totals every page shows from net worth, added up once here so Net worth and Home
 * (and their proofs) can't add them differently: assets and debts at the proven-through
 * date, each account group's subtotal, and where the trailing twelve months' change came from.
 */
export type NetWorthSummary = {
  /** Accounts holding money (balances above zero) at the proven-through date. */
  assetsCents: number;
  /** Accounts owing money (balances below zero), as a negative number. */
  debtsCents: number;
  /** Each account group's balance, in the household's group order. */
  groups: { group: string; cents: number; accountIds: string[] }[];
  /** The last twelve periods (months, on a monthly report): change and its sources; null with fewer than one period. */
  trailing12: {
    start: string;
    end: string;
    changeCents: number;
    /** Money saved and contributed, and balances first on file. */
    principalCents: number;
    /** Market growth net of fees. */
    growthCents: number;
    /** Transfers in transit at the edges (and anything unexplained, which the checks hold at zero). */
    otherCents: number;
    blockers: BlockerRef[];
  } | null;
};

export type NetWorthReport = Omit<LedgerNetWorthReport, "periods" | "current"> & {
  /** Last day every open account has a statement for; nothing is reported past it. */
  provenThrough: string;
  periods: NetWorthPeriodWithBlockers[];
  current: LedgerNetWorthReport["current"] & { blockers: BlockerRef[] };
  summary: NetWorthSummary;
  /**
   * Running figures over the most recent unbroken stretch of proven periods, so a gap in
   * old history withholds only the history, not everything after it. Each stretch runs
   * back from the latest period until the first period a relevant blocker touches.
   */
  proven: {
    /** Start of the stretch with no blockers at all: household roll-forwards accumulate from here. */
    from: string | null;
    returns: {
      /** Portfolio return over the stretch with no blockers on any investment account. */
      portfolio: ChainedReturn | null;
      /** Each account's return over its own stretch with no blockers on that account. */
      byAccount: (ChainedReturn & { accountId: string; /** Earlier periods for this account can't be proven. */ limited: boolean })[];
    };
  };
};

/** The trailing run of periods that pass `ok`. */
function trailingRun<T>(ps: T[], ok: (p: T) => boolean): T[] {
  let i = ps.length;
  while (i > 0 && ok(ps[i - 1]!)) i--;
  return ps.slice(i);
}

/** Where a group sits in the household's order (unknown groups last). */
const rank = (g: string) => {
  const i = (GROUP_ORDER as readonly string[]).indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

/** Household-wide blockers touch every account. */
const touches = (b: BlockerRef, ids: Set<string>) => !b.accountId || ids.has(b.accountId);

/**
 * Net worth over calendar periods from the Book, through the proven-through date, each
 * period listing what makes it unprovable (its opening or closing balance, or a flow in
 * between, depends on a missing or failing fact).
 */
export function buildNetWorth(book: Book, opts: { granularity: Granularity; from?: string; to?: string }): NetWorthReport {
  const through = book.horizon.netWorth;
  const r = buildFromLedger(book.ledger, { ...opts, today: book.today, through });
  const periods = r.periods.map((p) => ({ ...p, blockers: refs(netWorthBlockers(book, p.start, p.end)) }));

  const investmentIds = new Set(r.accounts.filter((a) => a.isInvestment).map((a) => a.id));
  const portfolioRun = trailingRun(periods, (p) => !p.blockers.some((b) => touches(b, investmentIds))).filter((p) => p.household.portfolioReturn != null);
  const byAccount = r.accounts.flatMap((a) => {
    if (!a.isInvestment) return [];
    const own = new Set([a.id]);
    const run = trailingRun(periods, (p) => !p.blockers.some((b) => touches(b, own)));
    const measured = run.map((p) => ({ p, ret: p.byAccount.find((x) => x.accountId === a.id)?.returnRatio ?? null })).filter((x) => x.ret != null);
    if (!measured.length) return [];
    // Only the days the account existed count toward annualizing its return.
    const lastActive = (end: string) => minIso(end, a.closed ? a.lastDay : end);
    const chained = chainReturns(measured.map(({ p, ret }) => ({ r: ret!, days: inclusiveDays(maxIso(p.start, a.firstDay), lastActive(p.end)) })));
    return [{ accountId: a.id, from: maxIso(run[0]!.start, a.firstDay), limited: run.length < periods.length, ...chained }];
  });

  const groups = new Map<string, { cents: number; accountIds: string[] }>();
  for (const a of r.accounts) {
    const g = groups.get(a.group) ?? { cents: 0, accountIds: [] };
    g.cents += a.currentCents;
    g.accountIds.push(a.id);
    groups.set(a.group, g);
  }
  const t12 = periods.slice(-12);
  const sum = (f: (h: NetWorthPeriod["household"]) => number) => t12.reduce((s, p) => s + f(p.household), 0);
  const summary: NetWorthSummary = {
    assetsCents: r.accounts.reduce((s, a) => s + Math.max(0, a.currentCents), 0),
    debtsCents: r.accounts.reduce((s, a) => s + Math.min(0, a.currentCents), 0),
    groups: [...groups].sort((a, b) => rank(a[0]) - rank(b[0])).map(([group, g]) => ({ group, ...g })),
    trailing12: t12.length
      ? {
          start: t12[0]!.start,
          end: t12.at(-1)!.end,
          changeCents: t12.at(-1)!.household.closingCents - t12[0]!.household.openingCents,
          principalCents: sum((h) => h.principalCents + h.newlyTrackedCents),
          growthCents: sum((h) => h.growthNetOfFeesCents),
          otherCents: sum((h) => h.transferResidualCents + h.unexplainedCents),
          blockers: refs(netWorthBlockers(book, t12[0]!.start, t12.at(-1)!.end)),
        }
      : null,
  };

  return {
    ...r,
    summary,
    provenThrough: through,
    periods,
    current: { ...r.current, blockers: refs(netWorthAtBlockers(book, through)) },
    proven: {
      from: trailingRun(periods, (p) => !p.blockers.length)[0]?.start ?? null,
      returns: {
        portfolio: portfolioRun.length
          ? { from: portfolioRun[0]!.start, ...chainReturns(portfolioRun.map((p) => ({ r: p.household.portfolioReturn!, days: inclusiveDays(p.start, p.end) }))) }
          : null,
        byAccount,
      },
    },
  };
}
