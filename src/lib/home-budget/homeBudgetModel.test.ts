import { describe, expect, it } from "vitest";
import {
  cashForHomeFromNetWorth,
  computeBudgetScenario,
  computeLenderMax,
  computeMaxApproval,
  computeRentVsBuy,
  computeSensitivityCell,
  defaultHomeBudgetInputs,
  monthlyPaymentOnLoan,
  priceForHousingShare,
  sensitivityAxes,
  simulateRentVsBuy,
} from "./homeBudgetModel";

describe("computeMaxApproval", () => {
  it("solves the default inputs (regression)", () => {
    const ins = defaultHomeBudgetInputs();
    const m = computeMaxApproval(ins);
    expect(m.impliedMaxHomeValue).toBeGreaterThan(545_000);
    expect(m.impliedMaxHomeValue).toBeLessThan(560_000);
    expect(m.monthlyTotalHousing).toBeGreaterThan(4450);
    expect(m.monthlyTotalHousing).toBeLessThan(4550);
    expect(m.impliedMaxLoan).toBeGreaterThan(450_000);
    expect(m.impliedMaxLoan).toBeLessThan(465_000);
  });

  it("spends exactly the cash for the home and hits the housing cap", () => {
    const ins = defaultHomeBudgetInputs();
    const m = computeMaxApproval(ins);
    const spent = m.impliedDownPayment + m.impliedMaxHomeValue * (ins.closingCostsPctOfHomePrice + ins.renovationPctOfHomePrice);
    expect(spent).toBeCloseTo(ins.cashForHome, 2);
    expect(m.impliedMaxHomeValue - m.impliedDownPayment).toBeCloseTo(m.impliedMaxLoan, 2);
    expect(m.monthlyTotalHousing).toBeCloseTo(m.maxHousingBudgetMonthly, 2);
  });
});

describe("computeBudgetScenario", () => {
  it("discretionary money when the budget home is the max approval at its implied down % (regression)", () => {
    const ins = defaultHomeBudgetInputs();
    const max = computeMaxApproval(ins);
    ins.budgetHomePrice = max.impliedMaxHomeValue;
    ins.budgetDownPaymentPct = max.downPaymentPctOfHome;
    const b = computeBudgetScenario(ins);
    expect(b.remainingDiscretionaryMonthly).toBeGreaterThan(2550);
    expect(b.remainingDiscretionaryMonthly).toBeLessThan(2700);
    // At max approval the cash is used up exactly.
    expect(b.cashSurplus).toBeCloseTo(0, 2);
  });

  it("totals the cash needed", () => {
    const ins = { ...defaultHomeBudgetInputs(), budgetHomePrice: 1_000_000, budgetDownPaymentPct: 0.2, closingCostsPctOfHomePrice: 0.03, renovationPctOfHomePrice: 0.02, cashForHome: 200_000 };
    const b = computeBudgetScenario(ins);
    expect(b.cashNeeded).toBeCloseTo(250_000, 6);
    expect(b.cashSurplus).toBeCloseTo(-50_000, 6);
  });
});

describe("computeRentVsBuy", () => {
  it("produces Buy vs Rent label consistent with advantage sign", () => {
    const ins = defaultHomeBudgetInputs();
    const b = computeBudgetScenario(ins);
    const r = computeRentVsBuy(ins, b);
    expect(r.rentOrBuyLabel).toBe(r.advantageToBuy > 0 ? "Buy" : "Rent");
  });

  it("components add up to the monthly ownership cost", () => {
    const ins = { ...defaultHomeBudgetInputs(), hoaMonthly: 300, annualMortgageInsuranceRateOnLoan: 0.005 };
    const r = computeRentVsBuy(ins, computeBudgetScenario(ins));
    expect(r.components.reduce((s, c) => s + c.monthly, 0)).toBeCloseTo(r.monthlyCostOfHomeOwnership, 6);
  });
});

describe("simulateRentVsBuy", () => {
  it("pays the loan off on schedule", () => {
    const ins = { ...defaultHomeBudgetInputs(), mortgageTermYears: 15, horizonYears: 15 };
    const sim = simulateRentVsBuy(ins, computeBudgetScenario(ins));
    expect(sim.years).toHaveLength(15);
    expect(sim.years.at(-1)!.loanBalance).toBeLessThan(0.01);
  });

  it("with no growth, no returns and no costs, buying for cash equals renting at zero rent", () => {
    const ins = {
      ...defaultHomeBudgetInputs(),
      budgetDownPaymentPct: 1,
      closingCostsPctOfHomePrice: 0,
      renovationPctOfHomePrice: 0,
      annualPropertyTaxRate: 0,
      annualInsuranceRateOnValue: 0,
      annualMaintenanceRate: 0,
      hoaMonthly: 0,
      marketRentMonthly: 0,
      homeAppreciationRate: 0,
      investmentReturnRate: 0,
      sellingCostsPct: 0,
      horizonYears: 5,
    };
    const sim = simulateRentVsBuy(ins, computeBudgetScenario(ins));
    for (const y of sim.years) expect(y.buyAdvantage).toBeCloseTo(0, 6);
    expect(sim.years[0]!.renterWealth).toBeCloseTo(ins.budgetHomePrice, 6);
  });

  it("matches a hand calculation for one year", () => {
    // $500k home, 20% down, no closing/reno; 6% loan, 30 years; rent $2,000; 0% growth/returns.
    const ins = {
      ...defaultHomeBudgetInputs(),
      budgetHomePrice: 500_000,
      budgetDownPaymentPct: 0.2,
      closingCostsPctOfHomePrice: 0,
      renovationPctOfHomePrice: 0,
      annualPropertyTaxRate: 0.012,
      annualInsuranceRateOnValue: 0,
      annualMaintenanceRate: 0,
      hoaMonthly: 0,
      marketRentMonthly: 2000,
      homeAppreciationRate: 0,
      investmentReturnRate: 0,
      sellingCostsPct: 0,
      rentGrowthRate: 0,
      horizonYears: 1,
    };
    const b = computeBudgetScenario(ins);
    const sim = simulateRentVsBuy(ins, b);
    const pmt = monthlyPaymentOnLoan(400_000, 0.06, 30);
    // Balance after 12 payments.
    const r = 0.005;
    const bal = 400_000 * Math.pow(1 + r, 12) - pmt * ((Math.pow(1 + r, 12) - 1) / r);
    const ownerMonthly = pmt + 500;
    const y1 = sim.years[0]!;
    expect(y1.loanBalance).toBeCloseTo(bal, 4);
    expect(y1.buyerWealth).toBeCloseTo(500_000 - bal, 4);
    expect(y1.renterWealth).toBeCloseTo(100_000 + 12 * (ownerMonthly - 2000), 4);
  });

  it("taxes only the home gain above the exclusion", () => {
    const base = {
      ...defaultHomeBudgetInputs(),
      budgetDownPaymentPct: 1,
      budgetHomePrice: 1_000_000,
      closingCostsPctOfHomePrice: 0,
      renovationPctOfHomePrice: 0,
      sellingCostsPct: 0,
      homeAppreciationRate: 1, // doubles in a year
      horizonYears: 1,
    };
    const withEx = simulateRentVsBuy({ ...base, homeSaleExclusion: 500_000 }, computeBudgetScenario(base)).years[0]!;
    const noEx = simulateRentVsBuy({ ...base, homeSaleExclusion: 0 }, computeBudgetScenario(base)).years[0]!;
    expect(withEx.buyerWealth - noEx.buyerWealth).toBeCloseTo(0.2 * 500_000, 4);
  });
});

describe("sensitivity grid", () => {
  it("is finite for corner cells", () => {
    const ins = defaultHomeBudgetInputs();
    const v = computeSensitivityCell(125_000, 900_000, ins);
    expect(Number.isFinite(v)).toBe(true);
  });

  it("centers its axes on the budget price and salary", () => {
    const ins = defaultHomeBudgetInputs();
    const { homePrices, incomes } = sensitivityAxes(ins);
    expect(homePrices).toHaveLength(11);
    expect(homePrices[5]).toBe(500_000);
    expect(incomes).toHaveLength(7);
    expect(incomes[3]).toBe(150_000);
  });
});

describe("cashForHomeFromNetWorth", () => {
  it("haircuts the gain for tax, then takes the share", () => {
    const r = cashForHomeFromNetWorth({ liquid: 500_000, gain: 100_000, taxRate: 0.2, share: 0.8 });
    expect(r.taxOnGain).toBe(20_000);
    expect(r.afterTax).toBe(480_000);
    expect(r.available).toBe(384_000);
  });
});

describe("priceForHousingShare", () => {
  it("lands monthly housing exactly on the share of gross", () => {
    const ins = { ...defaultHomeBudgetInputs(), hoaMonthly: 300, annualMortgageInsuranceRateOnLoan: 0.005 };
    for (const share of [0.28, 0.36, 0.43]) {
      const price = priceForHousingShare(ins, share, 0.15);
      const b = computeBudgetScenario({ ...ins, budgetHomePrice: price, budgetDownPaymentPct: 0.15 });
      expect(b.housingPctOfGrossIncome).toBeCloseTo(share, 6);
    }
  });

  it("is never negative when fixed bills exceed the share", () => {
    const ins = { ...defaultHomeBudgetInputs(), annualHouseholdSalary: 10_000 };
    expect(priceForHousingShare(ins, 0.28)).toBe(0);
  });
});

describe("mortgage insurance", () => {
  const ins = { ...defaultHomeBudgetInputs(), annualMortgageInsuranceRateOnLoan: 0.006 };

  it("applies only under 20% down", () => {
    expect(computeBudgetScenario({ ...ins, budgetDownPaymentPct: 0.25 }).monthlyMortgageInsurance).toBe(0);
    expect(computeBudgetScenario({ ...ins, budgetDownPaymentPct: 0.2 }).monthlyMortgageInsurance).toBe(0);
    const ten = computeBudgetScenario({ ...ins, budgetDownPaymentPct: 0.1 });
    expect(ten.monthlyMortgageInsurance).toBeCloseTo((ten.loanAmount * 0.006) / 12, 6);
  });

  it("leaves a max with 20%+ down unchanged", () => {
    // Enough cash for well over 20% down at the max, so the rate shouldn't move it.
    const rich = { ...ins, cashForHome: 250_000 };
    const m = computeMaxApproval(rich);
    expect(m.downPaymentPctOfHome).toBeGreaterThan(0.2);
    expect(m.monthlyMortgageInsurance).toBe(0);
    expect(m.impliedMaxHomeValue).toBeCloseTo(computeMaxApproval({ ...rich, annualMortgageInsuranceRateOnLoan: 0 }).impliedMaxHomeValue, 2);
  });

  it("is never charged in the simulation at 20%+ down", () => {
    const at21 = { ...ins, budgetDownPaymentPct: 0.21 };
    const none = { ...at21, annualMortgageInsuranceRateOnLoan: 0 };
    expect(simulateRentVsBuy(at21, computeBudgetScenario(at21), 1).years[0]!.ownerMonthlyCost).toBeCloseTo(
      simulateRentVsBuy(none, computeBudgetScenario(none), 1).years[0]!.ownerMonthlyCost,
      6,
    );
  });
});

describe("computeLenderMax", () => {
  it("counts only lender costs, so it sits above the all-in max at the same share", () => {
    const ins = { ...defaultHomeBudgetInputs(), lenderMaxDti: 0.36 };
    const lender = computeLenderMax(ins, ins.annualHouseholdSalary);
    const comfort = computeMaxApproval(ins);
    expect(lender.impliedMaxHomeValue).toBeGreaterThan(comfort.impliedMaxHomeValue);
    // Loan payment + tax + insurance land on 36% of gross.
    const counted = lender.monthlyMortgagePayment + lender.monthlyPropertyTax + lender.monthlyInsurance;
    expect(counted).toBeCloseTo((ins.annualHouseholdSalary / 12) * 0.36, 2);
    expect(lender.monthlyMaintenance).toBe(0);
  });

  it("rises with counted bonus", () => {
    const ins = defaultHomeBudgetInputs();
    expect(computeLenderMax(ins, ins.annualHouseholdSalary + 30_000).impliedMaxHomeValue).toBeGreaterThan(computeLenderMax(ins, ins.annualHouseholdSalary).impliedMaxHomeValue);
  });
});

describe("renter setup", () => {
  it("the renter spends half the renovation budget and invests the rest", () => {
    const ins = { ...defaultHomeBudgetInputs(), investmentReturnRate: 0, marketRentMonthly: 0, horizonYears: 1 };
    const b = computeBudgetScenario(ins);
    const sim = simulateRentVsBuy(ins, b);
    expect(sim.renterSetup).toBeCloseTo(b.renovationDollars / 2, 6);
    const noSetup = simulateRentVsBuy({ ...ins, renovationPctOfHomePrice: 0 }, computeBudgetScenario({ ...ins, renovationPctOfHomePrice: 0 }));
    expect(noSetup.renterSetup).toBe(0);
  });
});
