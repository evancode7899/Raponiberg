import { inclusiveDays, maxIso, minIso, type Granularity } from "../../dates/isoDate.ts";
import { buildNetWorthReport as buildFromLedger, type NetWorthPeriod, type NetWorthReport as LedgerNetWorthReport } from "../../ledger/netWorthReport.ts";
import { chainReturns } from "../../ledger/timeline.ts";
import { netWorthAtBlockers, netWorthBlockers } from "../blockers.ts";
import type { Book } from "../load.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";

export type NetWorthPeriodWithBlockers = NetWorthPeriod & { blockers: BlockerRef[] };

type ChainedReturn = { from: string; total: number; annualized: number | null };

export type NetWorthReport = Omit<LedgerNetWorthReport, "periods" | "current"> & {
  /** Last day every open account has a statement for; nothing is reported past it. */
  provenThrough: string;
  periods: NetWorthPeriodWithBlockers[];
  current: LedgerNetWorthReport["current"] & { blockers: BlockerRef[] };
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

  return {
    ...r,
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
