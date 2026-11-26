import type { GoalsReport } from "../book/reports/goals.ts";
import { SPENDABLE_GROUPS } from "../book/definitions.ts";
import { forecastFiller, type GoalForecast } from "../goals/fill.ts";

/**
 * Each goal as a scenario sees it: what it still needs and which kinds of account fund it,
 * read once from the Goals report (book/reports/goals.ts) on the server; each scenario then
 * fills the goals in the same order with its own path (goals/fill.ts, the Goals page's rule).
 */
export type GoalReach = {
  id: string;
  name: string;
  /** Still needed (cents); null without a target. */
  remaining: number | null;
  liquid: boolean;
  illiquid: boolean;
  track: boolean;
  /** Some account funds it. */
  funded: boolean;
  /** The owner's target date (YYYY-MM-DD) or null. */
  targetDate: string | null;
};

export function goalReachOf(report: Pick<GoalsReport, "goals" | "accounts">): GoalReach[] {
  const group = new Map(report.accounts.map((a) => [a.id, a.group]));
  return report.goals.map((g) => {
    const groups = g.accounts.map((a) => group.get(a.id)).filter((x) => x != null);
    return {
      id: g.goal.id,
      name: g.goal.name,
      remaining: g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents),
      liquid: groups.some((x) => SPENDABLE_GROUPS.includes(x)),
      illiquid: groups.some((x) => !SPENDABLE_GROUPS.includes(x)),
      track: g.goal.funding === "TRACK",
      funded: g.accounts.length > 0,
      targetDate: g.goal.targetDate,
    };
  });
}

/** The month (YYYY-MM) each goal is reached on a path: "now" when already reached, null when not within it (or no target). */
export function goalMonths(goals: readonly GoalReach[], path: GoalForecast): (string | "now" | null)[] {
  const reach = forecastFiller(path);
  return goals.map((g) => {
    if (g.remaining === 0) return "now";
    if (g.remaining == null || !g.funded) return null;
    return reach(g.remaining, g.liquid, g.illiquid, g.track);
  });
}
