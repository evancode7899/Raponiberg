import { describe, expect, it } from "vitest";
import { financialIndependenceYear, projectOutlook, retirementTax, walkAwayTable, type OutlookPlan } from "../profile/outlook";
import { DEFAULT_OUTLOOK } from "../profile/settings";
import { taxYearParams } from "../tax/params";
import { accessBridge, analyzeFire, drawFor, firePlans, extended, fireNumber, fiYear, randomReturns, savingsRateCurve, sensitivityGrid, spendingCuts, stressTest } from "./fire";

// All amounts below are invented.
const fp = taxYearParams(2026).federal;
const plan: OutlookPlan = {
  start: { year: 2029, month: 12, liquid: 300_000_00, illiquid: 200_000_00 },
  horizonYear: 2050,
  nearTermThrough: 2029,
  salary: 220_000_00,
  bonus: null,
  employerMatch: 10_000_00,
  deferrals: 30_000_00,
  livingCost: 90_000_00,
  takeHomeRate: 0.65,
  salaryGrowth: 0.03,
  livingGrowth: 0.025,
  returnRate: 0.06,
  walkAwayYear: null,
  withdrawalRate: 0.035,
  stateTaxRate: 0.05,
  inflation: 0.025,
  plannedExpenses: [],
  tax: { year: 2026, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
  birthYear: 1995,
};

describe("FIRE number", () => {
  it("is the smallest draw that covers spending after tax, divided by the withdrawal rate", () => {
    for (const target of [10_000_00, 60_000_00, 150_000_00, 400_000_00]) {
      const d = drawFor(plan, 2035, target);
      expect(retirementTax(plan, 2035, d).afterTax).toBeGreaterThanOrEqual(target);
      expect(retirementTax(plan, 2035, d - 1).afterTax).toBeLessThan(target);
    }
    expect(fireNumber(plan, 2035, 60_000_00)).toBe(Math.ceil(drawFor(plan, 2035, 60_000_00) / 0.035));
  });

  it("is 25× spending at 4% when no tax applies", () => {
    const noTax = { ...plan, stateTaxRate: 0, withdrawalRate: 0.04, tax: { ...plan.tax, standardDeduction: 1e12 } };
    expect(fireNumber(noTax, 2030, 80_000_00)).toBe(2_000_000_00);
  });

  it("crosses net worth in exactly the walk-away table's FI year", () => {
    for (const livingCost of [60_000_00, 90_000_00, 140_000_00]) {
      const p = { ...plan, livingCost };
      const walk = walkAwayTable(extended(p));
      const fi = financialIndependenceYear(walk);
      const crossing = walk.find((w) => w.netWorth >= fireNumber(p, w.year, w.livingCost));
      expect(crossing?.year ?? null).toBe(fi?.year ?? null);
    }
  });
});

describe("analyzeFire", () => {
  const a = analyzeFire(plan, plan, { asOf: "2029-12-31", retirementAge: 65 });

  it("orders the flavors: Coast and Lean before FIRE, FIRE before Fat", () => {
    expect(a.fi).not.toBeNull();
    expect(a.lean!.year).toBeLessThanOrEqual(a.fi!.year);
    expect(a.coast!.year).toBeLessThanOrEqual(a.fi!.year);
    expect(a.fat!.year).toBeGreaterThanOrEqual(a.fi!.year);
    expect(a.fi!.year).toBe(fiYear(plan));
  });

  it("has a Coast number that grows into the FIRE number at retirement age", () => {
    const at = a.rows.find((r) => r.year === 2060)!;
    expect(a.retireYear).toBe(2060);
    expect(at.coastNumber).toBe(fireNumber(plan, 2060, at.livingCost));
    const earlier = a.rows.find((r) => r.year === 2040)!;
    expect(earlier.coastNumber).toBe(Math.round(at.coastNumber! / 1.06 ** 20));
  });

  it("reports today's progress and runway from the latest net worth", () => {
    expect(a.now.livingCost).toBe(90_000_00);
    expect(a.now.netWorth).toBe(500_000_00);
    expect(a.now.progress).toBeCloseTo(500_000_00 / a.now.fireNumber);
    expect(a.now.yearsOfSpending).toBeCloseTo(500 / 90);
    expect(a.now.leanNumber).toBeLessThan(a.now.fireNumber);
    expect(a.now.fatNumber).toBeGreaterThan(a.now.fireNumber);
    const y1 = a.projection.find((y) => y.months === 12)!;
    expect(a.savingsRate).toBeCloseTo(y1.saved / (y1.takeHome + y1.employerMatch));
  });

  it("lists milestones reached first, then in time order", () => {
    const years = a.milestones.filter((m) => !m.reached).map((m) => m.year ?? Infinity);
    expect([...years].sort((x, y) => x - y)).toEqual(years);
    expect(a.milestones.find((m) => m.id === "fi")!.year).toBe(a.fi!.year);
  });

  it("dates net worth milestones to the month the plan's balance first reaches them", () => {
    const m = a.milestones.find((x) => x.id === `nw-${1_000_000_00}`)!;
    const months = projectOutlook(extended(plan)).months;
    expect(m.key).toBe(months.find((x) => x.netWorth >= 1_000_000_00)!.key);
    expect(m.year).toBe(Number(m.key!.slice(0, 4)));
  });
});

describe("levers", () => {
  it("brings FI closer as the savings rate rises", () => {
    const curve = savingsRateCurve(plan, [0.1, 0.3, 0.5, 0.7]);
    const years = curve.map((c) => c.years ?? Infinity);
    for (let i = 1; i < years.length; i++) expect(years[i]!).toBeLessThanOrEqual(years[i - 1]!);
  });

  it("matches the plan when nothing is cut", () => {
    expect(spendingCuts(plan, [0])[0]!.fiYear).toBe(fiYear(plan));
    const cut = spendingCuts(plan, [2_000_00])[0]!;
    expect(cut.livingCost).toBe(90_000_00 - 24_000_00);
    expect(cut.fiYear!).toBeLessThanOrEqual(fiYear(plan)!);
  });

  it("puts the plan's own return and rate in the grid", () => {
    const g = sensitivityGrid(plan, [0.04, 0.06], [0.035, 0.04]);
    expect(g[1]![0]).toBe(fiYear(plan));
    expect(g[0]![0]! >= g[1]![0]!).toBe(true);
  });
});

describe("access bridge", () => {
  it("finds when taxable money runs out before 59½", () => {
    const b = accessBridge({ ...plan, start: { ...plan.start, liquid: 50_000_00, illiquid: 2_000_000_00 } }, 2031)!;
    expect(b.accessYear).toBe(2055);
    expect(b.liquidOutYear).not.toBeNull();
    expect(b.gapYears).toBe(2055 - b.liquidOutYear!);
  });

  it("needs a birth year", () => {
    expect(accessBridge({ ...plan, birthYear: null }, 2031)).toBeNull();
  });
});

describe("stress test", () => {
  it("reruns the deterministic plan when volatility is zero", () => {
    const s = stressTest(plan, { volatility: 0, paths: 20 });
    expect(s.fiYears.p50).toBe(fiYear(plan));
    expect(s.fiYears.p10).toBe(s.fiYears.p90);
    for (const b of s.bands) {
      expect(b.p10).toBe(b.plan);
      expect(b.p90).toBe(b.plan);
    }
  });

  it("spreads outcomes around the plan with volatility", () => {
    const s = stressTest(plan, { volatility: 0.15, paths: 300 });
    const last = s.bands.at(-1)!;
    expect(last.p10).toBeLessThan(last.p50);
    expect(last.p50).toBeLessThan(last.p90);
    expect(s.fiByYear.at(-1)!.share).toBeGreaterThan(0.5);
    // Same seed, same answer.
    expect(stressTest(plan, { volatility: 0.15, paths: 300 }).fiYears).toEqual(s.fiYears);
  });

  it("draws returns with the requested average", () => {
    let i = 0;
    const next = () => ((i = (i * 9301 + 49297) % 233280), i / 233280);
    const xs = randomReturns(0.06, 0.15, 20_000, next);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeCloseTo(0.06, 1);
  });

  it("leaves the engine unchanged when the returns equal the plan's rate", () => {
    const flat = projectOutlook({ ...plan, returns: Array(30).fill(plan.returnRate) });
    expect(flat).toEqual(projectOutlook(plan));
  });
});

describe("firePlans", () => {
  const bonus = { payments: [{ key: "2031-03", gross: 9_000_00 }], keepRate: 0.5, savedShare: 0.8 };

  it("is the shared forecast with the walk-away year; the base plan drops every bonus", () => {
    const { full, base } = firePlans({ plan: { ...plan, bonus }, assumptions: { ...DEFAULT_OUTLOOK, walkAwayYear: 2040 } });
    expect(full).toMatchObject({ ...plan, bonus, walkAwayYear: 2040 });
    expect(base).toMatchObject({ ...plan, bonus: null, walkAwayYear: 2040 });
  });

  it("uses one plan when there are no bonuses", () => {
    const { full, base } = firePlans({ plan, assumptions: DEFAULT_OUTLOOK });
    expect(full).toBe(base);
  });
});
