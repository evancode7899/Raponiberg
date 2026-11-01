import type { MoneyCalendarReport } from "../reports/moneyCalendar.ts";
import type { TaxAccountsReport } from "../reports/taxAccounts.ts";
import type { HsaReport } from "../../hsa/report.ts";
import { c, ln, r, r as r_, t, tableFigures, type DerivedFigure, type TableCell } from "./types.ts";

/** Account limits for one year (key: the year): how many yearly limits are still open, and MAGI when it's read off pay stubs alone. */
export function accountLimitsDerived(r: Pick<TaxAccountsReport, "year" | "steps" | "magi"> & Partial<Pick<TaxAccountsReport, "marginalRate">>): DerivedFigure[] {
  const key = String(r.year);
  const open = r.steps.filter((s) => !s.done);
  const out: DerivedFigure[] = [
    {
      figure: "still-open",
      key,
      describes: `Yearly limits still open, ${r.year}`,
      value: t(String(open.length)),
      lines: [ln("Still open", t(String(open.length)), undefined, { source: "proven" }), ln("Yearly limits", t(String(r.steps.length)))],
      parts: r.steps.map((s) => ({ label: s.title, value: t(s.done ? "done" : "open") })),
    },
  ];
  const m = r.marginalRate;
  if (m?.rate != null)
    out.push({ figure: "marginal-rate", key, describes: `The income-tax rate on the next dollar, ${r.year} (federal + state + city)`, value: r_(m.rate), lines: [ln(m.source === "SETTING" ? "Your setting (Inputs)" : m.source === "PRIOR_YEAR" ? `The tax estimate's, ${r.year - 1}` : "The tax estimate's", r_(m.rate), undefined, { source: m.source === "SETTING" ? "assumption" : "proven" })] });
  if (r.magi.source !== "TAX_REPORT")
    out.push({ figure: "magi-stubs", key, describes: `Household MAGI from pay stub wages only, ${r.year}`, value: c(r.magi.cents), lines: [ln("Wages on the year's pay stubs", c(r.magi.cents), undefined, { source: "proven", note: "The tax estimate isn't provable yet, so MAGI is wages alone." })] });
  return out;
}

/** Calendar items that state an amount no other proof covers (the tax plan's W-4 and Q4 amounts): key: the item's id. */
export function calendarDerived(r: Pick<MoneyCalendarReport, "items">): DerivedFigure[] {
  return r.items
    .filter((i) => !i.proof && i.cents != null)
    .map((i) => ({ figure: "item", key: i.id, describes: `${i.title} (${i.date})`, value: c(i.cents!), lines: [ln(i.title, c(i.cents!), undefined, { note: i.detail })] }));
}

/** The strategy table's columns (HSA › Growth & strategy), per $1,000 of bills. */
export const HSA_STRATEGY_COLUMNS = ["fromHsaCents", "fromBankCents", "taxableNowCents", "hsaNowCents", "worthCents", "aheadCents"] as const;
/** The year table's columns (HSA › Growth & strategy › By year). */
export const HSA_YEAR_COLUMNS = ["totalCents", "unreimbursedCents", "reimbursedInYearCents"] as const;

/**
 * Everything else the HSA page draws beyond its proof kind's figures: each logged expense
 * and its growth from waiting, the growth rate, the bills by year, patient and kind, the
 * found charges' total, the taxable alternative and the per-$1,000 strategy table.
 */
export function hsaPageDerived(rep: HsaReport): DerivedFigure[] {
  const g = rep.growth;
  const out: DerivedFigure[] = [...hsaDerived(rep)];
  for (const e of rep.expenses) {
    out.push({ figure: "expense", key: e.id, describes: `${e.provider || "An expense"} on ${e.date}, as logged`, value: c(e.amountCents), lines: [ln("The bill, as you logged it", c(e.amountCents), undefined, { source: "assumption" })] });
    if (!e.reimbursement && e.growthCents > 0)
      out.push({ figure: "expense-growth", key: e.id, describes: `${e.provider || "An expense"} on ${e.date}: growth from waiting`, value: c(e.growthCents), lines: [ln("Growth on the bill while it waits", c(e.growthCents), undefined, { note: `The bill × ((1 + ${(g.rate * 100).toFixed(1)}%)^(${e.daysWaiting} days ÷ 365.25) − 1)` })] });
  }
  out.push({ figure: "growth-rate", describes: "The growth rate the HSA's money is assumed to earn", value: r(g.rate), lines: [ln(g.rateSource === "MEASURED" ? "Your HSA's measured return" : g.rateSource === "SETTING" ? "Your setting" : g.rateSource === "FORECAST" ? "The forecast's return" : "A built-in default", r(g.rate), undefined, { source: g.rateSource === "MEASURED" ? "proven" : "assumption" })] });
  // What a blank setting falls back to, where that's a number read off your data (Settings' hints).
  const defaults: [string, number | null, string][] = [
    ["growth", rep.hsa.measuredReturn ?? (g.rateSource === "FORECAST" ? g.rate : null), rep.hsa.measuredReturn != null ? "Your HSA's measured return, a year" : "The forecast's return"],
    ["marginal", g.marginalSource === "TAX_REPORT" ? g.marginalRate : null, "The Taxes page's marginal rate (federal with the Medicare surtax, + state)"],
    ["dividend", g.dividendSource === "STATEMENTS" ? g.assumptions.dividendYield : null, "The dividend yield your taxable statements show"],
    ["taxable", g.taxableSource === "TAX_ENGINE" ? g.assumptions.taxableRate : null, "The tax engine's rate on a gain at your forecast salary"],
  ];
  for (const [key, v, words] of defaults) if (v != null) out.push({ figure: "default", key, describes: `Settings: what a blank ${key} rate falls back to`, value: r(v), lines: [ln(words, r(v), undefined, { source: "proven" })] });
  const likely = rep.suggestions.filter((x) => x.tier === "LIKELY");
  out.push({ figure: "found-likely", describes: "Statement charges that look like qualified care and aren't in the log", value: c(likely.reduce((s, x) => s + x.amountCents, 0)), lines: likely.map((x) => ln(`${x.date} ${x.payee}`, c(x.amountCents), "+", { ...(x.rowId ? { link: { label: "The charge", descriptor: { report: "row", rowId: x.rowId } } } : {}) })) });
  if (!g.withheld) {
    out.push({ figure: "taxable-value", describes: `The receipts reimbursed now and invested in a taxable account, worth in ${g.planYear}`, value: c(g.taxableValueCents), lines: [ln("After dividends taxed yearly and the gain at sale", c(g.taxableValueCents))] });
    const cells: TableCell[] = g.strategy.flatMap((s) => HSA_STRATEGY_COLUMNS.map((col) => ({ row: s.key, col, describes: `${s.label}: ${col.replace(/Cents$/, "")} per $1,000 of bills`, value: c(s[col]) })));
    // The ahead column scaled to today's unreimbursed receipts.
    const open = rep.totals.unreimbursedCents;
    if (open > 0) for (const s of g.strategy) cells.push({ row: s.key, col: "aheadOnYours", describes: `${s.label}: ahead on your receipts`, value: c(Math.round((s.aheadCents * open) / 100_000)) });
    out.push(...tableFigures("strategy", "per-1000", cells));
  }
  const yearCells: TableCell[] = rep.years.flatMap((y) => HSA_YEAR_COLUMNS.map((col) => ({ row: String(y.year), col, describes: `Medical bills ${y.year}: ${col.replace(/Cents$/, "")}`, value: c(y[col]) })));
  out.push(...tableFigures("year", "years", yearCells));
  for (const [scope, rows] of [["patient", rep.byPatient], ["kind", rep.byKind]] as const) {
    const cells = rows.flatMap((b) => [
      { row: b.key, col: "total", describes: `Medical bills by ${scope}, ${b.key}`, value: c(b.totalCents) },
      { row: b.key, col: "open", describes: `Medical bills by ${scope}, ${b.key}: still open`, value: c(b.unreimbursedCents) },
    ]);
    out.push(...tableFigures("breakdown", scope, cells));
  }
  return out;
}

/** HSA › Growth: what letting the receipts ride beats reimbursing them now. */
export function hsaDerived(r: Pick<HsaReport, "growth">): DerivedFigure[] {
  const g = r.growth;
  if (g.withheld) return [];
  return [
    {
      figure: "edge",
      describes: `Letting the receipts ride until ${g.planYear} vs reimbursing them now`,
      value: c(g.futureValueCents - g.taxableValueCents),
      lines: [ln(`Left in the HSA until ${g.planYear}, after tax`, c(g.futureValueCents), undefined, { link: { label: "Worth then", descriptor: { report: "hsa", metric: "future" } } }), ln("Reimbursed now and invested in a taxable account", c(g.taxableValueCents), "−"), ln("Edge", c(g.futureValueCents - g.taxableValueCents), "=")],
    },
  ];
}
