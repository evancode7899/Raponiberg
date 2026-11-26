import { projectOutlook, type OutlookPlan } from "../profile/outlook.ts";
import { fiYear } from "./fire.ts";

/**
 * FIRE's saved scenarios ("one more year", "buy the house"): a few changes to the plan as set,
 * kept by name and shown side by side with the plan. Each is kept as an owner's mark
 * (lib/markStore.ts, data/fire-scenarios.json): its id the name's slug, `says` the changes as
 * JSON. A calculator: nothing here is a proven figure.
 */
export type FireScenario = {
  id: string;
  name: string;
  /** Years more of work (negative: sooner). */
  workYears: number;
  /** Living cost a year more (negative: less), in today's cents. */
  livingDelta: number;
  /** A one-off cost (a down payment), its year and cents. */
  oneOff: { year: number; amount: number } | null;
};

export const scenarioId = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** A scenario from its kept mark; null when the mark doesn't hold one. */
export function scenarioOf(m: { id: string; says: string }): FireScenario | null {
  try {
    const x = JSON.parse(m.says) as Partial<FireScenario>;
    if (typeof x.name !== "string" || !x.name.trim()) return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
    const oneOff = x.oneOff && typeof x.oneOff === "object" && num(x.oneOff.amount) > 0 && num(x.oneOff.year) > 1900 ? { year: num(x.oneOff.year), amount: num(x.oneOff.amount) } : null;
    return { id: m.id, name: x.name.trim().slice(0, 60), workYears: Math.max(-20, Math.min(20, num(x.workYears))), livingDelta: num(x.livingDelta), oneOff };
  } catch {
    return null;
  }
}

/** What a scenario's mark says. */
export const scenarioSays = (s: Omit<FireScenario, "id">) => JSON.stringify({ name: s.name, workYears: s.workYears, livingDelta: s.livingDelta, oneOff: s.oneOff });

/** The plan with a scenario's changes. */
export function applyScenario(plan: OutlookPlan, s: FireScenario): OutlookPlan {
  return {
    ...plan,
    walkAwayYear: plan.walkAwayYear == null ? null : plan.walkAwayYear + s.workYears,
    livingCost: Math.max(0, plan.livingCost + s.livingDelta),
    plannedExpenses: s.oneOff ? [...plan.plannedExpenses, { id: `scenario:${s.id}`, year: s.oneOff.year, label: s.name, amount: s.oneOff.amount }] : plan.plannedExpenses,
  };
}

/** What a plan comes to, for the side-by-side table. */
export type ScenarioOutcome = { fiYear: number | null; walkAwayYear: number | null; netWorthAtWalkAway: number | null; firstCoverage: number | null; endNetWorth: number };

export function scenarioOutcome(plan: OutlookPlan): ScenarioOutcome {
  const ys = projectOutlook(plan).years;
  const w = plan.walkAwayYear;
  const first = ys.find((y) => !y.working);
  return {
    fiYear: fiYear(plan),
    walkAwayYear: w,
    netWorthAtWalkAway: w == null ? null : (ys.find((y) => y.year === w)?.startNetWorth ?? null),
    firstCoverage: first?.coverage ?? null,
    endNetWorth: ys.at(-1)?.netWorth ?? 0,
  };
}
