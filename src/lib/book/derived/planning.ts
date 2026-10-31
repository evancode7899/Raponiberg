import type { MoneyCalendarReport } from "../reports/moneyCalendar.ts";
import type { TaxAccountsReport } from "../reports/taxAccounts.ts";
import type { HsaReport } from "../../hsa/report.ts";
import { c, ln, t, type DerivedFigure } from "./types.ts";

/** Account limits for one year (key: the year): how many yearly limits are still open, and MAGI when it's read off pay stubs alone. */
export function accountLimitsDerived(r: Pick<TaxAccountsReport, "year" | "steps" | "magi">): DerivedFigure[] {
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
