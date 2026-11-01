import type { GarageReport } from "../../car/report.ts";
import type { Forecast } from "../../forecast/forecast.ts";
import { analyzeFire, firePlans, stressTest } from "../../fire/fire.ts";
import { accessFigures, longTermCells, longTermTable, planValue, STRESS_PATHS, stressFigures, type AccessFigure, type StressFigure } from "../../fire/longTerm.ts";
import { projectOutlook } from "../../profile/outlook.ts";
import { ledgerColumns, ledgerDraws, ledgerViews } from "../../forecast/ledger.ts";
import { COST_LINES } from "../../car/report.ts";
import { CAR_KINDS } from "../../car/settings.ts";
import type { HsaReport } from "../../hsa/report.ts";
import type { AnnualProfileReport } from "../../profile/buildAnnualProfile.ts";
import { annualPayDescriptor } from "../../profile/annualPay.ts";
import { rollTotalValue, rollValue } from "../../profile/rollLines.ts";
import type { RollforwardReport } from "../../profile/rollforwards.ts";
import { BUCKETS } from "../../profile/settings.ts";
import { ESTIMATE_LINES, estimateColumns, estimatesFound, lineValue, type EstimateKey } from "../../tax/estimateLines.ts";
import type { TaxReport } from "../../tax/buildTaxReport.ts";
import type { BonusesReport } from "../reports/bonuses.ts";
import { bonusPayFigures, estimateDescriptor, expectedBonuses, figureReads } from "../reports/bonusFigures.ts";
import type { CashFlowPeriod } from "../reports/cashFlow.ts";
import type { SpendingKinds, SpendingReport } from "../reports/spending.ts";
import { cashFlowDescriptor, cashFlowWindows, windowFigures } from "../reports/cashFlowWindows.ts";
import type { CashFlowDescriptor } from "./cashFlowProof.ts";
import type { GoalsReport } from "../reports/goals.ts";
import type { InvestmentsReport } from "../reports/investments.ts";
import type { MoneyCalendarReport } from "../reports/moneyCalendar.ts";
import type { NetWorthReport } from "../reports/netWorth.ts";
import type { NetWorthChangesReport } from "../reports/netWorthChanges.ts";
import type { TaxAccountsReport } from "../reports/taxAccounts.ts";
import type { buildHomeSummary } from "../../dashboard/homeSummary.ts";
import type { AccountLimitsDescriptor } from "./accountLimitsProof.ts";
import type { AnnualCashLine, AnnualDescriptor } from "./annualProof.ts";
import type { BonusesDescriptor } from "./bonusesProof.ts";
import type { FireFigure, FireSettings, HomeFigure } from "./planningProof.ts";
import { MORTGAGE_FIGURES, mortgageFigures } from "../../mortgage/figures.ts";
import { RENT_VS_BUY_FIGURES } from "../../home-budget/rentVsBuy.ts";
import { estimateFigures, yearEstimate } from "../../profile/yearEstimate.ts";
import type { ForecastData } from "../../forecast/load.ts";
import { withLinks, type MortgageInputs } from "../../mortgage/inputs.ts";
import type { MortgageLinks } from "../../mortgage/links.ts";
import { defaultHomeBudgetInputs, type HomeBudgetInputs } from "../../home-budget/homeBudgetModel.ts";
import { defaultFunds, type FundsConfig } from "../../home-budget/homeLinked.ts";
import type { CarFigureDescriptor } from "./carProof.ts";
import { LEDGER_LINES, ledgerValue, type LedgerLine } from "./forecastProof.ts";
import type { ProofDescriptor } from "./index.ts";
import type { Book } from "../load.ts";
import type { ProofValue } from "./types.ts";
import { derivedDescriptor, type DerivedFigure, type DerivedPage } from "../derived/types.ts";
import { descriptorKey } from "./key.ts";

/**
 * Every figure each page shows, with the descriptor of its proof and the value the page
 * shows (null where the page shows no single value the proof's figure can be held to: a
 * date, a projection the page recomputes as you type). One list per page, read off the
 * same report the page reads: the page's tests walk it on invented households, and the
 * proof sweep (sweep.ts) walks it on the owner's own Book, so a figure that drifts from
 * its proof is caught whether or not anyone clicks it.
 */
export type PageFigure = {
  page: string;
  descriptor: ProofDescriptor;
  shown: ProofValue | null;
  /** A document as it prints (a statement, a row, a stub): viewers always show it, so a finding over its days withholds what's built from it, never it. */
  asPrinted?: boolean;
};

const cents = (c: number | null | undefined): ProofValue | null => (c == null ? null : { cents: c });

// ------------------------------------------------------------------ Cash flow

/** Each proven month's income, spending, outside money and saved, each category of it, and (from the spending report) each band of spending. */
export function cashFlowFigures(periods: (CashFlowPeriod & { kinds?: SpendingKinds })[], accountIds?: string[]): PageFigure[] {
  const out: PageFigure[] = [];
  const scope = accountIds?.length ? { accountIds } : {};
  for (const p of periods) {
    if (p.blockers.length) continue;
    const d = (metric: "income" | "spending" | "external" | "net", category?: string): ProofDescriptor => ({ report: "cash-flow", metric, granularity: "month", start: p.start, end: p.end, ...(category ? { category } : {}), ...scope });
    out.push(
      { page: "Cash flow", descriptor: d("income"), shown: cents(p.incomeCents) },
      { page: "Cash flow", descriptor: d("spending"), shown: cents(p.spendingCents) },
      { page: "Cash flow", descriptor: d("net"), shown: cents(p.netCents) },
      { page: "Cash flow", descriptor: d("external"), shown: cents(p.externalByCategory.reduce((t, c) => t + c.cents, 0)) },
    );
    for (const c of p.spendingByCategory) out.push({ page: "Cash flow", descriptor: d("spending", c.category), shown: cents(c.cents) });
    for (const c of p.incomeByCategory) out.push({ page: "Cash flow", descriptor: d("income", c.category), shown: cents(c.cents) });
    if (p.kinds)
      for (const [spendingKind, shown] of [["bill", p.kinds.billCents], ["big", p.kinds.bigCents], ["everyday", p.kinds.everydayCents]] as const)
        out.push({ page: "Cash flow", descriptor: { ...(d("spending") as CashFlowDescriptor), spendingKind }, shown: cents(shown) });
  }
  return out;
}

/**
 * Every figure the Cash flow tabs sum over a run of months (cashFlowWindows: each preset
 * range and the run before it, each year, the year-over-year sides, Trends' windows), each
 * merchant and payer in each, and Recurring's twelve months of each recurring merchant's
 * charges. Built with the page's own helpers, so the recipes are the ones it renders.
 */
export function cashFlowWindowFigures(r: Pick<SpendingReport, "months" | "recurring">): PageFigure[] {
  const page = "Cash flow";
  const seen = new Set<string>();
  const out: PageFigure[] = [];
  const add = (descriptor: ProofDescriptor, c: number) => {
    const k = descriptorKey(descriptor);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ page, descriptor, shown: cents(c) });
  };
  for (const months of cashFlowWindows(r)) for (const f of windowFigures(months)) add(f.descriptor, f.cents);
  if (r.months.length) for (const c of r.recurring) add(cashFlowDescriptor("spending", r.months, undefined, { merchantKey: c.key, charges: true }), c.last12Cents);
  return out;
}

// ------------------------------------------------------------------ Net worth

/** Net worth today, assets, debts, each group and account, the twelve months' change, and each month's change. */
export function netWorthFigures(r: NetWorthReport): PageFigure[] {
  const out: PageFigure[] = [];
  const at = r.current.asOf;
  const page = "Net worth";
  if (!r.current.blockers.length) {
    out.push(
      { page, descriptor: { report: "net-worth", metric: "balance", date: at }, shown: cents(r.current.totalCents) },
      { page, descriptor: { report: "net-worth", metric: "balance", date: at, side: "assets" }, shown: cents(r.summary.assetsCents) },
      { page, descriptor: { report: "net-worth", metric: "balance", date: at, side: "debts" }, shown: cents(r.summary.debtsCents) },
    );
    for (const g of r.summary.groups) out.push({ page, descriptor: { report: "net-worth", metric: "balance", date: at, accountIds: g.accountIds }, shown: cents(g.cents) });
    for (const a of r.accounts) if (a.currentCents !== 0) out.push({ page, descriptor: { report: "net-worth", metric: "balance", date: at, accountIds: [a.id] }, shown: cents(a.currentCents) });
  }
  const t = r.summary.trailing12;
  if (t && !t.blockers.length) {
    out.push(
      { page, descriptor: { report: "net-worth", metric: "change", granularity: "month", start: t.start, end: t.end }, shown: cents(t.changeCents) },
      { page, descriptor: { report: "dashboard", figure: "saving", start: t.start, end: t.end }, shown: cents(t.principalCents) },
      { page, descriptor: { report: "dashboard", figure: "markets", start: t.start, end: t.end }, shown: cents(t.growthCents) },
    );
  }
  for (const p of r.periods) {
    if (p.blockers.length) continue;
    out.push({ page, descriptor: { report: "net-worth", metric: "balance", date: p.end }, shown: cents(p.household.closingCents) });
    out.push({ page, descriptor: { report: "net-worth", metric: "change", granularity: r.granularity, start: p.start, end: p.end }, shown: cents(p.household.closingCents - p.household.openingCents) });
    // How it was built › a period opened: each account's opening (unless it first appears in the period) and closing balance.
    const before = new Date(Date.parse(`${p.start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    for (const a of p.byAccount) {
      if (!a.newlyTrackedCents) out.push({ page, descriptor: { report: "net-worth", metric: "balance", date: before, accountIds: [a.accountId] }, shown: cents(a.openingCents) });
      out.push({ page, descriptor: { report: "net-worth", metric: "balance", date: p.end, accountIds: [a.accountId] }, shown: cents(a.closingCents) });
    }
  }
  return out;
}

/** Net worth › What changed: each period's opening, closing, change, saving, markets, income, spending, the steps with proofs of their own, and each category that moved. */
export function netWorthChangeFigures(r: NetWorthChangesReport): PageFigure[] {
  const page = "Net worth › What changed";
  const out: PageFigure[] = [];
  for (const p of r.periods) {
    const f = p.proofs;
    out.push(
      { page, descriptor: f.opening, shown: cents(p.openingCents) },
      { page, descriptor: f.closing, shown: cents(p.closingCents) },
      { page, descriptor: f.change, shown: cents(p.changeCents) },
      { page, descriptor: f.saved, shown: cents(p.savedCents) },
      { page, descriptor: f.markets, shown: cents(p.marketsCents) },
      { page, descriptor: f.income, shown: cents(p.incomeCents) },
      { page, descriptor: f.spending, shown: cents(p.spendingCents) },
    );
    for (const m of [...p.spendingMovers, ...p.incomeMovers]) out.push({ page, descriptor: m.proof, shown: cents(m.cents) });
  }
  return out;
}

// ------------------------------------------------------------------ Home

/** Every figure on Home: each one carries its own proof descriptor in the summary. */
export function homeFigures(s: ReturnType<typeof buildHomeSummary>): PageFigure[] {
  const out: PageFigure[] = [];
  const page = "Home";
  const add = (descriptor: ProofDescriptor | null | undefined, shown: number | null | undefined) => {
    if (descriptor && shown != null) out.push({ page, descriptor, shown: { cents: shown } });
  };
  const nw = s.netWorth;
  if (nw.proofs) {
    add(nw.proofs.total, nw.totalCents);
    add(nw.proofs.assets, nw.assetsCents);
    add(nw.proofs.debts, nw.debtsCents);
    add(nw.proofs.liquid, nw.liquidCents);
  }
  for (const c of [nw.change.month, nw.change.year, nw.change.ytd]) if ("proof" in c) add(c.proof, c.cents);
  if (nw.drivers) {
    add(nw.drivers.proofs.principal, nw.drivers.principalCents);
    add(nw.drivers.proofs.growth, nw.drivers.growthCents);
  }
  for (const g of nw.groups) add(g.proof, g.cents);
  const cf = s.cashFlow;
  if (cf.last12) {
    add(cf.last12.proofs.income, cf.last12.incomeCents);
    add(cf.last12.proofs.spending, cf.last12.spendingCents);
    add(cf.last12.proofs.net, cf.last12.netCents);
  }
  if (cf.lastMonth) add(cf.lastMonth.proof, cf.lastMonth.spendingCents);
  for (const c of cf.categories) {
    if (c.lastMonthCents) add(c.proof, c.lastMonthCents);
    if (c.totalCents) add(c.totalProof, c.totalCents);
  }
  return out;
}

// ------------------------------------------------------------------ Investments

/** The invested total, each account's value and each position in it. */
export function investmentsFigures(r: InvestmentsReport): PageFigure[] {
  const page = "Investments";
  const out: PageFigure[] = [{ page, descriptor: { report: "investments" }, shown: cents(r.totalCents) }];
  for (const a of r.accounts) if (!a.blockers.length) out.push({ page, descriptor: { report: "investments", accountId: a.accountId }, shown: cents(a.valueCents) });
  for (const p of r.positions) if (p.kind !== "ACCOUNT") out.push({ page, descriptor: { report: "investments", accountId: p.accountId, position: p.key, ...(p.lot ? { lot: p.lot } : {}) }, shown: cents(p.valueCents) });
  return out;
}

// ------------------------------------------------------------------ Annual

const CASH: [AnnualCashLine, (y: AnnualProfileReport["years"][number]) => number | null][] = [
  ["salary", (y) => y.cash!.waterfall.salary],
  ["bonus", (y) => y.cash!.waterfall.bonus],
  ["taxes-deductions", (y) => { const w = y.cash!.waterfall; return w.withholding + w.additionalTaxes - w.refunds + w.otherDeductions; }],
  ["to-retirement", (y) => y.cash!.toRetirement],
  ["other-income", (y) => y.cash!.waterfall.otherIncome],
  ["gross", (y) => y.cash!.waterfall.grossCash],
  ["withholding", (y) => y.cash!.waterfall.withholding],
  ["taxes-paid", (y) => y.cash!.waterfall.additionalTaxes],
  ["refunds", (y) => y.cash!.waterfall.refunds],
  ["deductions", (y) => y.cash!.waterfall.otherDeductions],
  ["employer", (y) => y.cash!.waterfall.employer],
  ["partner-kept", (y) => y.cash!.waterfall.partnerKept],
  ["net-cash", (y) => y.cash!.waterfall.netCash],
  ["living", (y) => y.cash!.waterfall.living],
  ["one-offs", (y) => y.cash!.waterfall.nonRecurring],
  ["saved", (y) => y.cash!.waterfall.saved],
  ["reimbursements", (y) => y.cash!.reimbursements],
  ["tax-rate", () => null],
  ["savings-of-gross", () => null],
  ["savings-of-net", () => null],
];

/** The annual statement's cash lines and categories, year-end net worth and its buckets, the bridge, and every roll-forward. */
export function annualFigures(profile: AnnualProfileReport, rolls: RollforwardReport): PageFigure[] {
  const out: PageFigure[] = [];
  const add = (page: string, d: AnnualDescriptor, v: number | null) => out.push({ page, descriptor: d, shown: cents(v) });
  for (const y of profile.years) {
    const year = y.year;
    if (y.cash) {
      for (const [line, f] of CASH) add("Annual", { report: "annual", figure: "cash", year, line }, f(y));
      for (const s of y.cash.spending) add("Annual", { report: "annual", figure: "category", year, category: s.category }, s.cents);
    }
    // Each member's salary and bonus (a partner before the merge shows nothing).
    for (const q of y.people ?? [])
      if (q.member) for (const [line, v] of [["base", q.salary], ["bonus", q.bonus]] as const) out.push({ page: "Annual", descriptor: annualPayDescriptor(y, q, line), shown: cents(v) });
    const n = y.netWorth;
    if (n) {
      for (const b of BUCKETS) if (n.buckets[b.id] !== 0) add("Annual", { report: "annual", figure: "bucket", year, bucket: b.id }, b.debt ? -n.buckets[b.id] : n.buckets[b.id]);
      add("Annual", { report: "annual", figure: "net-worth", year, line: "net-worth" }, n.netWorth);
      add("Annual", { report: "annual", figure: "net-worth", year, line: "assets" }, n.grossAssets);
      add("Annual", { report: "annual", figure: "net-worth", year, line: "debt" }, -n.grossDebt);
      add("Annual", { report: "annual", figure: "net-worth", year, line: "liquid" }, n.liquid);
      add("Annual", { report: "annual", figure: "net-worth", year, line: "illiquid" }, n.illiquid);
      add("Annual", { report: "annual", figure: "net-worth", year, line: "in-transit" }, n.inTransit);
    }
    if (y.change) {
      add("Annual", { report: "annual", figure: "net-worth", year, line: "change" }, y.change.cents);
      add("Annual", { report: "annual", figure: "net-worth", year, line: "change-pct" }, null);
    }
    if (y.bridge)
      for (const line of ["cashSaved", "investmentGrowth", "outsideMoney", "newlyTracked", "inTransit", "unexplainedSavings", "total"] as const)
        add("Annual", { report: "annual", figure: "bridge", year, line }, y.bridge[line]);
  }
  for (const a of rolls.accounts)
    for (const x of a.years) {
      for (const line of ["opening", "employee", "employer", "deposits", "withdrawals", "after-contributions", "income", "market", "fees", "closing"] as const)
        add("Net worth › Account roll-forwards", { report: "annual", figure: "rollforward", year: x.year, accountId: a.id, line }, rollValue(x, line));
      add("Net worth › Account roll-forwards", { report: "annual", figure: "rollforward", year: x.year, accountId: a.id, line: "return" }, null);
    }
  for (const year of rolls.years)
    for (const line of ["closing", "contributions", "growth"] as const) {
      const xs = rolls.accounts.flatMap((a) => a.years.filter((x) => x.year === year));
      if (xs.length) add("Net worth › Account roll-forwards", { report: "annual", figure: "rollforward-total", year, line }, xs.reduce((s, x) => s + rollTotalValue(x, line), 0));
    }
  return out;
}

// ------------------------------------------------------------------ Bonuses

const bon = (d: Record<string, unknown>) => ({ report: "bonuses", ...d }) as BonusesDescriptor;

/**
 * The totals, each award, tranche and vesting window, each letter's totals, each year's
 * reconciliation; the pay beside them (bonusPayFigures); and, with a forecast, the next
 * award it expects.
 */
export function bonusesFigures(r: BonusesReport, forecast?: Forecast | null): PageFigure[] {
  const page = "Bonuses";
  const t = r.totals;
  const out: [BonusesDescriptor, number][] = [
    [bon({ figure: "totals", measure: "headline" }), t.headlineCents],
    [bon({ figure: "totals", measure: "upfront" }), t.upfrontCents],
    [bon({ figure: "totals", measure: "deferred" }), t.deferredCents],
    [bon({ figure: "totals", measure: "deferredPaid" }), t.deferredPaidCents],
    [bon({ figure: "totals", measure: "forfeited" }), t.forfeitedCents],
    [bon({ figure: "totals", measure: "outstanding" }), t.outstandingCents],
  ];
  for (const a of r.awards) {
    const aw = (measure: string, v: number) => out.push([bon({ figure: "award", letterId: a.letterId, year: a.year, measure }), v]);
    aw("scheduled", a.upfrontCents + a.deferredCents + a.oneOffCents);
    if (a.totalBonusCents != null) aw("headline", a.totalBonusCents);
    if (a.totalComp) aw("totalComp", a.totalComp.cents);
    aw("upfront", a.upfrontCents);
    aw("deferred", a.deferredCents + a.planDeferredCents);
    aw("paid", a.paidCents);
    aw("forfeited", a.forfeitedCents);
    aw("outstanding", a.outstandingCents);
    if (a.base?.from === "LETTER") aw("base", a.base.cents);
    if (a.oneOffCents) aw("oneOff", a.oneOffCents);
    if (a.planDeferredCents) aw("planDeferred", a.planDeferredCents);
    for (const tr of a.tranches) out.push([bon({ figure: "tranche", letterId: a.letterId, year: a.year, window: tr.window, kind: tr.kind }), tr.amountCents]);
  }
  for (const w of r.windows) {
    out.push([bon({ figure: "window", window: w.key, measure: "scheduled" }), w.scheduledCents]);
    out.push([bon({ figure: "window", window: w.key, measure: "paid" }), w.paidCents]);
  }
  for (const l of r.letters) {
    out.push([bon({ figure: "letter", letterId: l.id, measure: "scheduled" }), l.windowTotals.scheduledCents]);
    out.push([bon({ figure: "letter", letterId: l.id, measure: "paid" }), l.windowTotals.paidCents]);
  }
  for (const y of r.byYear) out.push([bon({ figure: "reconcile", year: y.year, personId: y.personId, employer: y.employer }), y.explainedCents]);
  // A figure a pay finding withholds shows as withheld, not as a number (figureReads: the page's own rule).
  return [
    ...out.map(([descriptor, v]) => ({ page, descriptor, shown: figureReads(r, descriptor).blockers.length ? null : cents(v) })),
    ...bonusPayFigures(r).map((f) => ({ page, descriptor: f.descriptor, shown: cents(f.cents) })),
    ...(forecast ? expectedBonuses(forecast).map((b) => ({ page, descriptor: estimateDescriptor(b), shown: cents(b.gross) })) : []),
  ];
}

// ------------------------------------------------------------------ HSA

/** The HSA page's figures, each read off the report the page shows. */
export function hsaFigures(r: HsaReport): PageFigure[] {
  const page = "HSA";
  const list: [ProofDescriptor, number | null][] = [
    [{ report: "hsa", metric: "balance" }, r.hsa.balanceCents],
    [{ report: "hsa", metric: "contributions" }, r.growth.funding.employeeCents + r.growth.funding.employerCents],
    [{ report: "hsa", metric: "contributions", part: "employee" }, r.growth.funding.employeeCents],
    [{ report: "hsa", metric: "contributions", part: "employer" }, r.growth.funding.employerCents],
    [{ report: "hsa", metric: "distributions", part: "distribution" }, r.withdrawalTotals.distributionCents],
    [{ report: "hsa", metric: "distributions", part: "direct" }, r.withdrawalTotals.directCents],
    [{ report: "hsa", metric: "reimbursable" }, r.totals.unreimbursedCents],
    [{ report: "hsa", metric: "ready" }, r.totals.readyCents],
    [{ report: "hsa", metric: "reimbursed" }, r.totals.reimbursedCents],
    [{ report: "hsa", metric: "logged" }, r.totals.loggedCents],
    [{ report: "hsa", metric: "growth" }, r.totals.growthCents],
    // The growth figures, unless the page withholds them for want of a proven tax rate.
    ...(r.growth.withheld
      ? []
      : ([
          [{ report: "hsa", metric: "future" }, r.growth.futureValueCents],
          [{ report: "hsa", metric: "future-growth" }, r.growth.futureValueCents - r.totals.unreimbursedCents],
        ] as [ProofDescriptor, number][])),
  ];
  return list.filter(([, v]) => v != null).map(([descriptor, v]) => ({ page, descriptor, shown: cents(v) }));
}

// ------------------------------------------------------------------ Account limits

/** Every limit, contribution, room and projection on Account limits for the report's year. */
export function accountLimitsFigures(r: TaxAccountsReport): PageFigure[] {
  const f = (x: Omit<AccountLimitsDescriptor, "report" | "year">, c: number): PageFigure => ({ page: "Account limits", descriptor: { report: "account-limits", year: r.year, ...x }, shown: { cents: c } });
  const chetStep = r.steps.find((s) => s.id === "chet");
  const out = [f({ account: "steps", figure: "room" }, r.pretax.roomCents), f({ account: "chet", figure: "used" }, r.household.chet.contributed), f({ account: "chet", figure: "limit" }, r.household.chet.deductionLimit)];
  if (chetStep) out.push(f({ account: "chet", figure: "room" }, chetStep.roomCents));
  if (r.pretax.taxSavedCents != null) out.push(f({ account: "steps", figure: "tax-saved" }, r.pretax.taxSavedCents));
  for (const p of r.people) {
    const personId = p.id;
    out.push(
      f({ account: "k401", personId, figure: "used" }, p.k401.total.ytd),
      f({ account: "k401", personId, figure: "projected" }, p.k401.total.projected),
      f({ account: "k401", personId, figure: "limit" }, p.k401.limit),
      f({ account: "k401", personId, figure: "room" }, p.k401.room),
      f({ account: "hsa", personId, figure: "used" }, p.hsa.total.ytd),
      f({ account: "hsa", personId, figure: "projected" }, p.hsa.total.projected),
      f({ account: "hsa", personId, figure: "limit" }, p.hsa.limit),
      f({ account: "hsa", personId, figure: "room" }, p.hsa.room),
      f({ account: "hsa", personId, figure: "used", part: "employee" }, p.hsa.employee.ytd),
      f({ account: "hsa", personId, figure: "projected", part: "employee" }, p.hsa.employee.projected),
      f({ account: "hsa", personId, figure: "used", part: "employer" }, p.hsa.employer.ytd),
      f({ account: "hsa", personId, figure: "projected", part: "employer" }, p.hsa.employer.projected),
      f({ account: "ira", personId, figure: "used" }, p.ira.total),
      f({ account: "ira", personId, figure: "limit" }, p.ira.limit),
      f({ account: "ira", personId, figure: "room" }, p.ira.room),
    );
    if (p.k401.excess) out.push(f({ account: "k401", personId, figure: "excess" }, p.k401.excess));
    for (const e of p.k401.employers)
      out.push(
        f({ account: "k401", personId, figure: "used", employer: e.employer, part: "employee" }, e.employee.ytd),
        f({ account: "k401", personId, figure: "projected", employer: e.employer, part: "employee" }, e.employee.projected),
        f({ account: "k401", personId, figure: "used", employer: e.employer, part: "employer" }, e.employer$.ytd),
        f({ account: "k401", personId, figure: "projected", employer: e.employer, part: "employer" }, e.employer$.projected),
      );
  }
  return out;
}

// ------------------------------------------------------------------ Calendar

/** Each calendar item's amount that has a proof (the Account limits or Taxes figure it repeats). */
export function calendarFigures(r: MoneyCalendarReport): PageFigure[] {
  return r.items.flatMap((i) => (i.proof && i.cents != null ? [{ page: "Calendar", descriptor: i.proof, shown: { cents: i.cents } }] : []));
}

// ------------------------------------------------------------------ Car

/**
 * Each car's cost per line and in total: to date, the last 12 months, each year and each
 * month; the same to date, over 12 months and each year as a rate per mile and per month
 * (rates the page shows only once there are miles or a month to divide by, held to no
 * value: the proof works the rate out); what was paid to date, kind by kind; and each
 * counted line of the log.
 */
export function carFigures(g: GarageReport): PageFigure[] {
  const out: PageFigure[] = [];
  const page = "Car";
  // The page withholds every money figure while a finding covers the car charges.
  if (g.blockers?.length) return out;
  for (const r of g.cars) {
    if (!r.configured) continue;
    const fig = (x: Partial<CarFigureDescriptor>): CarFigureDescriptor => ({ report: "car", carId: r.carId, basis: "accrued", span: "toDate", ...x });
    const spans = ["toDate", "last12", ...new Set(r.months.map((m) => m.month.slice(0, 4))), ...r.months.map((m) => m.month)];
    for (const span of spans)
      for (const line of [undefined, ...COST_LINES]) {
        const shown =
          span === "toDate" ? (line ? r.accrued[line] : r.totals.tco)
          : span === "last12" ? (line ? r.last12.lines[line] : r.last12.total)
          : r.months.filter((m) => m.month.startsWith(span)).reduce((t, m) => t + (line ? m.lines[line] : m.total), 0);
        out.push({ page, descriptor: fig({ span, ...(line ? { line } : {}) }), shown: cents(shown) });
        if (span.length !== 7) for (const per of ["mile", "month"] as const) out.push({ page, descriptor: fig({ span, ...(line ? { line } : {}), per }), shown: null });
      }
    for (const line of [...CAR_KINDS, "INTEREST" as const]) out.push({ page, descriptor: fig({ basis: "cash", line }), shown: cents(line === "INTEREST" ? r.cash.INTEREST : r.cash[line]) });
  }
  for (const i of g.log) if (i.counted) out.push({ page, descriptor: { report: "car", itemId: i.id }, shown: cents(i.cents) });
  return out;
}

// ------------------------------------------------------------------ Taxes

const KEYS = Object.keys(ESTIMATE_LINES) as EstimateKey[];

/**
 * Every Worksheet line of every return (each spouse separately, and joint), projected and
 * year to date; the estimated payments found on Payments; and, for the year in progress,
 * each person's gross pay projected to Dec 31 (Income & W-2, the first employer still paying).
 */
export function taxEstimateFigures(report: TaxReport, inProgress = false): PageFigure[] {
  const out: PageFigure[] = [];
  const page = `Taxes ${report.year}`;
  for (const a of ["FEDERAL", "CT"] as const)
    out.push({ page, descriptor: { report: "tax-estimate", year: report.year, basis: "projected", key: `found.${a}` }, shown: { cents: estimatesFound(report.payments, report.year, a) } });
  if (inProgress)
    for (const p of report.people) {
      const e = p.payroll.find((x) => x.active);
      if (e) out.push({ page, descriptor: { report: "planning", page: "taxes", figure: "projected-gross", year: report.year, personId: p.id }, shown: { cents: e.projected.gross } });
    }
  for (const basis of ["projected", "ytd"] as const) {
    const { cols } = estimateColumns(report, basis);
    for (const col of cols)
      for (const key of KEYS) {
        const v = lineValue(key, col, cols);
        out.push({
          page: `Taxes ${report.year}`,
          descriptor: { report: "tax-estimate", year: report.year, basis, ...(col.id === "joint" ? {} : { filer: col.id }), key },
          shown: v == null ? { text: "—" } : ESTIMATE_LINES[key].ratio ? { ratio: v } : { cents: v },
        });
      }
  }
  return out;
}

// ------------------------------------------------------------------ Goals

/** Each goal's saved-so-far, target and monthly need, and the emergency fund's typical month. */
export function goalsFigures(r: GoalsReport): PageFigure[] {
  const page = "Goals";
  const out: PageFigure[] = [];
  if (r.monthlySpending) out.push({ page, descriptor: { report: "planning", page: "goals", figure: "spending" }, shown: cents(r.monthlySpending.cents) });
  for (const g of r.goals) {
    if (g.blockers.length) continue;
    const d = (figure: "current" | "target" | "needed" | "to-go" | "lands"): ProofDescriptor => ({ report: "planning", page: "goals", figure, goalId: g.goal.id });
    out.push({ page, descriptor: d("current"), shown: cents(g.currentCents) });
    if (g.targetCents != null) out.push({ page, descriptor: d("target"), shown: cents(g.targetCents) });
    if (g.neededMonthlyCents != null) out.push({ page, descriptor: d("needed"), shown: cents(g.neededMonthlyCents) });
    out.push({ page, descriptor: d("to-go"), shown: null }, { page, descriptor: d("lands"), shown: null });
  }
  return out;
}

// ------------------------------------------------------------------ Forecast

const LINES = Object.keys(LEDGER_LINES) as LedgerLine[];

/**
 * Every cell the Forecast ledger can draw on the saved drivers: every view it offers (each
 * span of years, each year month by month) and the lines it draws over each, as the page
 * reads them (forecast/ledger.ts). A cell two views share is one figure.
 */
export function forecastFigures(f: Forecast, r: AnnualProfileReport): PageFigure[] {
  const out: PageFigure[] = [];
  const seen = new Set<string>();
  for (const view of ledgerViews(f)) {
    const cols = ledgerColumns(f, r, view);
    for (const line of LINES.filter((l) => ledgerDraws(l, cols)))
      for (const p of cols) {
        const v = ledgerValue(p.flows, line);
        if (v == null) continue;
        const through = p.through.slice(0, 7);
        const descriptor = { report: "forecast", figure: "month", month: p.from, ...(through !== p.from ? { through } : {}), line } as const;
        const k = `${p.from}|${through}|${line}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ page: "Forecast", descriptor, shown: { cents: v } });
      }
  }
  // The inputs panel's seeds, as ForecastInputs shows them on the saved drivers.
  const s = r.seeds;
  if (s) {
    const paycheck = Object.fromEntries(f.pay.people.map((p) => [p.personId, p.basis]));
    const seed = (x: Record<string, unknown>, c: number | null) => out.push({ page: "Forecast", descriptor: { report: "forecast", figure: "seed", ...x } as ProofDescriptor, shown: cents(c) });
    seed({ which: "start" }, s.start.liquid + s.start.illiquid);
    seed({ which: "deferrals", paycheck }, f.pay.people.reduce((x, p) => x + p.deferrals, 0));
    seed({ which: "employer", paycheck }, f.pay.people.reduce((x, p) => x + p.employer, 0));
    const basis = r.settings.outlook.livingBasis;
    if (s.living[basis]) seed({ which: "living", basis }, s.living[basis]!.cents);
  }
  return out;
}

// ------------------------------------------------------------------ FIRE

/** The figures an analysis shows (FIRE › Overview): each flavor's year and number, the rates, and each milestone. */
export function fireFigureList(fa: ReturnType<typeof analyzeFire>): { figure: FireFigure; cents: number | null; milestone?: string }[] {
  const n = fa.now;
  const out: { figure: FireFigure; cents: number | null; milestone?: string }[] = [
    { figure: "fire-number", cents: n.fireNumber },
    { figure: "lean-number", cents: n.leanNumber },
    { figure: "fat-number", cents: n.fatNumber },
    ...(n.coastNumber != null ? [{ figure: "coast-number" as const, cents: n.coastNumber }] : []),
    ...(["fi-year", "fi-year-base", "lean-year", "fat-year", "coast-year", "savings-rate", "years-saved", "runway", "progress"] as const).map((figure) => ({ figure, cents: null })),
  ];
  const named = new Set(["coast", "lean", "fi", "fat"]);
  for (const m of fa.milestones) if (!named.has(m.id)) out.push({ figure: "milestone", cents: null, milestone: m.id });
  return out;
}

/** FIRE on the saved settings, analysed as FireClient analyses it: the forecast, FIRE's two plans, the analysis. */
export function fireFigures(f: Forecast, r: AnnualProfileReport): PageFigure[] {
  const a = r.settings.outlook;
  if (!r.seeds) return [];
  const fire: FireSettings = { walkAwayYear: a.walkAwayYear, withdrawalRate: a.withdrawalRate, stateTaxRate: a.stateTaxRate, retirementAge: a.retirementAge };
  const plans = firePlans(f);
  const fa = analyzeFire(plans.full, plans.base, { asOf: r.seeds.start.asOf, retirementAge: a.retirementAge });
  const out: PageFigure[] = fireFigureList(fa).map((x) => ({ page: "FIRE", descriptor: { report: "planning", page: "fire", figure: x.figure, fire, ...(x.milestone ? { milestone: x.milestone } : {}) }, shown: cents(x.cents) }));
  // FIRE › Plan: the long-term table, cell by cell, and the bridge to 59½; FIRE › Stress test on the saved yearly swings (all as the page builds them).
  const full = projectOutlook(plans.full);
  const base = plans.base === plans.full ? full : projectOutlook(plans.base);
  const table = longTermTable({ r, s: r.seeds, full, base, plan: fa.plan, pay: f.pay, schedule: f.schedule });
  for (const x of longTermCells(table)) out.push({ page: "FIRE › Plan", descriptor: { report: "planning", page: "fire", figure: "plan-cell", fire, row: x.row, col: x.col }, shown: planValue(x.value) });
  const access = accessFigures(fa.plan, fa.fi?.year ?? null);
  if (access) for (const [metric, v] of Object.entries(access.figures)) if (planValue(v)) out.push({ page: "FIRE › Plan", descriptor: { report: "planning", page: "fire", figure: "access", fire, metric: metric as AccessFigure }, shown: planValue(v) });
  const st = stressFigures(stressTest(fa.plan, { volatility: a.volatility, paths: STRESS_PATHS }), fa.fi?.year ?? null);
  for (const [metric, v] of Object.entries(st)) if (planValue(v)) out.push({ page: "FIRE › Stress test", descriptor: { report: "planning", page: "fire", figure: "stress", fire, metric: metric as StressFigure, volatility: a.volatility }, shown: planValue(v) });
  return out;
}

// ------------------------------------------------------------------ Home budget

const HOME_FIGURES: HomeFigure[] = ["cash", "salary", "income-tax", "gains-tax", "max-price", "lender-max", "lender-income", ...RENT_VS_BUY_FIGURES];

/**
 * Each linked Home budget figure on the calculator's saved inputs and funds choices, as the
 * page loads them (useSavedState: the defaults with the saved values over them). The page
 * works the values out as you type, so none is stated here: the page's own value is held to
 * the one the proof clears. Inputs typed since the last sweep make a recipe no sweep has seen.
 */
export function homeBudgetFigures(saved: { inputs: Record<string, unknown> | null; funds: Record<string, unknown> | null }): PageFigure[] {
  const inputs: HomeBudgetInputs = { ...defaultHomeBudgetInputs(), ...(saved.inputs ?? {}) };
  const funds: FundsConfig = { ...defaultFunds(), ...(saved.funds ?? {}) };
  return HOME_FIGURES.map((figure) => ({ page: "Home budget", descriptor: { report: "planning", page: "home", figure, inputs, funds }, shown: null }));
}

// ------------------------------------------------------------------ Annual estimate

/** The annual statement's estimate column for the year in progress (and its "Change, full year est." tile), line by line (lib/profile/yearEstimate.ts). */
export function annualEstimateFigures(data: ForecastData): PageFigure[] {
  const e = yearEstimate(data);
  if (!e) return [];
  return Object.entries(estimateFigures(e)).map(([line, v]) => ({ page: "Annual", descriptor: { report: "planning", page: "annual-estimate", line }, shown: v }));
}

// ------------------------------------------------------------------ Mortgage

/** The Mortgage page's four tiles on its saved inputs, the links put in as the page puts them (lib/mortgage/figures.ts). */
export function mortgagePageFigures(inputs: MortgageInputs, links: MortgageLinks): PageFigure[] {
  const m = mortgageFigures(withLinks(inputs, links));
  return MORTGAGE_FIGURES.flatMap((figure) => {
    const v = m.values[figure];
    const shown: ProofValue | null = "cents" in v ? (v.cents == null ? null : { cents: v.cents }) : v.ratio == null ? null : { ratio: v.ratio };
    return shown ? [{ page: "Mortgage", descriptor: { report: "planning", page: "mortgage", figure, inputs }, shown }] : [];
  });
}

// ------------------------------------------------------------------ Derived

const DERIVED_PAGE_NAME: Record<DerivedPage, string> = {
  investments: "Investments",
  car: "Car",
  "cash-flow": "Cash flow",
  "card-perks": "Card perks",
  "net-worth": "Net worth",
  integrity: "Statements › Issues",
  hsa: "HSA",
  "account-limits": "Account limits",
  calendar: "Calendar",
  "lp-funds": "Investments › Private funds",
  insurance: "Insurance",
  taxes: "Taxes",
  forecast: "Forecast",
};

/** A page's derived figures (derived/types.ts), each at the value its list states. */
export function derivedFigures(page: DerivedPage, list: DerivedFigure[]): PageFigure[] {
  return list.flatMap((f) => (f.value ? [{ page: DERIVED_PAGE_NAME[page], descriptor: derivedDescriptor(page, f), shown: f.value }] : []));
}

// ------------------------------------------------------------------ Sources

/**
 * Every source as it prints, under every figure above: each committed statement's closing
 * balance, each ledger row's amount (a bill payment booked in pieces is its pieces added
 * back) and each pay stub's net pay. The page is the document itself.
 */
export function sourceFigures(book: Book): PageFigure[] {
  const out: PageFigure[] = [];
  for (const s of book.statements.filter((x) => x.status === "COMMITTED"))
  {
    out.push({ page: "Statements", descriptor: { report: "statement", statementId: s.id }, shown: s.printed ? { cents: s.printed.closingCents } : null, asPrinted: true });
    // The other lines Statements › Documents draws beside it: the opening, and an investment statement's market change and fees.
    if (s.printed)
      for (const line of ["opening", ...(s.printed.growthCents || s.printed.feesCents ? (["growth", "fees"] as const) : [])] as const)
        out.push({ page: "Statements", descriptor: { report: "statement", statementId: s.id, line }, shown: { cents: s.printed[`${line}Cents`] }, asPrinted: true });
  }
  const printed = new Map(book.rows.map((r) => [r.id, r.amountCents]));
  for (const r of book.rows) if (r.partOf) printed.set(r.partOf, (printed.get(r.partOf) ?? 0) + r.amountCents);
  for (const r of book.rows) out.push({ page: "Transactions", descriptor: { report: "row", rowId: r.id }, shown: { cents: printed.get(r.id)! }, asPrinted: true });
  for (const s of book.stubs) out.push({ page: "Pay stubs", descriptor: { report: "stub", stubId: s.id }, shown: s.printed.netCurrent == null ? null : { cents: s.printed.netCurrent }, asPrinted: true });
  return out;
}
