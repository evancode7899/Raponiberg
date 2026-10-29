import { describe, expect, it } from "vitest";
import { taxYearParams } from "../tax/params";
import { payBreakdown } from "../book/pay";
import type { StubLine } from "../ingest/payroll/types";
import { cashWaterfall, netWorthBridge, summarizeBuckets, ZERO_BUCKETS } from "./annualMath";
import { defaultBonusPct, resolveBasePay, taxOnPay, type OutlookSeeds, type PaycheckSeed, type PersonSeed } from "./basePay";
import { financialIndependenceYear, projectOutlook, retirementTax, walkAwayTable, type OutlookPlan } from "./outlook";
import { DEFAULT_BONUS_LAYER, DEFAULT_OUTLOOK, normalizeSettings } from "./settings";

// All names and amounts below are invented.
const lines = (ytd: Record<string, number>): StubLine[] => Object.entries(ytd).map(([kind, v]) => ({ name: kind, kind: kind as StubLine["kind"], current: 0, ytd: v }));

describe("payBreakdown", () => {
  it("splits a stub's year-to-date lines and ties them to net pay", () => {
    const b = payBreakdown(
      lines({ REGULAR: 1_200_00, BONUS: 1_000_00, NONTAXABLE: 30_00, IMPUTED: 3_00, FEDERAL_TAX: 120_00, MEDICARE: 12_00, SECTION125: 8_00, AFTER_TAX: 5_00, RETIREMENT_PRETAX: 90_00, HSA: 10_00, EMPLOYER_RETIREMENT: 20_00, EMPLOYER_HSA: 10_00 }),
    );
    expect(b).toMatchObject({ salary: 1_200_00, bonus: 1_000_00, reimbursements: 30_00, withholding: 132_00, benefits: 8_00, afterTax: 5_00, deferrals: 100_00, employerRetirement: 20_00, employerHsa: 10_00 });
    // Imputed income is taxed but never paid.
    expect(b.net).toBe(1_200_00 + 1_000_00 + 30_00 - 132_00 - 8_00 - 5_00 - 100_00);
  });
});

describe("cash waterfall", () => {
  it("runs gross pay down to cash saved", () => {
    const w = cashWaterfall({
      salary: 100_000,
      bonus: 50_000,
      otherIncome: 1_000,
      withholding: 50_000,
      additionalTaxes: 5_000,
      refunds: 2_000,
      otherDeductions: 1_000,
      employer: 10_000,
      partnerKept: 3_000,
      living: 60_000,
      nonRecurring: 7_000,
    });
    expect(w.grossCash).toBe(151_000);
    expect(w.netCash).toBe(151_000 - 50_000 - 5_000 + 2_000 - 1_000 + 10_000 - 3_000);
    expect(w.saved).toBe(w.netCash - 67_000);
    expect(w.cashTaxRate).toBeCloseTo(53_000 / 151_000);
    expect(w.savingsOfNet).toBeCloseTo(w.saved / w.netCash);
  });
});

describe("net worth", () => {
  it("splits liquid from illiquid and treats debts as owed amounts", () => {
    const s = summarizeBuckets({ ...ZERO_BUCKETS, CASH: 10, LIQUID: 100, ILLIQUID: 50, PHYSICAL: 5, SHORT_DEBT: -3, LONG_DEBT: -20 });
    expect(s.grossAssets).toBe(165);
    expect(s.grossDebt).toBe(23);
    expect(s.netWorth).toBe(142);
    expect(s.liquid).toBe(107);
    expect(s.illiquid).toBe(35);
  });

  it("bridges cash saved to the change in net worth", () => {
    const ledger = {
      income: 900,
      spending: -500,
      retirementEmployee: 100,
      retirementEmployer: 50,
      external: 30,
      newlyTracked: 20,
      growthNetOfFees: 80,
      transferResidual: -10,
      unexplained: 0,
    };
    const b = netWorthBridge({ cashSaved: 600, dividendsCounted: 15, ledger });
    const ledgerChange = 900 - 500 + 100 + 50 + 30 + 20 + 80 - 10;
    expect(b.total).toBe(ledgerChange);
    expect(b.investmentGrowth).toBe(65);
    expect(b.unexplainedSavings).toBe(550 + 15 - 600);
  });
});

const params = taxYearParams(2026);
const fp = params.federal;
const basePlan: OutlookPlan = {
  start: { year: 2029, month: 12, liquid: 100_000_00, illiquid: 50_000_00 },
  horizonYear: 2034,
  nearTermThrough: 2030,
  salary: 120_000_00,
  takeHomeRate: 0.7,
  deferrals: 12_000_00,
  employerMatch: 6_000_00,
  livingCost: 60_000_00,
  salaryGrowth: 0,
  livingGrowth: 0,
  bonus: null,
  returnRate: 0,
  walkAwayYear: null,
  withdrawalRate: 0.04,
  stateTaxRate: 0,
  inflation: 0,
  plannedExpenses: [],
  tax: { year: 2026, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
  birthYear: 1990,
};

describe("outlook", () => {
  it("runs each month on base pay: take-home + employer − living, deferrals and employer money to illiquid", () => {
    const { months, years } = projectOutlook(basePlan);
    expect(months[0]).toMatchObject({ key: "2030-01", salary: 10_000_00, takeHome: 7_000_00, employerMatch: 500_00, deferrals: 1_000_00, livingCost: 5_000_00, baseSaved: 2_500_00 });
    const y = years[0]!;
    expect(y).toMatchObject({ year: 2030, months: 12, salary: 120_000_00, saved: 30_000_00, age: 40 });
    expect(y.illiquid).toBe(50_000_00 + 18_000_00);
    expect(y.liquid).toBe(100_000_00 + 12_000_00);
    expect(years.at(-1)!.netWorth).toBe(150_000_00 + 5 * 30_000_00);
  });

  it("starts the month after the latest proven balance", () => {
    const { years } = projectOutlook({ ...basePlan, start: { ...basePlan.start, year: 2030, month: 6 } });
    expect(years[0]).toMatchObject({ year: 2030, months: 6, salary: 60_000_00 });
    expect(years[1]!.months).toBe(12);
  });

  it("pays each scheduled bonus in its month and saves the chosen share of what's kept", () => {
    const bonus = { payments: [{ key: "2032-03", gross: 50_000_00 }], keepRate: 0.6, savedShare: 0.5 };
    const { months, years } = projectOutlook({ ...basePlan, bonus });
    expect(years.filter((y) => y.year !== 2032).every((y) => y.bonusGross === 0)).toBe(true);
    const y = years.find((v) => v.year === 2032)!;
    expect(y).toMatchObject({ bonusGross: 50_000_00, bonusKept: 30_000_00, bonusSaved: 15_000_00, baseSaved: 30_000_00, saved: 45_000_00 });
    expect(months.find((m) => m.key === "2032-03")!.bonusSaved).toBe(15_000_00);
    // The bonus is liquid money; its growth is reported separately from the retirement accounts'.
    const r = projectOutlook({ ...basePlan, bonus, returnRate: 0.06 }).months.find((m) => m.key === "2032-03")!;
    expect(r.liquidGrowth).toBeGreaterThan(0);
    expect(r.liquidGrowth).toBeLessThan(r.growth);
  });

  it("takes a planned one-off in its month", () => {
    const { months, years } = projectOutlook({ ...basePlan, plannedExpenses: [{ id: "a", year: 2031, month: 9, label: "car", amount: 5_000_00 }] });
    expect(months.find((m) => m.key === "2031-09")!.planned).toBe(5_000_00);
    expect(years.find((y) => y.year === 2031)!.saved).toBe(25_000_00);
  });

  it("compounds the return monthly", () => {
    const { years } = projectOutlook({ ...basePlan, salary: 0, deferrals: 0, employerMatch: 0, livingCost: 0, returnRate: 0.12 });
    expect(years[0]!.netWorth / 150_000_00).toBeCloseTo(1.12, 4);
  });

  it("draws the withdrawal rate once retired and taxes it with the brackets", () => {
    const { years } = projectOutlook({ ...basePlan, walkAwayYear: 2032 });
    const retired = years.find((y) => y.year === 2032)!;
    expect(retired.working).toBe(false);
    expect(retired.draw).toBe(Math.round(retired.startNetWorth * 0.04));
    expect(retired.afterTaxIncome).toBe(retirementTax(basePlan, 2032, retired.draw).afterTax);
    expect(retired.netWorth).toBe(retired.startNetWorth - retired.draw);
  });

  it("finds the first year walk-away income covers living cost", () => {
    const rows = walkAwayTable({ ...basePlan, livingCost: 9_000_00, horizonYear: 2040 });
    expect(rows[0]!.year).toBe(2030);
    const fi = financialIndependenceYear(rows);
    expect(fi).not.toBeNull();
    expect(fi!.coverage!).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.year < fi!.year).every((r) => (r.coverage ?? 0) < 1)).toBe(true);
  });

  it("owes no federal tax on a draw under the standard deduction", () => {
    expect(retirementTax(basePlan, 2030, 20_000_00).federal).toBe(0);
  });
});

const check = (regular: number): PaycheckSeed => ({ payDate: "2026-09-15", regular, section125: 0, hsa: 0, afterTax: 0, employer: Math.round(regular * 0.05) });
const seeds = (people: Partial<PersonSeed>[]): OutlookSeeds => ({
  start: { asOf: "2026-06-30", year: 2026, month: 6, liquid: 0, illiquid: 0, note: "" },
  baseYear: 2025,
  currentYear: 2026,
  people: people.map((p, i) => ({
    personId: `p${i}`,
    name: `P${i}`,
    employer: "X",
    perYear: 24,
    frequency: "SEMIMONTHLY",
    latest: check(6_250_00),
    typical: check(6_250_00),
    deferrals: { LATEST: { k401Pretax: 10_000_00, k401Roth: 0, hsa: 0 }, TYPICAL: { k401Pretax: 10_000_00, k401Roth: 0, hsa: 0 } },
    bonusHistory: [],
    bonusMonth: 3,
    bonusesSinceStart: [],
    note: "",
    ...p,
  })),
  living: { LAST_YEAR: { cents: 80_000_00, label: "2025", detail: "" }, TRAILING_12: { cents: 70_000_00, label: "12m", detail: "" } },
  realizedReturn: null,
  taxYear: 2026,
  tax: { year: 2026, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
  dependents: [],
  birthYear: null,
});

describe("base pay", () => {
  it("annualizes the chosen regular paycheck and taxes base pay on its own", () => {
    const s = seeds([{ latest: check(5_000_00), typical: check(6_250_00) }]);
    const typical = resolveBasePay(s, DEFAULT_OUTLOOK, params);
    expect(typical.salary).toBe(150_000_00);
    expect(typical.employer).toBe(Math.round(6_250_00 * 0.05) * 24);
    expect(typical.tax.total).toBe(taxOnPay(params, [{ id: "p0", name: "P0", salary: 150_000_00, bonus: 0, k401Pretax: 10_000_00, hsa: 0, section125: 0 }], []).total);
    expect(typical.takeHomeRate).toBeCloseTo(1 - typical.tax.total / 150_000_00, 6);
    const latest = resolveBasePay(s, { ...DEFAULT_OUTLOOK, people: { p0: { paycheck: "LATEST", salary: null, bonusPct: null } } }, params);
    expect(latest.salary).toBe(120_000_00);
    const typed = resolveBasePay(s, { ...DEFAULT_OUTLOOK, people: { p0: { paycheck: "TYPICAL", salary: 200_000_00, bonusPct: null } }, takeHomeRate: 0.65 }, params);
    expect(typed.salary).toBe(200_000_00);
    expect(typed.takeHomeRate).toBe(0.65);
    expect(typed.computedRate).toBeLessThan(typical.computedRate);
  });

  it("keeps less of a bonus than of base pay: it's taxed at the top of the brackets", () => {
    const s = seeds([{ bonusHistory: [{ year: 2025, salary: 150_000_00, bonus: 75_000_00, pct: 0.5, partial: false }] }]);
    const r = resolveBasePay(s, DEFAULT_OUTLOOK, params);
    expect(r.bonus.gross).toBe(75_000_00);
    expect(r.bonus.computedKeep).toBeGreaterThan(0.4);
    expect(r.bonus.computedKeep).toBeLessThan(r.computedRate);
    expect(r.bonus.extraTax.total).toBe(Math.round(75_000_00 * (1 - r.bonus.computedKeep)));
  });

  it("defaults a bonus to the lowest of the last three complete years, ignoring the year in progress", () => {
    const h = (year: number, pct: number, partial = false) => ({ year, salary: 100, bonus: pct * 100, pct, partial });
    expect(defaultBonusPct([h(2021, 0.1), h(2022, 0.6), h(2023, 0.4), h(2024, 0.9), h(2025, 1.2, true)])).toMatchObject({ pct: 0.4 });
    expect(defaultBonusPct([]).pct).toBe(0);
  });
});

describe("settings", () => {
  it("coerces untrusted input and drops the retired override fields", () => {
    const s = normalizeSettings({
      years: { "2024": { people: { a: { salaryPaid: 123 } } } },
      offLedger: [{ id: "1", name: "HSA", bucket: "ILLIQUID", values: { "2024": 99 } }],
      bonusLag: { a: 0 },
      oneOffs: { fp: "Wedding" },
      outlook: { returnRate: 0.07, withdrawalRate: 3 },
    } as never);
    expect(s).not.toHaveProperty("years");
    expect(s).not.toHaveProperty("offLedger");
    expect(s).not.toHaveProperty("bonusLag");
    expect(s.oneOffs).toEqual({ fp: "Wedding" });
    expect(s.outlook.returnRate).toBe(0.07);
    expect(s.outlook.withdrawalRate).toBe(0.035);
  });

  it("turns the old household bonus figure into the bonus layer's defaults", () => {
    const s = normalizeSettings({ outlook: { bonus: 167_589_19, bonusGrowth: 0.03, salary: 1, people: { a: { paycheck: "LATEST", bonusPct: 0.5 }, b: "junk" } } } as never);
    expect(s.outlook.bonus).toEqual(DEFAULT_BONUS_LAYER);
    expect(s.outlook).not.toHaveProperty("bonusGrowth");
    expect(s.outlook).not.toHaveProperty("salary");
    expect(s.outlook.people).toEqual({ a: { paycheck: "LATEST", salary: null, bonusPct: 0.5 } });
  });

  it("turns the old on/off bonus layer into when estimates start", () => {
    expect(normalizeSettings({ outlook: { bonus: { include: false, keepRate: 0.6, savedShare: 0.5 } } } as never).outlook.bonus).toEqual({ estimates: "NONE", keepRate: 0.6, savedShare: 0.5 });
    expect(normalizeSettings({ outlook: { bonus: { include: true } } } as never).outlook.bonus.estimates).toBe("AFTER_NEAR_TERM");
    expect(normalizeSettings({ outlook: { bonus: { estimates: "NEXT_PAYOUT" } } } as never).outlook.bonus.estimates).toBe("NEXT_PAYOUT");
  });
});
