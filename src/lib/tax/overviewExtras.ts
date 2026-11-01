import type { ProofValue } from "../book/proof/types.ts";
import type { TaxReport } from "./buildTaxReport.ts";
import { estimateColumns, lineValue, type EstimateColumn } from "./estimateLines.ts";

/**
 * Taxes › Overview beyond its estimate lines, as numbers: where the year's income goes
 * (each bucket), where the next $1,000 of pay goes, the dependent's effect, each return's
 * true-up, the taxes paid so far, and each employer's paycheck. One pure function for the
 * page and its proofs (book/derived/taxes.ts).
 */

export type OverviewCell = { row: string; col: string; describes: string; value: ProofValue };

/** The joint return's buckets as the Worksheet's projected column has it. */
export function taxBuckets(c: EstimateColumn) {
  const x = c.r;
  const federal = x.federal.totalTax - x.federal.refundableChildCredit;
  const payroll = x.fica.socialSecurity + x.fica.medicare + x.fica.ctPfml;
  const ny = x.ny?.totalTax ?? 0;
  const gross = lineValue("all.earnedPlusInvestment", c) ?? 0;
  const total = lineValue("all.totalTaxes", c) ?? 0;
  return { federal, ct: x.ct.totalTax, ny, other: x.otherStateTax, payroll, total, gross, kept: lineValue("all.takeHome", c) ?? 0 };
}

export const jointColumn = (r: Parameters<typeof estimateColumns>[0]) => estimateColumns(r, "projected").cols.find((c) => c.id === "joint")!;

/** The returns Overview › At filing draws a card for: federal always, Connecticut when it taxes or holds payments (or you live there), New York with a New York return. */
export function atFilingReturns(r: Pick<TaxReport, "scenarios" | "residency">): ("fed" | "ct" | "ny")[] {
  const mfj = r.scenarios.mfj;
  return ["fed", ...(mfj.ct.totalTax || mfj.ct.totalPayments || r.residency.ct !== "NONRESIDENT" ? (["ct"] as const) : []), ...(mfj.ny ? (["ny"] as const) : [])];
}

/** Where the next $1,000 of pay goes, in cents of it. */
export function nextThousand(m: TaxReport["marginal"]) {
  return {
    keep: Math.round((1 - m.federal - m.ct - m.ny - m.payroll) * 100_000),
    federal: Math.round(m.federal * 100_000),
    ct: Math.round(m.ct * 100_000),
    ny: Math.round(m.ny * 100_000),
    payroll: Math.round(m.payroll * 100_000),
  };
}

/** The dependent's effect on the joint return, tax by tax. */
export function dependentEffect(r: Pick<TaxReport, "scenarios">, b: ReturnType<typeof taxBuckets>) {
  const mfj = r.scenarios.mfj;
  const fed = r.scenarios.mfjNoDependents.federal.totalTax - r.scenarios.mfjNoDependents.federal.refundableChildCredit - b.federal;
  const ct = r.scenarios.mfjNoDependents.ct.totalTax - mfj.ct.totalTax;
  const ny = (r.scenarios.mfjNoDependents.ny?.totalTax ?? 0) - b.ny;
  return {
    fed,
    ct,
    ny,
    total: fed + ct + ny,
    fedChild: mfj.federal.childTaxCredit + mfj.federal.refundableChildCredit,
    otherCredits: mfj.federal.otherDependentCredit + mfj.federal.dependentCareCredit,
    ctChild: mfj.ct.childTaxCredit,
  };
}

export const PAID_ROWS = ["federal", "socialSecurity", "medicare", "ct", "ctPfml", "otherState", "estimatesFederal", "estimatesCt"] as const;
export const paidTotal = (t: TaxReport["people"][number]["paidToDate"]) => PAID_ROWS.reduce((s, k) => s + t[k], 0);

export function overviewCells(r: TaxReport): OverviewCell[] {
  const out: OverviewCell[] = [];
  const add = (row: string, col: string, describes: string, value: ProofValue) => out.push({ row, col, describes, value });
  const b = taxBuckets(jointColumn(r));
  // Where the income goes: a state's or other states' share only once it taxes anything (as the bar draws it).
  for (const [id, cents] of Object.entries({ kept: b.kept, federal: b.federal, ct: b.ct, ny: b.ny, other: b.other, payroll: b.payroll }))
    if (!["ct", "ny", "other"].includes(id) || cents) add("bucket", id, `Where the income goes: ${id}`, { cents });
  const m = r.marginal;
  add("marginal", "all", "Marginal rate on the next $1,000 of pay, every tax", { ratio: m.federal + m.ct + m.ny + m.payroll });
  // The next $1,000: a tax's part only where its marginal rate isn't zero.
  const rateOf: Record<string, number> = { ct: m.ct, ny: m.ny, payroll: m.payroll };
  for (const [id, cents] of Object.entries(nextThousand(m))) if (!(id in rateOf) || rateOf[id]) add("next", id, `The next $1,000 of pay: ${id}`, { cents });
  // The dependent's effect, with dependents: each credit and the total (New York's with a New York return).
  const d = dependentEffect(r, b);
  if (r.dependents.length)
    for (const [id, cents] of Object.entries({ fedChild: d.fedChild, otherCredits: d.otherCredits, ctChild: d.ctChild, ...(r.scenarios.mfj.ny ? { ny: d.ny } : {}), total: d.total })) add("dependent", id, `The dependent's effect: ${id}`, { cents });
  for (const which of ["federal", "ct"] as const) {
    const sh = r.safeHarbor[which];
    const plan = r.plan[which];
    const t = (row: string, describes: string, cents: number) => add(`trueup:${row}`, which, `${which === "federal" ? "Federal" : "Connecticut"} true-up: ${describes}`, { cents });
    t("tax", "projected tax for the year", sh.currentYearTax);
    t("required", "the safe harbor to pay", sh.requiredAnnualPayment);
    t("withholding", "withholding through year end", sh.withholding);
    t("estimates", "estimated payments", sh.estimatesPaid);
    t("shortfall", "short of the safe harbor", plan.safeHarborShortfall);
    t("balance", "projected balance at filing", plan.projectedBalanceDue);
    if (plan.perPaycheckForSafeHarbor != null) t("per-paycheck", "extra withholding per paycheck for the safe harbor", plan.perPaycheckForSafeHarbor);
    if (plan.perPaycheckToBreakEven != null) t("break-even", "extra withholding per paycheck to owe nothing", plan.perPaycheckToBreakEven);
    // Said only beside a projected refund of $1 or more.
    if (r.plan.remainingPaychecks && plan.projectedBalanceDue <= -100) t("over", "over-withheld per remaining paycheck", -plan.projectedBalanceDue / r.plan.remainingPaychecks);
  }
  for (const p of r.people) {
    for (const k of PAID_ROWS) add(`paid:${k}`, p.id, `${p.name}: paid so far, ${k}`, { cents: p.paidToDate[k] });
    add("paid:total", p.id, `${p.name}: paid so far, every tax`, { cents: paidTotal(p.paidToDate) });
    // Overview › forecast to December 31 (the year in progress): each employer still paying, at the paycheck the year runs on.
    if (r.isCurrentYear) for (const e of p.payroll) if (e.active && e.remainingPayDates.length > 0 && e.regularPaycheck) add(`paycheck:${e.employer}`, p.id, `${p.name}, ${e.employer}: the paycheck the year runs on, gross`, { cents: e.regularPaycheck.gross });
  }
  // Last year's return, as read from the filed return or the app's estimate of it (Inputs; the safe harbor reads it).
  for (const [k, cents] of [["federalTotalTax", r.priorYear.federalTax], ["federalAgi", r.priorYear.federalAgi], ["ctTotalTax", r.priorYear.ctTax]] as const)
    if (cents != null) add(`prior:${k}`, "auto", `${r.year - 1} return: ${k}`, { cents });
  // Each person's paychecks the year runs on, and the forecast's bonuses still to come (Inputs).
  for (const p of r.people) {
    const job = p.payroll.find((e) => e.active);
    // Inputs (the year in progress) says which the forecast pays the rest of the year at.
    const fc = r.isCurrentYear ? p.fromForecast : null;
    if (fc?.paycheck === "LATEST" && job?.latestRegular) add("paycheck:latest", p.id, `${p.name}: the latest regular paycheck, gross`, { cents: job.latestRegular.amounts.gross });
    if (fc?.paycheck === "TYPICAL" && job?.typicalRegular) add("paycheck:typical", p.id, `${p.name}: the typical recent paycheck, gross`, { cents: job.typicalRegular.amounts.gross });
    p.fromForecast?.items.forEach((b, i) => add(`forecast-item:${i}`, p.id, `${p.name}: ${b.label}, from the forecast`, { cents: b.gross }));
  }
  // The filed return against the model: what an amendment would change, and each source against the ledger (Filed return).
  const check = r.documents?.check;
  if (check?.amendment) for (const k of ["federal", "ct", "ny"] as const) if (check.amendment[k] != null) add("amendment", k, `An amendment would change ${k} tax by`, { cents: check.amendment[k]! });
  check?.sources.forEach((x, i) => {
    add(`source:${i}`, "document", `${x.label}, as ${x.document} prints it`, { cents: x.documentValue });
    if (x.ledgerValue != null) add(`source:${i}`, "ledger", `${x.label}, as the ledger has it`, { cents: x.ledgerValue });
  });
  for (const k of PAID_ROWS) add(`paid:${k}`, "total", `Paid so far, ${k}, everyone`, { cents: r.people.reduce((s, p) => s + p.paidToDate[k], 0) });
  add("paid:total", "total", "Paid so far, every tax, everyone", { cents: r.people.reduce((s, p) => s + paidTotal(p.paidToDate), 0) });
  return out;
}
