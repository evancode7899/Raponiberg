import { savedInclRetirement } from "../book/definitions.ts";
import { BUCKETS, type NetWorthBucket } from "./settings.ts";

/**
 * The pure arithmetic behind the annual profile: the paycheck-to-savings waterfall, net
 * worth buckets, and the bridge that explains each year's change in net worth.
 * Everything is cents.
 */

/** Stable id for an expense row (survives re-importing its statement). */
export function expenseFingerprint(r: { accountId: string; date: string; amountCents: number; payee: string | null }): string {
  return `${r.accountId}|${r.date}|${r.amountCents}|${(r.payee ?? "").trim().slice(0, 24)}`;
}

// ---------------------------------------------------------------- cash waterfall

export type CashWaterfallInput = {
  salary: number;
  bonus: number;
  otherIncome: number;
  withholding: number;
  additionalTaxes: number;
  refunds: number;
  otherDeductions: number;
  employer: number;
  living: number;
  nonRecurring: number;
};

export type CashWaterfall = CashWaterfallInput & {
  grossCash: number;
  netCash: number;
  saved: number;
  /** (withholding + taxes paid − refunds) / gross cash. */
  cashTaxRate: number | null;
  savingsOfGross: number | null;
  savingsOfNet: number | null;
};

/** Gross pay → taxes → deductions → + employer money → − living → saved incl. retirement (book/definitions.ts). */
export function cashWaterfall(i: CashWaterfallInput): CashWaterfall {
  const grossCash = i.salary + i.bonus + i.otherIncome;
  const netCash = grossCash - i.withholding - i.additionalTaxes + i.refunds - i.otherDeductions + i.employer;
  const saved = savedInclRetirement(netCash, i.living, i.nonRecurring);
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
  return {
    ...i,
    grossCash,
    netCash,
    saved,
    cashTaxRate: ratio(i.withholding + i.additionalTaxes - i.refunds, grossCash),
    savingsOfGross: ratio(saved, grossCash),
    savingsOfNet: ratio(saved, netCash),
  };
}

// ---------------------------------------------------------------- net worth

export type BucketTotals = Record<NetWorthBucket, number>;

export const ZERO_BUCKETS: BucketTotals = { CASH: 0, LIQUID: 0, ILLIQUID: 0, DEFERRED_COMP: 0, PHYSICAL: 0, SHORT_DEBT: 0, LONG_DEBT: 0 };

/** Which bucket a ledger account group falls in (cards are short-term debt). */
export function bucketForGroup(group: string): NetWorthBucket {
  switch (group) {
    case "Cash":
      return "CASH";
    case "Taxable investments":
      return "LIQUID";
    case "Credit cards":
      return "SHORT_DEBT";
    default:
      return "ILLIQUID";
  }
}

export type NetWorthSummary = {
  /** Assets positive, debts as positive amounts owed. */
  buckets: BucketTotals;
  grossAssets: number;
  grossDebt: number;
  netWorth: number;
  /** Cash + liquid investments − short-term debt. */
  liquid: number;
  /** Everything else. */
  illiquid: number;
};

/** Signed balances per bucket (debts negative) → summary with debts as positive amounts owed. */
export function summarizeBuckets(signed: BucketTotals): NetWorthSummary {
  const b = { ...signed };
  for (const def of BUCKETS) if (def.debt) b[def.id] = -b[def.id];
  const grossAssets = BUCKETS.filter((d) => !d.debt).reduce((s, d) => s + b[d.id], 0);
  const grossDebt = b.SHORT_DEBT + b.LONG_DEBT;
  const liquid = b.CASH + b.LIQUID - b.SHORT_DEBT;
  return { buckets: b, grossAssets, grossDebt, netWorth: grossAssets - grossDebt, liquid, illiquid: grossAssets - grossDebt - liquid };
}

// ---------------------------------------------------------------- bridge

export type BridgeInput = {
  /** From the paycheck waterfall. */
  cashSaved: number;
  /** Investment income already counted in the waterfall (reinvested dividends). */
  dividendsCounted: number;
  /** Ledger household figures for the year. */
  ledger: {
    income: number;
    spending: number;
    retirementEmployee: number;
    retirementEmployer: number;
    external: number;
    newlyTracked: number;
    growthNetOfFees: number;
    transferResidual: number;
    unexplained: number;
  };
  /** Change in matched transfers in flight across the year ends (counted in net worth). */
  inTransitAssetChange?: number;
};

export type Bridge = {
  cashSaved: number;
  investmentGrowth: number;
  outsideMoney: number;
  newlyTracked: number;
  inTransit: number;
  /**
   * What statements show was saved minus the paycheck math: with every check passing this
   * is timing only (a 401(k) or HSA contribution posted after the year's last paycheck).
   */
  unexplainedSavings: number;
  /** Saved per statements: income − spending + payroll/employer retirement money. */
  savedPerStatements: number;
  total: number;
};

/**
 * Explains a year's change in net worth starting from the paycheck math:
 *   saved incl. retirement + growth + outside money + balances first on file + in transit
 *   + (statements − paycheck math) = change in net worth.
 */
export function netWorthBridge(i: BridgeInput): Bridge {
  const l = i.ledger;
  const savedPerStatements = l.income + l.spending + l.retirementEmployee + l.retirementEmployer;
  const b: Bridge = {
    cashSaved: i.cashSaved,
    investmentGrowth: l.growthNetOfFees - i.dividendsCounted,
    outsideMoney: l.external,
    newlyTracked: l.newlyTracked,
    inTransit: l.transferResidual + l.unexplained + (i.inTransitAssetChange ?? 0),
    unexplainedSavings: savedPerStatements + i.dividendsCounted - i.cashSaved,
    savedPerStatements,
    total: 0,
  };
  b.total = b.cashSaved + b.investmentGrowth + b.outsideMoney + b.newlyTracked + b.inTransit + b.unexplainedSavings;
  return b;
}
