/**
 * Home purchase / housing budget model — parity with "Home Budget" sheet in Monthly Budget v11.xlsx.
 * Max approval uses simultaneous down-payment (cash − reno − closing as % of home) and loan sizing.
 * The rent-vs-buy simulation (simulateRentVsBuy) goes beyond the sheet: wealth year by year.
 */

export type HomeBudgetInputs = {
  annualHouseholdSalary: number;
  /** D5: housing cost cap as fraction of gross (e.g. 0.36) */
  housingCostMaxOfGross: number;
  mortgageTermYears: number;
  annualMortgageRate: number;
  annualPropertyTaxRate: number;
  annualMaintenanceRate: number;
  annualInsuranceRateOnValue: number;
  annualMortgageInsuranceRateOnLoan: number;
  hoaMonthly: number;
  utilitiesMonthly: number;
  /**
   * Cash the household will put into the purchase: down payment, closing and renovation
   * together (the sheet's D26 liquid cash + D27 emergency holdback). The page defaults it
   * to a share of after-tax liquid net worth from the Book.
   */
  cashForHome: number;
  renovationPctOfHomePrice: number;
  closingCostsPctOfHomePrice: number;
  /** Budget scenario: home price (H3) */
  budgetHomePrice: number;
  /** Budget scenario: down payment as fraction of home price (e.g. 0.25) */
  budgetDownPaymentPct: number;
  /** Household budget: marginal income tax rate on HHI (G21) */
  incomeTaxRate: number;
  /** Minimum monthly savings target (positive number; treated as cash out) */
  minimumMonthlySavings: number;
  /** Rent vs buy — market rent (K28) */
  marketRentMonthly: number;
  /** Rent vs buy — equity risk premium for opportunity-cost stack (K10) */
  equityRiskPremium: number;
  /** Rent vs buy over time: annual rent increase. */
  rentGrowthRate: number;
  /** Annual home price appreciation. */
  homeAppreciationRate: number;
  /** Lender view: the most a lender lets the loan payment, tax, insurance, HOA and mortgage insurance take of gross income. */
  lenderMaxDti: number;
  /** Annual return on money invested instead (before tax on gains). */
  investmentReturnRate: number;
  /** Agent + transfer costs when the home is sold, as a fraction of its value then. */
  sellingCostsPct: number;
  /** Years until the home would be sold. */
  horizonYears: number;
  /** Long-term capital gains rate: on investment gains, and on a home gain above the exclusion. */
  capitalGainsTaxRate: number;
  /** Home-sale gain excluded from tax (§121: $500k married filing jointly, $250k single). */
  homeSaleExclusion: number;
};

export type MaxApprovalResult = {
  impliedMaxLoan: number;
  impliedDownPayment: number;
  impliedMaxHomeValue: number;
  downPaymentPctOfHome: number;
  monthlyMortgagePayment: number;
  monthlyInsurance: number;
  monthlyPropertyTax: number;
  monthlyMaintenance: number;
  monthlyMortgageInsurance: number;
  monthlyTotalHousing: number;
  monthlyIncome: number;
  maxHousingBudgetMonthly: number;
};

export type BudgetScenarioResult = {
  homePrice: number;
  loanAmount: number;
  downPaymentDollars: number;
  downPaymentPct: number;
  monthlyMortgagePayment: number;
  monthlyInsurance: number;
  monthlyHoa: number;
  monthlyUtilities: number;
  monthlyPropertyTax: number;
  monthlyMaintenance: number;
  monthlyMortgageInsurance: number;
  monthlyTotalHousing: number;
  housingPctOfGrossIncome: number;
  withinBackEndCap: boolean;
  monthlyIncome: number;
  incomeTaxMonthly: number;
  remainingDiscretionaryMonthly: number;
  closingCostsDollars: number;
  renovationDollars: number;
  /** Down payment + closing + renovation. */
  cashNeeded: number;
  /** cashForHome − cashNeeded (negative = short). */
  cashSurplus: number;
};

export type RentVsBuyResult = {
  monthlyCostOfHomeOwnership: number;
  marketRentMonthly: number;
  advantageToBuy: number;
  rentOrBuyLabel: "Buy" | "Rent";
  totalCostOfHomeOwnershipAnnualPct: number;
  /** Each component of totalCostOfHomeOwnershipAnnualPct, in dollars per month. */
  components: { key: string; label: string; monthly: number }[];
};

const DEFAULTS: HomeBudgetInputs = {
  annualHouseholdSalary: 150_000,
  housingCostMaxOfGross: 0.36,
  mortgageTermYears: 30,
  annualMortgageRate: 0.06,
  annualPropertyTaxRate: 0.012,
  annualMaintenanceRate: 0.01,
  annualInsuranceRateOnValue: 0.0075,
  annualMortgageInsuranceRateOnLoan: 0,
  hoaMonthly: 0,
  utilitiesMonthly: 400,
  cashForHome: 150_000,
  renovationPctOfHomePrice: 0.05,
  closingCostsPctOfHomePrice: 0.05,
  budgetHomePrice: 500_000,
  budgetDownPaymentPct: 0.25,
  incomeTaxRate: 0.35,
  minimumMonthlySavings: 1000,
  marketRentMonthly: 2500,
  equityRiskPremium: 0.05,
  rentGrowthRate: 0.03,
  homeAppreciationRate: 0.035,
  investmentReturnRate: 0.07,
  lenderMaxDti: 0.43,
  sellingCostsPct: 0.06,
  horizonYears: 10,
  capitalGainsTaxRate: 0.2,
  homeSaleExclusion: 500_000,
};

export function defaultHomeBudgetInputs(): HomeBudgetInputs {
  return { ...DEFAULTS };
}

export function monthlyPaymentOnLoan(
  loan: number,
  annualRate: number,
  termYears: number,
): number {
  const r = annualRate / 12;
  const n = termYears * 12;
  if (loan <= 0) return 0;
  if (r === 0) return loan / n;
  return (loan * r) / (1 - Math.pow(1 + r, -n));
}

/** Lenders charge mortgage insurance only when the loan is over 80% of the home's value (under 20% down). */
export const MORTGAGE_INSURANCE_ABOVE_LTV = 0.8;

const needsMortgageInsurance = (loan: number, homeValue: number) => loan > MORTGAGE_INSURANCE_ABOVE_LTV * homeValue + 1e-6;

function nonMortgageMonthly(
  homeValue: number,
  loan: number,
  ins: HomeBudgetInputs,
): number {
  return (
    (homeValue * ins.annualInsuranceRateOnValue) / 12 +
    ins.hoaMonthly +
    ins.utilitiesMonthly +
    (homeValue * ins.annualPropertyTaxRate) / 12 +
    (homeValue * ins.annualMaintenanceRate) / 12 +
    (needsMortgageInsurance(loan, homeValue) ? (loan * ins.annualMortgageInsuranceRateOnLoan) / 12 : 0)
  );
}

/**
 * Cash available for down payment after % of purchase for reno + closing.
 * D30 = D26 + D27 + D28 + D29 with D26 + D27 = cashForHome and D28/D29 = −pct × home value.
 */
function downPaymentFromHomeValue(homeValue: number, ins: HomeBudgetInputs): number {
  const reno = ins.renovationPctOfHomePrice * homeValue;
  const closing = ins.closingCostsPctOfHomePrice * homeValue;
  return ins.cashForHome - reno - closing;
}

function homeValueFromLoan(loan: number, ins: HomeBudgetInputs): number {
  const pctOutOfPocket =
    ins.renovationPctOfHomePrice + ins.closingCostsPctOfHomePrice;
  return (loan + ins.cashForHome) / (1 + pctOutOfPocket);
}

function residualLoanEquation(loan: number, ins: HomeBudgetInputs): number {
  const monthlyIncome = ins.annualHouseholdSalary / 12;
  const maxHousing = monthlyIncome * ins.housingCostMaxOfGross;
  const hv = homeValueFromLoan(loan, ins);
  const pmt = monthlyPaymentOnLoan(loan, ins.annualMortgageRate, ins.mortgageTermYears);
  const other = nonMortgageMonthly(hv, loan, ins);
  const maxAffordablePmt = Math.max(0, maxHousing - other);
  return pmt - maxAffordablePmt;
}

/**
 * Solve for loan where amortizing payment equals max housing minus non-mortgage costs.
 */
export function computeMaxApproval(ins: HomeBudgetInputs): MaxApprovalResult {
  const monthlyIncome = ins.annualHouseholdSalary / 12;
  const maxHousingBudgetMonthly = monthlyIncome * ins.housingCostMaxOfGross;

  let lo = 0;
  let hi = ins.annualHouseholdSalary * 20;
  if (residualLoanEquation(hi, ins) < 0) {
    hi = ins.annualHouseholdSalary * 40;
  }
  let rLo = residualLoanEquation(lo, ins);
  let rHi = residualLoanEquation(hi, ins);
  if (rHi < 0) {
    const impliedMaxLoan = 0;
    const impliedMaxHomeValue = homeValueFromLoan(0, ins);
    return buildMaxResult(
      impliedMaxLoan,
      impliedMaxHomeValue,
      ins,
      monthlyIncome,
      maxHousingBudgetMonthly,
    );
  }
  for (let i = 0; i < 80 && rLo * rHi > 0; i++) {
    hi *= 1.5;
    rHi = residualLoanEquation(hi, ins);
  }
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const rMid = residualLoanEquation(mid, ins);
    if (Math.abs(rMid) < 1e-4) {
      lo = hi = mid;
      break;
    }
    if (rMid * rLo > 0) {
      lo = mid;
      rLo = rMid;
    } else {
      hi = mid;
      rHi = rMid;
    }
  }
  const impliedMaxLoan = (lo + hi) / 2;
  const impliedMaxHomeValue = homeValueFromLoan(impliedMaxLoan, ins);
  return buildMaxResult(
    impliedMaxLoan,
    impliedMaxHomeValue,
    ins,
    monthlyIncome,
    maxHousingBudgetMonthly,
  );
}

function buildMaxResult(
  impliedMaxLoan: number,
  impliedMaxHomeValue: number,
  ins: HomeBudgetInputs,
  monthlyIncome: number,
  maxHousingBudgetMonthly: number,
): MaxApprovalResult {
  const impliedDownPayment = downPaymentFromHomeValue(impliedMaxHomeValue, ins);
  const monthlyMortgagePayment = monthlyPaymentOnLoan(
    impliedMaxLoan,
    ins.annualMortgageRate,
    ins.mortgageTermYears,
  );
  const monthlyInsurance =
    (impliedMaxHomeValue * ins.annualInsuranceRateOnValue) / 12;
  const monthlyPropertyTax =
    (impliedMaxHomeValue * ins.annualPropertyTaxRate) / 12;
  const monthlyMaintenance =
    (impliedMaxHomeValue * ins.annualMaintenanceRate) / 12;
  const monthlyMortgageInsurance = needsMortgageInsurance(impliedMaxLoan, impliedMaxHomeValue)
    ? (impliedMaxLoan * ins.annualMortgageInsuranceRateOnLoan) / 12
    : 0;
  const monthlyTotalHousing =
    monthlyMortgagePayment +
    monthlyInsurance +
    ins.hoaMonthly +
    ins.utilitiesMonthly +
    monthlyPropertyTax +
    monthlyMaintenance +
    monthlyMortgageInsurance;

  return {
    impliedMaxLoan,
    impliedDownPayment,
    impliedMaxHomeValue,
    downPaymentPctOfHome:
      impliedMaxHomeValue > 0 ? impliedDownPayment / impliedMaxHomeValue : 0,
    monthlyMortgagePayment,
    monthlyInsurance,
    monthlyPropertyTax,
    monthlyMaintenance,
    monthlyMortgageInsurance,
    monthlyTotalHousing,
    monthlyIncome,
    maxHousingBudgetMonthly,
  };
}

export function computeBudgetScenario(
  ins: HomeBudgetInputs,
): BudgetScenarioResult {
  const monthlyIncome = ins.annualHouseholdSalary / 12;
  const homePrice = ins.budgetHomePrice;
  const downPaymentDollars = homePrice * ins.budgetDownPaymentPct;
  const loanAmount = Math.max(0, homePrice - downPaymentDollars);
  const monthlyMortgagePayment = monthlyPaymentOnLoan(
    loanAmount,
    ins.annualMortgageRate,
    ins.mortgageTermYears,
  );
  const monthlyInsurance = (homePrice * ins.annualInsuranceRateOnValue) / 12;
  const monthlyPropertyTax = (homePrice * ins.annualPropertyTaxRate) / 12;
  const monthlyMaintenance = (homePrice * ins.annualMaintenanceRate) / 12;
  const monthlyMortgageInsurance = needsMortgageInsurance(loanAmount, homePrice)
    ? (loanAmount * ins.annualMortgageInsuranceRateOnLoan) / 12
    : 0;
  const monthlyTotalHousing =
    monthlyMortgagePayment +
    monthlyInsurance +
    ins.hoaMonthly +
    ins.utilitiesMonthly +
    monthlyPropertyTax +
    monthlyMaintenance +
    monthlyMortgageInsurance;
  const maxHousing = monthlyIncome * ins.housingCostMaxOfGross;
  const closingCostsDollars = homePrice * ins.closingCostsPctOfHomePrice;
  const renovationDollars = homePrice * ins.renovationPctOfHomePrice;
  const cashNeeded = downPaymentDollars + closingCostsDollars + renovationDollars;
  return {
    homePrice,
    loanAmount,
    downPaymentDollars,
    downPaymentPct: ins.budgetDownPaymentPct,
    monthlyMortgagePayment,
    monthlyInsurance,
    monthlyHoa: ins.hoaMonthly,
    monthlyUtilities: ins.utilitiesMonthly,
    monthlyPropertyTax,
    monthlyMaintenance,
    monthlyMortgageInsurance,
    monthlyTotalHousing,
    housingPctOfGrossIncome:
      monthlyIncome > 0 ? monthlyTotalHousing / monthlyIncome : 0,
    withinBackEndCap: monthlyTotalHousing <= maxHousing + 1e-6,
    monthlyIncome,
    incomeTaxMonthly: monthlyIncome * ins.incomeTaxRate,
    remainingDiscretionaryMonthly:
      monthlyIncome -
      monthlyTotalHousing -
      monthlyIncome * ins.incomeTaxRate -
      ins.minimumMonthlySavings,
    closingCostsDollars,
    renovationDollars,
    cashNeeded,
    cashSurplus: ins.cashForHome - cashNeeded,
  };
}

/**
 * Home price at which all-in monthly housing (as in computeBudgetScenario) is `share` of
 * gross pay, at a fixed down-payment percentage. Housing cost is linear in the price —
 * every part scales with it except utilities and HOA — so this is solved directly.
 */
export function priceForHousingShare(
  ins: HomeBudgetInputs,
  share: number,
  downPct = ins.budgetDownPaymentPct,
): number {
  const loanPerDollar = Math.max(0, 1 - downPct);
  const perDollar =
    monthlyPaymentOnLoan(loanPerDollar, ins.annualMortgageRate, ins.mortgageTermYears) +
    (ins.annualPropertyTaxRate + ins.annualInsuranceRateOnValue + ins.annualMaintenanceRate) / 12 +
    (loanPerDollar > MORTGAGE_INSURANCE_ABOVE_LTV + 1e-9 ? (loanPerDollar * ins.annualMortgageInsuranceRateOnLoan) / 12 : 0);
  const room = (share * ins.annualHouseholdSalary) / 12 - ins.hoaMonthly - ins.utilitiesMonthly;
  return perDollar > 0 ? Math.max(0, room / perDollar) : 0;
}

/**
 * The lender's view: the most a lender would likely lend toward. It counts only what a
 * lender holds against income — loan payment, property tax, insurance, HOA and mortgage
 * insurance (no utilities or upkeep) — up to `lenderMaxDti` of `annualIncome` (base pay,
 * plus bonus when counted). Same solver as the comfort view, all the cash for the home in.
 */
export function computeLenderMax(ins: HomeBudgetInputs, annualIncome: number): MaxApprovalResult {
  return computeMaxApproval({
    ...ins,
    annualHouseholdSalary: annualIncome,
    housingCostMaxOfGross: ins.lenderMaxDti,
    utilitiesMonthly: 0,
    annualMaintenanceRate: 0,
  });
}

/**
 * Illustrative column: total annual ownership cost as % of value (SUM of annualized components K17:K25 style).
 */
export function computeRentVsBuy(
  ins: HomeBudgetInputs,
  budget: BudgetScenarioResult,
): RentVsBuyResult {
  const homePrice = budget.homePrice;
  const simpleAnnualInterestPct =
    homePrice > 0 ? ((homePrice - budget.downPaymentDollars) * ins.annualMortgageRate) / homePrice : 0;
  const annualHoa = ins.hoaMonthly * 12;
  const annualMi = budget.monthlyMortgageInsurance * 12;
  const closingOpportunity = ins.equityRiskPremium * ins.closingCostsPctOfHomePrice;
  const dpRenoOpportunity =
    homePrice > 0
      ? ((budget.downPaymentDollars + ins.renovationPctOfHomePrice * homePrice) *
          ins.equityRiskPremium) /
        homePrice
      : 0;
  const parts: { key: string; label: string; pct: number }[] = [
    { key: "interest", label: "Mortgage interest", pct: simpleAnnualInterestPct },
    { key: "tax", label: "Property tax", pct: ins.annualPropertyTaxRate },
    { key: "maint", label: "Maintenance", pct: ins.annualMaintenanceRate },
    { key: "ins", label: "Insurance", pct: ins.annualInsuranceRateOnValue },
    { key: "hoa", label: "HOA", pct: homePrice > 0 ? annualHoa / homePrice : 0 },
    { key: "mi", label: "Mortgage insurance", pct: homePrice > 0 ? annualMi / homePrice : 0 },
    { key: "oppClosing", label: "Opportunity cost · closing", pct: closingOpportunity },
    { key: "oppEquity", label: "Opportunity cost · down + reno", pct: dpRenoOpportunity },
  ];
  const totalAnnualPct = parts.reduce((s, p) => s + p.pct, 0);

  const monthlyCostOfHomeOwnership = (homePrice * totalAnnualPct) / 12;
  const advantageToBuy = ins.marketRentMonthly - monthlyCostOfHomeOwnership;
  return {
    monthlyCostOfHomeOwnership,
    marketRentMonthly: ins.marketRentMonthly,
    advantageToBuy,
    rentOrBuyLabel: advantageToBuy > 0 ? "Buy" : "Rent",
    totalCostOfHomeOwnershipAnnualPct: totalAnnualPct,
    components: parts.map((p) => ({ key: p.key, label: p.label, monthly: (homePrice * p.pct) / 12 })),
  };
}

export type RentVsBuyYear = {
  year: number;
  homeValue: number;
  loanBalance: number;
  /** Owner's monthly cash cost in the year's last month (mortgage, tax, insurance, upkeep, HOA, MI). */
  ownerMonthlyCost: number;
  rentMonthly: number;
  /** After selling the home (selling costs, tax on gain over the exclusion) and cashing out investments. */
  buyerWealth: number;
  renterWealth: number;
  /** buyerWealth − renterWealth. */
  buyAdvantage: number;
};

export type RentVsBuySimulation = {
  years: RentVsBuyYear[];
  /** First year-end from which buying stays ahead through the whole run, if any. */
  breakEvenYear: number | null;
  /** Cash the buyer puts in on day one; the renter invests it, less `renterSetup`. */
  upfrontCash: number;
  /** What the renter spends on day one on moving and furniture. */
  renterSetup: number;
};

/** A renter still moves and furnishes, on a smaller scale: this share of the buyer's renovation / furnishing budget. */
export const RENTER_SETUP_SHARE = 0.5;

/**
 * Two households with the same cash and the same monthly budget, one buying the budget
 * home and one renting, run month by month. Day one: the buyer pays down payment,
 * closing and renovation; the renter spends half the renovation budget on moving and
 * furniture (RENTER_SETUP_SHARE) and invests the rest. Each month whoever spends less on
 * housing invests the difference. Rent steps up yearly; the home (and the property tax,
 * insurance and maintenance priced off it) appreciates monthly; mortgage insurance applies
 * only to a loan over 80% of the price and stops once the balance reaches 78% of it. At each year-end both
 * liquidate: the buyer sells (selling costs; tax on the gain above the exclusion, basis =
 * price + renovation) and both pay capital-gains tax on their investment gains.
 * Utilities are left out (both households pay them); the mortgage-interest deduction is
 * ignored.
 */
export function simulateRentVsBuy(
  ins: HomeBudgetInputs,
  budget: BudgetScenarioResult,
  maxYears = Math.max(1, Math.round(ins.horizonYears)),
): RentVsBuySimulation {
  const price = budget.homePrice;
  const loan0 = budget.loanAmount;
  const upfrontCash = budget.downPaymentDollars + budget.closingCostsDollars + budget.renovationDollars;
  const pmt = monthlyPaymentOnLoan(loan0, ins.annualMortgageRate, ins.mortgageTermYears);
  const mRate = ins.annualMortgageRate / 12;
  const termMonths = Math.round(ins.mortgageTermYears * 12);
  const invM = Math.pow(1 + ins.investmentReturnRate, 1 / 12) - 1;
  const appM = Math.pow(1 + ins.homeAppreciationRate, 1 / 12) - 1;
  const homeBasis = price + budget.renovationDollars;
  const renterSetup = RENTER_SETUP_SHARE * budget.renovationDollars;
  const insured = needsMortgageInsurance(loan0, price);

  let home = price;
  let balance = loan0;
  let rent = ins.marketRentMonthly;
  // Investment accounts: value and money put in (basis).
  const renter = { value: upfrontCash - renterSetup, basis: upfrontCash - renterSetup };
  const buyer = { value: 0, basis: 0 };
  const afterTax = (a: { value: number; basis: number }) =>
    a.value - ins.capitalGainsTaxRate * Math.max(0, a.value - a.basis);

  const years: RentVsBuyYear[] = [];
  let ownerCost = 0;
  for (let m = 1; m <= maxYears * 12; m++) {
    if (m > 1 && (m - 1) % 12 === 0) rent *= 1 + ins.rentGrowthRate;
    // Start-of-month: carrying costs priced off this month's home value.
    const carrying =
      (home * (ins.annualPropertyTaxRate + ins.annualInsuranceRateOnValue + ins.annualMaintenanceRate)) / 12 +
      ins.hoaMonthly +
      (insured && balance > 0.78 * price + 1e-9 ? (loan0 * ins.annualMortgageInsuranceRateOnLoan) / 12 : 0);
    let mortgage = 0;
    if (m <= termMonths && balance > 0) {
      const interest = balance * mRate;
      mortgage = Math.min(pmt, balance + interest);
      balance = Math.max(0, balance + interest - mortgage);
    }
    ownerCost = mortgage + carrying;
    // Grow last month's money, then add this month's difference.
    renter.value *= 1 + invM;
    buyer.value *= 1 + invM;
    const diff = ownerCost - rent;
    if (diff > 0) {
      renter.value += diff;
      renter.basis += diff;
    } else {
      buyer.value -= diff;
      buyer.basis -= diff;
    }
    home *= 1 + appM;

    if (m % 12 === 0) {
      const saleNet = home * (1 - ins.sellingCostsPct);
      const homeGainTax = ins.capitalGainsTaxRate * Math.max(0, saleNet - homeBasis - ins.homeSaleExclusion);
      const buyerWealth = saleNet - balance - homeGainTax + afterTax(buyer);
      const renterWealth = afterTax(renter);
      years.push({
        year: m / 12,
        homeValue: home,
        loanBalance: balance,
        ownerMonthlyCost: ownerCost,
        rentMonthly: rent,
        buyerWealth,
        renterWealth,
        buyAdvantage: buyerWealth - renterWealth,
      });
    }
  }
  // The first year after which buying never falls behind again (a one-year blip ahead isn't break-even).
  let breakEvenYear: number | null = null;
  for (let i = years.length - 1; i >= 0 && years[i]!.buyAdvantage >= 0; i--) breakEvenYear = years[i]!.year;
  return { years, breakEvenYear, upfrontCash, renterSetup };
}

/** Spreadsheet's fixed grid, kept for reference. */
export const SENSITIVITY_HOME_PRICES = [
  400_000, 450_000, 500_000, 550_000, 600_000, 650_000, 700_000, 750_000, 800_000,
  850_000, 900_000,
];

export const SENSITIVITY_INCOMES = [
  125_000, 150_000, 175_000, 200_000, 225_000, 250_000, 275_000,
];

/**
 * Grid axes centered on the household's own numbers: eleven home prices from 60% to 140%
 * of the budget price, seven incomes from 70% to 130% of salary, rounded to tidy steps.
 */
export function sensitivityAxes(ins: HomeBudgetInputs): { homePrices: number[]; incomes: number[] } {
  const round = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);
  const p = ins.budgetHomePrice > 0 ? ins.budgetHomePrice : 800_000;
  const pStep = round(p * 0.08, 25_000);
  const pMid = round(p, 25_000);
  const s = ins.annualHouseholdSalary > 0 ? ins.annualHouseholdSalary : 200_000;
  const sStep = round(s * 0.1, 5_000);
  const sMid = round(s, 5_000);
  return {
    homePrices: Array.from({ length: 11 }, (_, i) => pMid + (i - 5) * pStep).filter((v) => v > 0),
    incomes: Array.from({ length: 7 }, (_, i) => sMid + (i - 3) * sStep).filter((v) => v > 0),
  };
}

/** Grid uses fixed 25% down (Illustrative / M column style). */
export function computeSensitivityCell(
  annualIncome: number,
  homePrice: number,
  base: HomeBudgetInputs,
): number {
  const cellIns: HomeBudgetInputs = {
    ...base,
    annualHouseholdSalary: annualIncome,
    budgetHomePrice: homePrice,
    budgetDownPaymentPct: 0.25,
  };
  const b = computeBudgetScenario(cellIns);
  return b.remainingDiscretionaryMonthly;
}

/**
 * Down-payment money from liquid net worth: liquid balances less capital-gains tax on
 * the embedded gain, times the share the household is willing to commit.
 */
export function cashForHomeFromNetWorth(f: { liquid: number; gain: number; taxRate: number; share: number }): {
  taxOnGain: number;
  afterTax: number;
  available: number;
} {
  const taxOnGain = Math.max(0, f.gain) * f.taxRate;
  const afterTax = Math.max(0, f.liquid - taxOnGain);
  return { taxOnGain, afterTax, available: afterTax * f.share };
}
