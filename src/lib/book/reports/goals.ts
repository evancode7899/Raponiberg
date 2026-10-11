import { addDays, daysBetween } from "../../dates/isoDate.ts";
import type { Goal, GoalSettings } from "../../goals/settings.ts";
import { GROUP_ORDER, type AccountGroup } from "../../ledger/loadLedger.ts";
import { valueAt } from "../../ledger/timeline.ts";
import { netWorthAtBlockers, netWorthBlockers } from "../blockers.ts";
import type { Book } from "../load.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";
import { buildCashFlowReport } from "./cashFlow.ts";

/**
 * Progress on each savings goal from the Book: the funding accounts' balances at the
 * proven-through date, earmarked in the goals' priority order (an account's money goes
 * to the first goal that draws on it until that goal is full, then the next), the pace
 * those accounts grew at over the last year, and what's needed to finish on time.
 *
 * When each goal is reached comes from the shared forecast (lib/forecast): the money it
 * adds to the kind of accounts a goal draws on — liquid (cash, brokerage), illiquid
 * (retirement and the rest) or both — fills the unfinished goals in priority order.
 * Without a forecast, the last year's pace stands in.
 */

/** The forecast's liquid and illiquid balances by month (cents), from the start. */
export type GoalForecast = { startKey: string; start: { liquid: number; illiquid: number }; months: { key: string; liquid: number; illiquid: number }[] };

/** Groups whose money the forecast counts as liquid. */
const LIQUID_GROUPS: AccountGroup[] = ["Cash", "Taxable investments"];

const MONTH_DAYS = 30.4375;

export type GoalProgress = {
  goal: Goal;
  /** Target in cents (an emergency fund's is months × typical monthly spending). */
  targetCents: number | null;
  /** Money earmarked for this goal. */
  currentCents: number;
  /** Balance of every funding account (before earmarking). */
  fundingCents: number;
  accounts: { id: string; name: string; cents: number; earmarkedCents: number }[];
  /** Change in the funding accounts' balances per month over the pace window (deposits and growth). */
  pace: { monthlyCents: number; from: string; to: string; blockers: BlockerRef[] } | null;
  /** Per month from now to reach the target by its date. */
  neededMonthlyCents: number | null;
  /** When the target is reached (null: not within the forecast, or not at this pace). */
  projectedDate: string | null;
  /** What `projectedDate` and the status come from: the shared forecast, or (without one) the last year's pace. */
  projectedFrom: "FORECAST" | "PACE";
  status: "REACHED" | "ON_TRACK" | "BEHIND" | "IN_PROGRESS" | "NO_PACE" | "NO_TARGET";
  sharedWith: string[];
  blockers: BlockerRef[];
};

export type GoalsReport = {
  asOf: string;
  /** Typical monthly spending for emergency funds: average of the last 12 proven months. */
  monthlySpending: { cents: number; months: number; from: string | null; to: string | null } | null;
  goals: GoalProgress[];
  accounts: { id: string; name: string; group: AccountGroup; cents: number }[];
  /** Account groups that can fund a goal, in display order. */
  groups: AccountGroup[];
};

export function buildGoals(book: Book, settings: GoalSettings, forecast: GoalForecast | null = null): GoalsReport {
  const asOf = book.horizon.netWorth;
  const open = book.ledger.accounts.filter((a) => !a.closed && a.group !== "Credit cards" && a.timeline.firstDay! <= asOf);
  const balance = new Map(open.map((a) => [a.id, valueAt(a.timeline, asOf).cents]));
  const pool = new Map(balance);

  const cf = buildCashFlowReport(book, { granularity: "month" });
  const proven = cf.periods.filter((p) => !p.blockers.length && !p.through).slice(-12);
  const monthlySpending = proven.length
    ? { cents: Math.round(proven.reduce((s, p) => s + p.spendingCents, 0) / proven.length), months: proven.length, from: proven[0]!.start, to: proven.at(-1)!.end }
    : null;

  const fundersOf = (g: Goal) => open.filter((a) => g.groups.includes(a.group) || g.accountIds.includes(a.id));
  const reach = forecast ? forecastFiller(forecast) : null;
  const goals = settings.goals.map((goal): GoalProgress => {
    const funders = fundersOf(goal);
    const ids = funders.map((a) => a.id);
    const targetCents = goal.kind === "EMERGENCY_FUND" ? (monthlySpending ? Math.round(monthlySpending.cents * (goal.months ?? 6)) : null) : goal.targetCents;

    // Earmark: take from each funding account's remaining pool until the target is met.
    let need = targetCents ?? Infinity;
    const accounts = funders.map((a) => {
      const take = Math.max(0, Math.min(pool.get(a.id) ?? 0, need));
      pool.set(a.id, (pool.get(a.id) ?? 0) - take);
      need -= take;
      return { id: a.id, name: a.name, cents: balance.get(a.id) ?? 0, earmarkedCents: take };
    });
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
    if (remaining === 0) projectedDate = asOf;
    else if (reach && remaining != null && funders.length) {
      const key = reach(remaining, funders.some((a) => LIQUID_GROUPS.includes(a.group)), funders.some((a) => !LIQUID_GROUPS.includes(a.group)));
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
      pace,
      neededMonthlyCents,
      projectedDate,
      projectedFrom: forecast ? "FORECAST" : "PACE",
      status,
      sharedWith: settings.goals.filter((o) => o.id !== goal.id && fundersOf(o).some((a) => ids.includes(a.id))).map((o) => o.name),
      blockers: refs(netWorthAtBlockers(book, asOf, ids)),
    };
  });

  return {
    asOf,
    monthlySpending,
    goals,
    accounts: open.map((a) => ({ id: a.id, name: a.name, group: a.group, cents: balance.get(a.id) ?? 0 })),
    groups: GROUP_ORDER.filter((g) => g !== "Credit cards" && open.some((a) => a.group === g)),
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
 */
export function forecastFiller(f: GoalForecast): (remaining: number, liquid: boolean, illiquid: boolean) => string | null {
  const filled = { liquid: 0, illiquid: 0 };
  const added = (m: GoalForecast["months"][number], s: "liquid" | "illiquid") => m[s] - f.start[s];
  return (remaining, liquid, illiquid) => {
    if (liquid && illiquid) {
      const need = filled.liquid + filled.illiquid + remaining;
      filled.liquid += remaining;
      return f.months.find((m) => added(m, "liquid") + added(m, "illiquid") >= need)?.key ?? null;
    }
    const s = liquid ? "liquid" : "illiquid";
    filled[s] += remaining;
    return f.months.find((m) => added(m, s) >= filled[s])?.key ?? null;
  };
}
