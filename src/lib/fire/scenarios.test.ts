import { describe, expect, it } from "vitest";
import type { OutlookPlan } from "../profile/outlook";
import { applyScenario, fireScenario, fromFireMark, notOnFire, scenarioId, scenarioOutcome } from "./scenarios";
import { emptyScenario } from "../scenarios/types";

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
  it("moves an old saved FIRE scenario in as a scenario, and refuses one without a name", () => {
    const s = { name: "Buy the house", workYears: 1, livingDelta: 12_000_00, oneOff: { year: 2029, amount: 150_000_00 } };
    expect(scenarioId(s.name)).toBe("buy-the-house");
    const x = fromFireMark({ id: "buy-the-house", says: JSON.stringify(s) })!;
    expect([x.id, x.name, x.retire.workYears, x.spending.livingChange, x.spending.oneOffs]).toEqual(["buy-the-house", "Buy the house", 1, 12_000_00, [{ id: "one-off", label: "Buy the house", amount: 150_000_00, at: "2029-01" }]]);
    expect(fromFireMark({ id: "x", says: JSON.stringify({ name: " " }) })).toBeNull();
    expect(fromFireMark({ id: "x", says: "not json" })).toBeNull();
  });

  it("runs what FIRE models and names what only the Scenarios page runs", () => {
    const s = { ...emptyScenario("x", "X"), people: [{ personId: "a", raise: null, bonusLevel: 0, jobChange: null, partTime: null, stop: null }] };
    expect(notOnFire(s)).toEqual(["pay"]);
    expect(notOnFire(fireScenario("Y", { workYears: 2, livingDelta: 0, oneOff: null }))).toEqual([]);
  });

  it("changes the plan as it says, and one more year of work leaves more at walk-away", () => {
    const more = applyScenario(plan, fireScenario("One more year", { workYears: 1, livingDelta: 0, oneOff: null }));
    expect(more.walkAwayYear).toBe(2041);
    const house = applyScenario(plan, fireScenario("House", { workYears: 0, livingDelta: 6_000_00, oneOff: { year: 2030, amount: 100_000_00 } }));
    expect(house.livingCost).toBe(106_000_00);
    expect(house.plannedExpenses).toEqual([{ id: "scenario:house:one-off", year: 2030, label: "House", amount: 100_000_00 }]);
    const a = scenarioOutcome(plan);
    const b = scenarioOutcome(more);
    expect(b.netWorthAtWalkAway!).toBeGreaterThan(a.netWorthAtWalkAway!);
    expect(scenarioOutcome(house).endNetWorth).toBeLessThan(a.endNetWorth);
  });
});
