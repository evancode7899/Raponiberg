import { describe, expect, it } from "vitest";
import type { OutlookPlan } from "../profile/outlook";
import { applyScenario, scenarioId, scenarioOf, scenarioOutcome, scenarioSays } from "./scenarios";

// An invented plan.
const plan = {
  start: { year: 2027, month: 12, liquid: 400_000_00, illiquid: 300_000_00 },
  horizonYear: 2060,
  nearTermThrough: 2027,
  salary: 250_000_00,
  bonus: null,
  employerMatch: 10_000_00,
  deferrals: 30_000_00,
  livingCost: 100_000_00,
  takeHomeRate: 0.65,
  salaryGrowth: 0.03,
  livingGrowth: 0.025,
  returnRate: 0.06,
  walkAwayYear: 2040,
  withdrawalRate: 0.035,
  stateTaxRate: 0.05,
  inflation: 0.025,
  plannedExpenses: [],
  tax: { year: 2026, standardDeduction: 32_200_00, brackets: [24_800_00, 100_800_00, 211_400_00, 403_550_00, 512_450_00, 768_700_00] },
  birthYear: 1990,
} as unknown as OutlookPlan;

describe("FIRE scenarios", () => {
  it("round-trips through its kept mark, and refuses one without a name", () => {
    const s = { name: "Buy the house", workYears: 1, livingDelta: 12_000_00, oneOff: { year: 2029, amount: 150_000_00 } };
    expect(scenarioId(s.name)).toBe("buy-the-house");
    expect(scenarioOf({ id: "buy-the-house", says: scenarioSays(s) })).toEqual({ id: "buy-the-house", ...s });
    expect(scenarioOf({ id: "x", says: JSON.stringify({ name: " " }) })).toBeNull();
    expect(scenarioOf({ id: "x", says: "not json" })).toBeNull();
  });

  it("changes the plan as it says, and one more year of work leaves more at walk-away", () => {
    const more = applyScenario(plan, { id: "one-more-year", name: "One more year", workYears: 1, livingDelta: 0, oneOff: null });
    expect(more.walkAwayYear).toBe(2041);
    const house = applyScenario(plan, { id: "house", name: "House", workYears: 0, livingDelta: 6_000_00, oneOff: { year: 2030, amount: 100_000_00 } });
    expect(house.livingCost).toBe(106_000_00);
    expect(house.plannedExpenses).toEqual([{ id: "scenario:house", year: 2030, label: "House", amount: 100_000_00 }]);
    const a = scenarioOutcome(plan);
    const b = scenarioOutcome(more);
    expect(b.netWorthAtWalkAway!).toBeGreaterThan(a.netWorthAtWalkAway!);
    expect(scenarioOutcome(house).endNetWorth).toBeLessThan(a.endNetWorth);
  });
});
