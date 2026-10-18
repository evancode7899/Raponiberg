import { addDays, daysBetween } from "../../dates/isoDate.ts";
import type { Goal, GoalSettings } from "../../goals/settings.ts";
import { GROUP_ORDER, type AccountGroup } from "../../ledger/loadLedger.ts";
import { valueAt } from "../../ledger/timeline.ts";
import { netWorthAtBlockers, netWorthBlockers } from "../blockers.ts";
import type { Book } from "../load.ts";
import type { Forecast } from "../../forecast/forecast.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";
import { buildCashFlowReport } from "./cashFlow.ts";

/**
 * Progress on each savings goal from the Book: the funding accounts' balances at the
 * proven-through date, claimed in the goals' priority order (an account's money goes to
 * the first set-aside goal that draws on it, up to that goal's share of the account,
 * until the goal is full, then the next; a tracking goal counts whole balances and claims
 * nothing — see goals/settings.ts), the pace
 * those accounts grew at over the last year, and what's needed to finish on time.
 *
 * When each goal is reached comes from the shared forecast (lib/forecast): the money it
 * adds to the kind of accounts a goal draws on — liquid (cash, brokerage), illiquid
 * (retirement and the rest) or both — fills the unfinished goals in priority order.
 * Without a forecast, the last year's pace stands in.
 */

/** The forecast's liquid and illiquid balances by month (cents), from the start. */
export type GoalForecast = { startKey: string; start: { liquid: number; illiquid: number }; months: { key: string; liquid: number; illiquid: number }[] };

/** The shared forecast as goals read it (what /api/goals passes buildGoals). */
export const goalForecastOf = (f: Pick<Forecast, "startKey" | "plan" | "months">): GoalForecast => ({
  startKey: f.startKey,
  start: f.plan.start,
  months: f.months.map(({ key, liquid, illiquid }) => ({ key, liquid, illiquid })),
});

/** Groups whose money the forecast counts as liquid. */
const LIQUID_GROUPS: AccountGroup[] = ["Cash", "Taxable investments"];

const MONTH_DAYS = 30.4375;

export type GoalProgress = {
  goal: Goal;
  /** Target in cents (an emergency fund's is months × typical monthly spending). */
  targetCents: number | null;
  /** Money counted toward this goal: claimed (SET_ASIDE) or the whole balances (TRACK). */
  currentCents: number;
  /** Balance of every funding account (before earmarking). */
  fundingCents: number;
  accounts: GoalAccount[];
  /** SET_ASIDE: earlier goals that claimed money from this goal's accounts first. */
  claimedFirstBy: string[];
  /** Change in the funding accounts' balances per month over the pace window (deposits and growth). */
  pace: { monthlyCents: number; from: string; to: string; blockers: BlockerRef[] } | null;
  /** Per month from now to reach the target by its date. */
  neededMonthlyCents: number | null;
  /** When the target is reached (null: not within the forecast, or not at this pace). */
  projectedDate: string | null;
  /** What `projectedDate` and the status come from: the shared forecast, or (without one) the last year's pace. */
  projectedFrom: "FORECAST" | "PACE";
  /** FORECAST: what the forecast's new money had to cover when this goal's turn came (its own need plus earlier goals' on the same kind of account), and from which kinds. */
  filled: FillTrace | null;
  status: "REACHED" | "ON_TRACK" | "BEHIND" | "IN_PROGRESS" | "NO_PACE" | "NO_TARGET";
  sharedWith: string[];
  blockers: BlockerRef[];
};

/** One funding account as a goal sees it: its balance, what earlier goals claimed, and what this goal counts. */
export type GoalAccount = {
  id: string;
  name: string;
  cents: number;
  /** The goal's share cap on this account (0–1), or null for all of it. */
  share: number | null;
  /** Claimed by earlier goals before this one (SET_ASIDE only; 0 for TRACK). */
  claimedBeforeCents: number;
  /** Counted toward this goal. */
  earmarkedCents: number;
};

/** Where each account's money goes: the goals that claimed it, in order, and what's left unclaimed. */
export type FundingRow = { id: string; name: string; group: AccountGroup; cents: number; claims: { goalId: string; name: string; cents: number }[]; freeCents: number; trackedBy: string[] };

export type GoalsReport = {
  asOf: string;
  /** Every account at least one goal draws on, with who claimed what. */
  funding: FundingRow[];
  /** Typical monthly spending for emergency funds: average of the last 12 proven months. */
  monthlySpending: { cents: number; months: number; from: string | null; to: string | null; periods: { start: string; end: string; cents: number }[] } | null;
  goals: GoalProgress[];
  accounts: { id: string; name: string; group: AccountGroup; cents: number }[];
  /** Account groups that can fund a goal, in display order. */
  groups: AccountGroup[];
};

export function buildGoals(book: Book, settings: GoalSettings, forecast: GoalForecast | null = null): GoalsReport {
  const asOf = book.horizon.netWorth;
  const open = book.ledger.accounts.filter((a) => !a.closed && a.group !== "Credit cards" && a.timeline.firstDay! <= asOf);
  const balance = new Map(open.map((a) => [a.id, valueAt(a.timeline, asOf).cents]));

  const cf = buildCashFlowReport(book, { granularity: "month" });
  const proven = cf.periods.filter((p) => !p.blockers.length && !p.through).slice(-12);
  const monthlySpending = proven.length
    ? {
        cents: Math.round(proven.reduce((s, p) => s + p.spendingCents, 0) / proven.length),
        months: proven.length,
        from: proven[0]!.start,
        to: proven.at(-1)!.end,
        periods: proven.map((p) => ({ start: p.start, end: p.end, cents: p.spendingCents })),
      }
    : null;

  const fundersOf = (g: Goal) => open.filter((a) => g.groups.includes(a.group) || g.accountIds.includes(a.id));
  const reach = forecast ? forecastFiller(forecast) : null;
  const claimer = goalClaimer(balance);
  const goals = settings.goals.map((goal): GoalProgress => {
    const funders = fundersOf(goal);
    const ids = funders.map((a) => a.id);
    const targetCents = goal.kind === "EMERGENCY_FUND" ? (monthlySpending ? Math.round(monthlySpending.cents * (goal.months ?? 6)) : null) : goal.targetCents;

    const track = goal.funding === "TRACK";
    const { accounts, claimedFirstBy } = claimer.claim(goal, funders, targetCents);
    const currentCents = accounts.reduce((s, a) => s + a.earmarkedCents, 0);
    const fundingCents = accounts.reduce((s, a) => s + a.cents, 0);

    // Pace over the last year, or since the newest funding account's first statement.
    let pace: GoalProgress["pace"] = null;
    if (funders.length) {
      // The last year, or since the oldest funding account's first statement. An account
      // whose statements start later counts from the balance its first statement opened
      // with, so money that existed before it was tracked isn't mistaken for saving.
      const from = [addDays(asOf, -365), funders.map((a) => a.timeline.firstDay!).sort()[0]!].sort().at(-1)!;
      const days = daysBetween(from, asOf);
      if (days >= 60) {
        const start = funders.reduce((s, a) => s + (a.timeline.firstDay! > from ? a.timeline.segments[0]!.opening : valueAt(a.timeline, from).cents), 0);
        pace = { monthlyCents: Math.round(((fundingCents - start) / days) * MONTH_DAYS), from, to: asOf, blockers: refs(netWorthBlockers(book, addDays(from, 1), asOf, ids)) };
      }
    }

    const remaining = targetCents == null ? null : Math.max(0, targetCents - currentCents);
    const monthsLeft = goal.targetDate ? Math.max(0, daysBetween(asOf, goal.targetDate) / MONTH_DAYS) : null;
    const neededMonthlyCents = remaining == null || monthsLeft == null ? null : monthsLeft < 1 ? remaining : Math.ceil(remaining / monthsLeft);
    let projectedDate: string | null;
    let filled: FillTrace | null = null;
    if (remaining === 0) projectedDate = asOf;
    else if (reach && remaining != null && funders.length) {
      const key = reach(remaining, funders.some((a) => LIQUID_GROUPS.includes(a.group)), funders.some((a) => !LIQUID_GROUPS.includes(a.group)), track, (t) => (filled = t));
      projectedDate = key ? endOfMonthIso(key) : null;
    } else projectedDate = remaining != null && pace && pace.monthlyCents > 0 ? addDays(asOf, Math.ceil((remaining / pace.monthlyCents) * MONTH_DAYS)) : null;
    const status: GoalProgress["status"] =
      targetCents == null
        ? "NO_TARGET"
        : remaining === 0
          ? "REACHED"
          : forecast
            ? !projectedDate
              ? "NO_PACE"
              : !goal.targetDate
                ? "IN_PROGRESS"
                : projectedDate <= goal.targetDate
                  ? "ON_TRACK"
                  : "BEHIND"
              : !pace || pace.monthlyCents <= 0
                ? "NO_PACE"
                : !goal.targetDate
                  ? "IN_PROGRESS"
                  : projectedDate && projectedDate <= goal.targetDate
                    ? "ON_TRACK"
                    : "BEHIND";

    return {
      goal,
      targetCents,
      currentCents,
      fundingCents,
      accounts,
      claimedFirstBy,
      pace,
      neededMonthlyCents,
      projectedDate,
      projectedFrom: forecast ? "FORECAST" : "PACE",
      filled,
      status,
      sharedWith: settings.goals.filter((o) => o.id !== goal.id && fundersOf(o).some((a) => ids.includes(a.id))).map((o) => o.name),
      blockers: refs(netWorthAtBlockers(book, asOf, ids)),
    };
  });

  const used = open.filter((a) => settings.goals.some((g) => fundersOf(g).includes(a)));
  const funding = claimer.rows(used);

  return {
    asOf,
    funding,
    monthlySpending,
    goals,
    accounts: open.map((a) => ({ id: a.id, name: a.name, group: a.group, cents: balance.get(a.id) ?? 0 })),
    groups: GROUP_ORDER.filter((g) => g !== "Credit cards" && open.some((a) => a.group === g)),
  };
}

/**
 * Goals claiming account money in priority order (call `claim` once per goal, in order).
 * A SET_ASIDE goal takes from each funding account's unclaimed money, up to its share of
 * the balance, until its target is met; a TRACK goal counts the balances and claims
 * nothing. `rows` then says, per account, who claimed what and what's left.
 */
export function goalClaimer(balance: Map<string, number>) {
  const pool = new Map(balance);
  const claims = new Map<string, FundingRow["claims"]>();
  const tracked = new Map<string, string[]>();
  return {
    claim(goal: Goal, funders: { id: string; name: string }[], targetCents: number | null): { accounts: GoalAccount[]; claimedFirstBy: string[] } {
      const track = goal.funding === "TRACK";
      let need = targetCents ?? Infinity;
      const claimedFirst = new Set<string>();
      const accounts = funders.map((a): GoalAccount => {
        const cents = balance.get(a.id) ?? 0;
        const left = pool.get(a.id) ?? 0;
        const share = track ? null : (goal.shares[a.id] ?? null);
        const cap = share == null ? Infinity : Math.round(Math.max(0, cents) * share);
        const take = Math.max(0, Math.min(track ? cents : left, cap, need));
        need -= take;
        if (track) {
          tracked.set(a.id, [...(tracked.get(a.id) ?? []), goal.name]);
          return { id: a.id, name: a.name, cents, share, claimedBeforeCents: 0, earmarkedCents: take };
        }
        pool.set(a.id, left - take);
        for (const c of claims.get(a.id) ?? []) claimedFirst.add(c.name);
        if (take > 0) claims.set(a.id, [...(claims.get(a.id) ?? []), { goalId: goal.id, name: goal.name, cents: take }]);
        return { id: a.id, name: a.name, cents, share, claimedBeforeCents: Math.max(0, cents - left), earmarkedCents: take };
      });
      return { accounts, claimedFirstBy: [...claimedFirst] };
    },
    rows(accounts: { id: string; name: string; group: AccountGroup }[]): FundingRow[] {
      return accounts.map((a) => {
        const cents = balance.get(a.id) ?? 0;
        const c = claims.get(a.id) ?? [];
        return { id: a.id, name: a.name, group: a.group, cents, claims: c, freeCents: Math.max(0, cents - c.reduce((s, x) => s + x.cents, 0)), trackedBy: tracked.get(a.id) ?? [] };
      });
    },
  };
}

/** Last day of month `key` (YYYY-MM). */
const endOfMonthIso = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

/**
 * New money from the forecast filling unfinished goals in priority order: call it once per
 * goal, in order, with what's still needed and which kinds of account fund it; it returns
 * the month (YYYY-MM) the goal is reached, or null. A goal on one kind of account waits
 * behind earlier goals on the same kind; a goal on both kinds waits behind all of them.
 * A tracking goal (a milestone) waits behind nobody and holds nobody up: it's reached when
 * the new money alone covers what it still needs.
 */
export function forecastFiller(f: GoalForecast): (remaining: number, liquid: boolean, illiquid: boolean, track?: boolean, trace?: (t: FillTrace) => void) => string | null {
  const filled = { liquid: 0, illiquid: 0 };
  const added = (m: GoalForecast["months"][number], s: "liquid" | "illiquid") => m[s] - f.start[s];
  return (remaining, liquid, illiquid, track = false, trace) => {
    const sides: FillTrace["sides"] = [...(liquid ? (["liquid"] as const) : []), ...(illiquid ? (["illiquid"] as const) : [])];
    const fill = (need: number, over: FillTrace["sides"]) => {
      trace?.({ need, own: remaining, sides: over });
      return f.months.find((m) => over.reduce((t, s) => t + added(m, s), 0) >= need)?.key ?? null;
    };
    if (track) return fill(remaining, sides);
    if (liquid && illiquid) {
      const need = filled.liquid + filled.illiquid + remaining;
      filled.liquid += remaining;
      return fill(need, sides);
    }
    const s = liquid ? "liquid" : "illiquid";
    filled[s] += remaining;
    return fill(filled[s], [s]);
  };
}

/** What a goal's turn asked of the forecast: `need` (its own `own` plus earlier goals' on the same kinds) from the money added to `sides` since the start. */
export type FillTrace = { need: number; own: number; sides: ("liquid" | "illiquid")[] };
