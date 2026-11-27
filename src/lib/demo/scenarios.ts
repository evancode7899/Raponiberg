import { DEFAULT_BUY, DEFAULT_MODEL, emptyScenario, personChange, type ScenarioFile } from "../scenarios/types.ts";

/** The demo household's saved scenarios (data/demo/scenarios.json): one of each kind, all compared. */
export function demoScenarios(): ScenarioFile {
  const child = emptyScenario("demo-child", "Second child");
  child.children.added.push({ id: "demo-baby", label: "Baby", born: "2027-09" });
  const home = emptyScenario("demo-home", "Buy a home");
  home.housing.buy = { ...DEFAULT_BUY, at: "2027-06", price: 2_400_000_00, downPct: 0.25, insurance: 6_000_00, utilities: 700_00 };
  const stop = emptyScenario("demo-stop", "Jordan stops work");
  stop.people.push({ ...personChange("jordan"), stop: { from: "2027-07", endsCare: true } });
  return { version: 1, model: DEFAULT_MODEL, scenarios: [child, home, stop], compare: [child.id, home.id, stop.id] };
}
