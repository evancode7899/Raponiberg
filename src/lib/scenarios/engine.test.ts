import { describe, expect, it } from "vitest";
import { fiYear } from "../fire/fire";
import { buildForecast } from "../forecast/forecast";
import { forecastFiller } from "../goals/fill";
import { fixedMonthlyPayment } from "../mortgage/prepayVsInvest";
import type { OutlookSeeds, PersonSeed } from "../profile/basePay";
import { monthly } from "../profile/outlook";
import { DEFAULT_OUTLOOK, type OutlookAssumptions } from "../profile/settings";
import { taxYearParams } from "../tax/params";
import { flowOf, goalPath, metricsOf } from "./compare";
import { runScenario, type ScenarioContext } from "./engine";
import type { GoalReach } from "./goals";
import { DEFAULT_MODEL, emptyScenario, normalizeScenarioFile, personChange, type Scenario } from "./types";

// An invented household: Pat and Sam, one child (2 on the tax profile), renting.
const params = taxYearParams(2026);
const fp = params.federal;
const seed = (personId: string, name: string, regular: number, bonusPct: number): PersonSeed => ({
  personId,
  name,
  employer: "Example Co",
  perYear: 24,
  frequency: "SEMIMONTHLY",
  latest: { payDate: "2026-05-15", regular, section125: 150_00, hsa: 100_00, afterTax: 20_00, employer: 300_00 },
  typical: { payDate: "2026-05-15", regular, section125: 150_00, hsa: 100_00, afterTax: 20_00, employer: 300_00 },
  deferrals: { LATEST: { k401Pretax: 12_000_00, k401Roth: 0, hsa: 2_400_00 }, TYPICAL: { k401Pretax: 12_000_00, k401Roth: 0, hsa: 2_400_00 } },
  bonusHistory: [{ year: 2025, salary: regular * 24, bonus: Math.round(regular * 24 * bonusPct), pct: bonusPct, partial: false }],
  bonusMonth: 3,
  bonusesSinceStart: [],
  note: "",
});
const seeds: OutlookSeeds = {
  start: { asOf: "2026-05-31", year: 2026, month: 5, liquid: 180_000_00, illiquid: 320_000_00, note: "" },
  baseYear: 2025,
  currentYear: 2026,
  people: [seed("pat", "Pat", 7_500_00, 0.15), seed("sam", "Sam", 5_000_00, 0.1)],
  living: { TRAILING_12: { cents: 110_000_00, label: "Last 12 months", detail: "" } },
  realizedReturn: null,
  taxYear: 2026,
  tax: { year: 2026, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
  dependents: [{ name: "Kid", age: 2 }],
  birthYear: 1990,
};
const a: OutlookAssumptions = { ...DEFAULT_OUTLOOK, horizonYear: 2046, returnRate: 0.06, salaryGrowth: 0.03, inflation: 0.025, livingGrowth: 0.025 };
const forecast = buildForecast({ seeds, bonusFacts: { scheduled: [], patterns: [] } }, a);
const ctx: ScenarioContext = {
  forecast,
  seeds,
  params,
  model: DEFAULT_MODEL,
  facts: { asOf: "2026-05-31", childcare: { annual: 20_000_00, months: 12, rows: 12 }, housing: { monthly: 3_000_00, months: 12 } },
};
const today = runScenario(ctx, emptyScenario("today", "Today's plan"));
const scen = (patch: (s: Scenario) => void) => {
  const s = emptyScenario("x", "X");
  patch(s);
  return runScenario(ctx, s);
};
const at = (run: ReturnType<typeof runScenario>, key: string) => run.months.find((m) => m.key === key)!;
const out = (run: ReturnType<typeof runScenario>, key: string) => run.outlook.find((m) => m.key === key)!;
const sumYear = (run: ReturnType<typeof runScenario>, year: number, f: (m: ReturnType<typeof runScenario>["outlook"][number]) => number) =>
  run.outlook.filter((m) => m.year === year).reduce((t, m) => t + f(m), 0);

describe("today's plan", () => {
  it("is the forecast, month for month, and FIRE's FI year", () => {
    expect(today.plan.adjust).toBeUndefined();
    expect(today.outlook.slice(0, forecast.months.length)).toEqual(forecast.months);
    expect(today.fiYear).toBe(fiYear(forecast.plan));
    expect(today.years.every((y) => y.equity === 0)).toBe(true);
  });

  it("reaches each goal when the Goals page's rule says, on the same path", () => {
    const goals: GoalReach[] = [
      { id: "e", name: "Emergency", remaining: 30_000_00, liquid: true, illiquid: false, track: false, funded: true, targetDate: null },
      { id: "m", name: "Milestone", remaining: 400_000_00, liquid: true, illiquid: true, track: true, funded: true, targetDate: null },
      { id: "d", name: "Done", remaining: 0, liquid: true, illiquid: false, track: false, funded: true, targetDate: null },
    ];
    const reach = forecastFiller({ startKey: forecast.startKey, start: forecast.plan.start, months: forecast.months });
    const expected = [reach(30_000_00, true, false), reach(400_000_00, true, true, true), "now"];
    expect(metricsOf(today, { startKey: forecast.startKey, window: "2026-06", horizonYear: 2046, goals }).goals).toEqual(expected);
    expect(goalPath(today, forecast.startKey).months.slice(0, 12)).toEqual(forecast.months.slice(0, 12).map(({ key, liquid, illiquid }) => ({ key, liquid, illiquid })));
  });

  it("a scenario that names a person but changes nothing is still today's plan", () => {
    const same = scen((s) => s.people.push(personChange("sam")));
    expect(same.outlook).toEqual(today.outlook);
  });
});

describe("children", () => {
  it("a second child doubles per-child care while both are in full-time care", () => {
    const two = scen((s) => s.children.added.push({ id: "c2", label: "Second", born: "2027-03" }));
    // Before the birth: nothing changes.
    expect(at(two, "2027-02").childcare).toBe(at(today, "2027-02").childcare);
    // While the new child is 0–4 (today's child's care carries on as in today's plan): twice today's.
    for (const key of ["2027-03", "2028-06", "2031-12"]) expect(Math.abs(at(two, key).childcare - 2 * at(today, key).childcare)).toBeLessThanOrEqual(1);
    // From 5 the new child needs a third of full-time care.
    expect(Math.abs(at(two, "2032-06").childcare - 1.3 * at(today, "2032-06").childcare)).toBeLessThanOrEqual(1);
    // A dependent more on the return: less tax that year.
    expect(sumYear(two, 2028, (m) => m.takeHome)).toBeGreaterThan(sumYear(today, 2028, (m) => m.takeHome));
  });

  it("with today's children ageing out too, the overlap ends when the first turns five", () => {
    const two = scen((s) => {
      s.children.added.push({ id: "c2", label: "Second", born: "2027-03" });
      s.children.ageOut = true;
    });
    const base = (key: string) => at(today, key).childcare;
    expect(Math.abs(at(two, "2029-06").childcare - 2 * base("2029-06"))).toBeLessThanOrEqual(1);
    // Born mid-2024, five in July 2029: then 0.3 + 1 shares.
    expect(Math.abs(at(two, "2029-07").childcare - 1.3 * base("2029-07"))).toBeLessThanOrEqual(1);
  });
});

describe("a partner stops working", () => {
  const key = "2027-04";
  it("removes their pay, retirement saving and bonuses, and with the switch, childcare", () => {
    const stop = scen((s) => s.people.push({ ...personChange("sam"), stop: { from: "2027-01", endsCare: true } }));
    const samMonthly = Math.round((5_000_00 * 24 * 1.03) / 12);
    expect(Math.abs(out(today, key).salary - out(stop, key).salary - samMonthly)).toBeLessThanOrEqual(1);
    expect(out(stop, key).deferrals).toBeLessThan(out(today, key).deferrals);
    expect(out(stop, key).employerMatch).toBeLessThan(out(today, key).employerMatch);
    expect(at(stop, key).childcare).toBe(0);
    expect(out(today, key).livingCost - out(stop, key).livingCost).toBe(at(today, key).childcare);
    // Their tax goes with their pay: take-home falls by less than their gross.
    const lost = out(today, key).takeHome - out(stop, key).takeHome;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(samMonthly);
    // Sam's estimated bonuses stop; Pat's stay.
    const bonus = (r: typeof today, y: number) => sumYear(r, y, (m) => m.bonusGross);
    expect(bonus(stop, 2029)).toBeLessThan(bonus(today, 2029));
    expect(bonus(stop, 2029)).toBeGreaterThan(0);
  });

  it("without the switch, childcare carries on", () => {
    const stop = scen((s) => s.people.push({ ...personChange("sam"), stop: { from: "2027-01", endsCare: false } }));
    expect(at(stop, key).childcare).toBe(at(today, key).childcare);
  });

  it("part-time and a job change move pay from their dates", () => {
    const pt = scen((s) => s.people.push({ ...personChange("pat"), partTime: { from: "2027-01", share: 0.5 } }));
    expect(out(pt, "2026-12").salary).toBe(out(today, "2026-12").salary);
    expect(out(pt, "2027-06").salary).toBeLessThan(out(today, "2027-06").salary);
    const job = scen((s) => s.people.push({ ...personChange("pat"), jobChange: { from: "2027-07", salary: 250_000_00, bonusPct: 0 } }));
    expect(out(job, "2027-08").salary - out(today, "2027-08").salary).toBe(monthly(250_000_00, 8) - monthly(7_500_00 * 24 * 1.03, 8));
    expect(out(job, "2027-08").salary).toBeGreaterThan(out(today, "2027-08").salary);
  });
});

describe("housing", () => {
  const buy = {
    at: "2027-06",
    price: 800_000_00,
    downPct: 0.2,
    rate: 0.06,
    termYears: 30,
    taxRate: 0.02,
    upkeepRate: 0.01,
    insurance: 2_400_00,
    hoa: 0,
    utilities: 400_00,
    closingPct: 0.03,
    appreciation: 0.03,
  };
  const bought = scen((s) => (s.housing.buy = buy));

  it("buying takes the down payment and closing in the purchase month and replaces rent with the home's costs", () => {
    expect(out(bought, "2027-06").planned).toBe(160_000_00 + 24_000_00);
    expect(at(bought, "2027-06").housing).toBe(at(today, "2027-06").housing);
    expect(at(today, "2027-07").housing).toBeGreaterThan(0);
    // The month after: the mortgage payment plus a twelfth of the year's tax, insurance and upkeep, utilities.
    const pmt = fixedMonthlyPayment(640_000_00, 0.06, 360);
    const value = 800_000_00 * 1.03 ** (1 / 12);
    const expected = Math.round(pmt + (value * 0.02) / 12 + 2_400_00 / 12 + 400_00 + (value * 0.01) / 12);
    expect(at(bought, "2027-07").housing).toBe(expected);
    expect(out(bought, "2027-07").livingCost - out(today, "2027-07").livingCost).toBe(expected - at(today, "2027-07").housing);
    // Equity: the down payment, the first month's principal and the month's appreciation.
    const principal = pmt - 640_000_00 * 0.005;
    expect(Math.abs(at(bought, "2027-07").equity - (value - (640_000_00 - principal)))).toBeLessThanOrEqual(1);
  });

  it("itemizing the mortgage interest and property tax cuts the year's tax", () => {
    const tax = (r: typeof today, y: number) => r.years.find((x) => x.year === y)!.tax;
    expect(tax(bought, 2028)).toBeLessThan(tax(today, 2028));
    // The cut is all in take-home pay; pay itself doesn't move.
    expect(sumYear(bought, 2028, (m) => m.salary)).toBe(sumYear(today, 2028, (m) => m.salary));
    expect(sumYear(bought, 2028, (m) => m.takeHome) - sumYear(today, 2028, (m) => m.takeHome)).toBe(tax(today, 2028) - tax(bought, 2028));
  });

  it("renting with faster rent growth costs more each year", () => {
    const rent = scen((s) => (s.housing.rentGrowth = 0.06));
    expect(at(rent, "2030-06").housing).toBeGreaterThan(at(today, "2030-06").housing);
    expect(Math.abs(at(rent, "2030-06").housing - Math.round((3_000_00 * 12 * 1.06 ** 4) / 12))).toBeLessThanOrEqual(1);
  });
});

describe("spending and assumptions", () => {
  it("inflation compounds living cost each year when the forecast ties the two", () => {
    const hot = scen((s) => (s.assumptions.inflation = 0.04));
    for (const y of [2027, 2031, 2040]) {
      const living = sumYear(hot, y, (m) => m.livingCost);
      const care = hot.months.filter((m) => m.year === y).reduce((t, m) => t + m.childcare, 0);
      const rentY = hot.months.filter((m) => m.year === y).reduce((t, m) => t + m.housing, 0);
      // Childcare and rent are inside living cost and grow with it, so the whole is 110k × 1.04^n.
      expect(Math.abs(living - Math.round(110_000_00 * 1.04 ** (y - 2026)))).toBeLessThanOrEqual(24);
      expect(care).toBeGreaterThan(0);
      expect(rentY).toBeGreaterThan(0);
    }
  });

  it("a one-off leaves cash in its month, and a lower return lowers net worth", () => {
    const big = scen((s) => s.spending.oneOffs.push({ id: "o", label: "Car", amount: 40_000_00, at: "2028-02" }));
    expect(out(big, "2028-02").planned).toBe(40_000_00);
    expect(out(big, "2028-02").liquid).toBeLessThan(out(today, "2028-02").liquid - 39_000_00);
    const low = scen((s) => (s.assumptions.returnRate = 0.03));
    expect(low.years.at(-1)!.netWorth).toBeLessThan(today.years.at(-1)!.netWorth);
  });

  it("compares a year of cash flow from the first change", () => {
    const stop = scen((s) => s.people.push({ ...personChange("sam"), stop: { from: "2027-01", endsCare: true } }));
    expect(stop.firstChange).toBe("2027-01");
    const w = flowOf(stop.months, "2027-01");
    expect(w.months).toBe(12);
    expect(w.childcare).toBe(0);
    expect(w.takeHome).toBeLessThan(flowOf(today.months, "2027-01").takeHome);
  });
});

describe("normalizeScenarioFile", () => {
  it("keeps well-formed scenarios and drops the rest", () => {
    const s = emptyScenario("a", "Buy");
    s.housing.buy = { at: "2028-01", price: 1, downPct: 0.2, rate: 0.06, termYears: 30, taxRate: 0.02, upkeepRate: 0.01, insurance: 0, hoa: 0, utilities: 0, closingPct: 0.03, appreciation: null };
    const f = normalizeScenarioFile({ scenarios: [s, { id: "a" }, { nope: 1 }], compare: ["a", "missing"], model: { careBands: [{ fromAge: 0, toAge: 4, share: 1 }] } });
    expect(f.scenarios).toHaveLength(1);
    expect(f.scenarios[0]).toEqual(s);
    expect(f.compare).toEqual(["a"]);
    expect(f.model.careBands).toEqual([{ fromAge: 0, toAge: 4, share: 1 }]);
    expect(normalizeScenarioFile(null).model).toEqual(DEFAULT_MODEL);
  });
});
