import { describe, expect, it } from "vitest";
import {
  breakEvenReturn,
  calendarToLoanPaymentMonth,
  comparePrepayVsInvest,
  deductionValue,
  fixedMonthlyPayment,
  futureValueOfAnnuity,
  INVEST_ALL,
  loanMonthToCalendar,
  monteCarlo,
  PREPAY_ALL,
  PREPAY_EXTRA_ONLY,
  PREPAY_LUMPS_ONLY,
  simulatePath,
  type MortgagePlan,
} from "./prepayVsInvest";

/** No taxes anywhere, so the pure finance can be checked against closed forms. */
const plain = (over: Partial<MortgagePlan> = {}): MortgagePlan => ({
  principal: 400_000,
  annualRate: 0.06,
  termMonths: 360,
  startYear: 2026,
  startMonth: 1,
  extraMonthly: 500,
  lumps: [],
  horizonMonths: 360,
  investReturn: 0.07,
  dividendYield: 0,
  investTaxRate: 0,
  taxFreeAccount: true,
  sellAtHorizon: true,
  deductInterest: false,
  marginalRate: 0,
  standardDeduction: 32_200,
  otherItemized: 0,
  otherItemizedFrom2030: 0,
  debtCap: 750_000,
  inflation: 0.025,
  ...over,
});
const last = (a: Float64Array) => a[a.length - 1]!;

describe("helpers", () => {
  it("level payment matches the standard 30-year example", () => {
    expect(fixedMonthlyPayment(400_000, 0.06, 360)).toBeCloseTo(2398.2, 1);
  });
  it("calendar ↔ loan month", () => {
    expect(calendarToLoanPaymentMonth(2025, 3, 2025, 3)).toBe(1);
    expect(calendarToLoanPaymentMonth(2026, 3, 2025, 3)).toBe(13);
    expect(loanMonthToCalendar(1, 2025, 11)).toEqual({ year: 2025, month: 11 });
    expect(loanMonthToCalendar(3, 2025, 11)).toEqual({ year: 2026, month: 1 });
  });
  it("deduction only counts above the standard deduction", () => {
    expect(deductionValue(20_000, 0, 30_000, 0.24)).toBe(0);
    expect(deductionValue(40_000, 0, 30_000, 0.24)).toBeCloseTo(2_400);
    expect(deductionValue(40_000, 40_000, 30_000, 0.24)).toBeCloseTo(9_600);
  });
});

describe("simulatePath", () => {
  it("baseline loan amortizes to zero exactly at the term", () => {
    const s = simulatePath(plain({ extraMonthly: 0 }), INVEST_ALL);
    expect(s.payoffMonth).toBe(360);
    expect(last(s.balance)).toBe(0);
    expect(last(s.interest)).toBeCloseTo(fixedMonthlyPayment(400_000, 0.06, 360) * 360 - 400_000, 4);
  });

  it("every strategy spends the same cash: M + E each month plus the lumps", () => {
    const plan = plain({ lumps: [{ id: "a", month: 25, amount: 60_000 }, { id: "b", month: 200, amount: 500_000 }] });
    const M = fixedMonthlyPayment(400_000, 0.06, 360);
    const total = (M + 500) * 360 + 560_000;
    for (const st of [INVEST_ALL, PREPAY_ALL, PREPAY_EXTRA_ONLY, PREPAY_LUMPS_ONLY]) {
      const s = simulatePath(plan, st);
      expect(last(s.toLoan) + last(s.toInvest)).toBeCloseTo(total, 4);
      // The loan absorbs principal + interest, never more.
      expect(last(s.toLoan)).toBeCloseTo(400_000 + last(s.interest), 4);
    }
  });

  it("investing the extra grows like an annuity while the loan runs", () => {
    const s = simulatePath(plain(), INVEST_ALL);
    expect(last(s.invested)).toBeCloseTo(futureValueOfAnnuity(500, 360, 0.07), 2);
  });

  it("at a 0% return prepaying wins by exactly the interest it saves", () => {
    const plan = plain({ investReturn: 0, lumps: [{ id: "a", month: 13, amount: 100_000 }] });
    const inv = simulatePath(plan, INVEST_ALL);
    const pre = simulatePath(plan, PREPAY_ALL);
    expect(last(pre.netWorth) - last(inv.netWorth)).toBeCloseTo(last(inv.interest) - last(pre.interest), 4);
  });

  it("when the investments earn exactly the mortgage rate, the paths tie at every month", () => {
    const plan = plain({ investReturn: Math.pow(1 + 0.06 / 12, 12) - 1, lumps: [{ id: "a", month: 7, amount: 80_000 }] });
    const inv = simulatePath(plan, INVEST_ALL);
    const pre = simulatePath(plan, PREPAY_ALL);
    for (const m of [1, 6, 7, 60, 120, 240, 360]) expect(inv.netWorth[m]!).toBeCloseTo(pre.netWorth[m]!, 4);
  });

  it("a lump bigger than the balance pays the loan off and the rest is invested", () => {
    const s = simulatePath(plain({ extraMonthly: 0, investReturn: 0, lumps: [{ id: "a", month: 1, amount: 500_000 }] }), PREPAY_ALL);
    expect(s.payoffMonth).toBe(1);
    expect(s.invested[1]).toBeCloseTo(100_000 + fixedMonthlyPayment(400_000, 0.06, 360), 6);
    expect(last(s.interest)).toBe(0);
  });

  it("taxable account: dividends taxed yearly, gains taxed only when sold", () => {
    const base = { extraMonthly: 0, principal: 0, lumps: [{ id: "a", month: 1, amount: 100_000 }], horizonMonths: 120 };
    const free = simulatePath(plain({ ...base }), INVEST_ALL);
    const taxed = simulatePath(plain({ ...base, taxFreeAccount: false, investTaxRate: 0.2, dividendYield: 0 }), INVEST_ALL);
    // No dividends: same pre-tax value, and selling costs 20% of the gain.
    expect(last(taxed.invested)).toBeCloseTo(last(free.invested), 6);
    expect(last(taxed.investedNet)).toBeCloseTo(last(free.invested) - 0.2 * (last(free.invested) - 100_000), 6);
    const unsold = simulatePath(plain({ ...base, taxFreeAccount: false, investTaxRate: 0.2, sellAtHorizon: false }), INVEST_ALL);
    expect(last(unsold.investedNet)).toBeCloseTo(last(free.invested), 6);
    // Dividends: a drag every year, and less left to tax at the end.
    const div = simulatePath(plain({ ...base, taxFreeAccount: false, investTaxRate: 0.2, dividendYield: 0.02 }), INVEST_ALL);
    expect(last(div.invested)).toBeLessThan(last(taxed.invested));
    expect(last(div.dividendTax)).toBeGreaterThan(0);
    expect(last(div.investedNet)).toBeLessThan(last(taxed.investedNet));
    expect(last(div.investedNet)).toBeGreaterThan(last(free.invested) * 0.8);
  });

  it("interest deduction: fully valued when other deductions already pass the standard", () => {
    const plan = plain({ extraMonthly: 0, horizonMonths: 12, deductInterest: true, marginalRate: 0.24, otherItemized: 40_000 });
    const s = simulatePath(plan, INVEST_ALL);
    expect(last(s.deduction)).toBeCloseTo(0.24 * last(s.interest), 6);
  });

  it("interest deduction: worthless when interest + other stays under the standard", () => {
    const s = simulatePath(plain({ principal: 100_000, extraMonthly: 0, deductInterest: true, marginalRate: 0.24 }), INVEST_ALL);
    expect(last(s.deduction)).toBe(0);
  });

  it("interest on the balance above the debt cap is not deductible", () => {
    const plan = plain({ principal: 1_000_000, extraMonthly: 0, horizonMonths: 1, deductInterest: true, marginalRate: 0.3, otherItemized: 100_000 });
    const s = simulatePath(plan, INVEST_ALL);
    expect(last(s.deduction)).toBeCloseTo(0.3 * 1_000_000 * 0.005 * 0.75, 6);
  });

  it("the SALT cap reverting in 2030 shrinks the deduction's value", () => {
    const plan = plain({ startYear: 2029, extraMonthly: 0, horizonMonths: 24, deductInterest: true, marginalRate: 0.24, otherItemized: 40_000, otherItemizedFrom2030: 0 });
    const s = simulatePath(plan, INVEST_ALL);
    const y1 = s.deduction[12]!;
    const y2 = s.deduction[24]! - y1;
    expect(y1).toBeCloseTo(0.24 * s.interest[12]!, 4);
    expect(y2).toBeLessThan(0.24 * (s.interest[24]! - s.interest[12]!) - 1000);
  });
});

describe("comparePrepayVsInvest", () => {
  it("nothing to redirect: both paths are identical", () => {
    const c = comparePrepayVsInvest(plain({ extraMonthly: 0 }));
    expect(c.advantage).toBe(0);
    expect(c.opportunityCost).toEqual([]);
  });

  it("lumps are part of the comparison, each with its own opportunity cost", () => {
    const c = comparePrepayVsInvest(plain({ extraMonthly: 0, lumps: [{ id: "bonus", month: 13, amount: 100_000 }] }), { bonus: "Bonus" });
    expect(c.advantage).toBeGreaterThan(0);
    expect(c.opportunityCost).toHaveLength(1);
    expect(c.opportunityCost[0]!.cost).toBeCloseTo(c.advantage, 6);
    expect(c.matrix.prepayLumpsOnly).toBeCloseTo(c.matrix.prepayAll, 6);
  });

  it("break-even return without taxes is the mortgage rate compounded monthly", () => {
    const be = breakEvenReturn(plain({ lumps: [{ id: "a", month: 50, amount: 50_000 }] }));
    expect(be).not.toBeNull();
    expect(be!).toBeCloseTo(Math.pow(1.005, 12) - 1, 5);
  });

  it("sensitivity crosses zero at the break-even return", () => {
    const c = comparePrepayVsInvest(plain());
    const below = c.sensitivity.filter((p) => p.rate < c.breakEvenReturn! - 1e-6);
    const above = c.sensitivity.filter((p) => p.rate > c.breakEvenReturn! + 1e-6);
    expect(below.every((p) => p.advantage < 0)).toBe(true);
    expect(above.every((p) => p.advantage > 0)).toBe(true);
  });

  it("deducting interest favors investing; taxing returns favors prepaying", () => {
    const base = comparePrepayVsInvest(plain()).advantage;
    const deduct = comparePrepayVsInvest(plain({ deductInterest: true, marginalRate: 0.24, otherItemized: 40_000, otherItemizedFrom2030: 40_000 })).advantage;
    const taxed = comparePrepayVsInvest(plain({ taxFreeAccount: false, investTaxRate: 0.188, dividendYield: 0.015 })).advantage;
    expect(deduct).toBeGreaterThan(base);
    expect(taxed).toBeLessThan(base);
  });

  it("an early horizon compares the paths mid-loan", () => {
    const c = comparePrepayVsInvest(plain({ horizonMonths: 60 }));
    expect(c.horizonMonths).toBe(60);
    expect(c.prepay.balance[60]!).toBeLessThan(c.invest.balance[60]!);
    expect(c.advantage).toBeCloseTo(c.invest.netWorth[60]! - c.prepay.netWorth[60]!, 6);
  });
});

describe("monteCarlo", () => {
  it("with no volatility every path is the expected one", () => {
    const plan = plain({ lumps: [{ id: "a", month: 13, amount: 50_000 }] });
    const mc = monteCarlo(plan, 0, 20);
    const c = comparePrepayVsInvest(plan);
    const h = mc.bands[mc.bands.length - 1]!;
    expect(h.p10).toBeCloseTo(c.advantage, 4);
    expect(h.p90).toBeCloseTo(c.advantage, 4);
    expect(mc.chanceInvestWins).toBe(1);
  });

  it("is deterministic for a seed and spreads with volatility", () => {
    const plan = plain();
    const a = monteCarlo(plan, 0.16, 200);
    const b = monteCarlo(plan, 0.16, 200);
    expect(a).toEqual(b);
    const h = a.bands[a.bands.length - 1]!;
    expect(h.p90).toBeGreaterThan(h.p50);
    expect(h.p50).toBeGreaterThan(h.p10);
    expect(a.chanceInvestWins).toBeGreaterThan(0);
    expect(a.chanceInvestWins).toBeLessThan(1);
  });
});
