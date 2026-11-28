import { projectOutlook, type OutlookPlan } from "../profile/outlook.ts";
import { emptyScenario, type Scenario } from "../scenarios/types.ts";
import { fiYear } from "./fire.ts";

/**
 * FIRE's scenarios side by side: the very scenarios the Scenarios page keeps
 * (data/scenarios.json, lib/scenarios), one concept for both pages. FIRE runs each on its own
 * long-term plan with the parts that plan models: years more of work (the walk-away year), the
 * living cost (set, or changed by an amount), the one-offs (in their year), and the return and
 * inflation assumptions. A scenario's pay, children and housing changes run on the Scenarios
 * page's month-by-month engine only; FIRE names them as not modeled here. A calculator:
 * nothing here is a proven figure.
 */

export const scenarioId = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** The plan with a scenario's changes. */
export function applyScenario(plan: OutlookPlan, s: Scenario): OutlookPlan {
  const living = Math.max(0, (s.spending.living ?? plan.livingCost) + (s.spending.livingChange ?? 0));
  return {
    ...plan,
    walkAwayYear: plan.walkAwayYear == null ? null : plan.walkAwayYear + s.retire.workYears,
    livingCost: living,
    ...(s.spending.growth != null ? { livingGrowth: s.spending.growth } : {}),
    ...(s.assumptions.returnRate != null ? { returnRate: s.assumptions.returnRate } : {}),
    ...(s.assumptions.inflation != null ? { inflation: s.assumptions.inflation } : {}),
    plannedExpenses: [...plan.plannedExpenses, ...s.spending.oneOffs.map((o) => ({ id: `scenario:${s.id}:${o.id}`, year: Number(o.at.slice(0, 4)), label: o.label || s.name, amount: o.amount }))],
  };
}

/** What a scenario changes that FIRE's plan doesn't model (the Scenarios page does), in words; empty when FIRE runs all of it. */
export function notOnFire(s: Scenario): string[] {
  return [
    ...(s.people.length ? ["pay"] : []),
    ...(s.children.added.length || s.children.ageOut ? ["children"] : []),
    ...(s.housing.buy || s.housing.rentGrowth != null ? ["housing"] : []),
  ];
}

/** A scenario FIRE's own form keeps: years more of work, a change in living cost a year, a one-off in a year. */
export function fireScenario(name: string, x: { workYears: number; livingDelta: number; oneOff: { year: number; amount: number } | null }): Scenario {
  const s = emptyScenario(scenarioId(name) || "scenario", name.trim().slice(0, 60));
  return {
    ...s,
    retire: { workYears: Math.max(-20, Math.min(20, Math.round(x.workYears) || 0)) },
    spending: { ...s.spending, livingChange: Math.round(x.livingDelta) || null, oneOffs: x.oneOff && x.oneOff.amount > 0 ? [{ id: "one-off", label: name.trim().slice(0, 60), amount: Math.round(x.oneOff.amount), at: `${x.oneOff.year}-01` }] : [] },
  };
}

/** One of FIRE's old saved scenarios (data/fire-scenarios.json, before the two were one), as a scenario; null when the mark holds none. */
export function fromFireMark(m: { id: string; says: string }): Scenario | null {
  try {
    const x = JSON.parse(m.says) as { name?: unknown; workYears?: unknown; livingDelta?: unknown; oneOff?: { year?: unknown; amount?: unknown } | null };
    if (typeof x.name !== "string" || !x.name.trim()) return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
    const oneOff = x.oneOff && num(x.oneOff.amount) > 0 && num(x.oneOff.year) > 1900 ? { year: num(x.oneOff.year), amount: num(x.oneOff.amount) } : null;
    return fireScenario(x.name, { workYears: num(x.workYears), livingDelta: num(x.livingDelta), oneOff });
  } catch {
    return null;
  }
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
