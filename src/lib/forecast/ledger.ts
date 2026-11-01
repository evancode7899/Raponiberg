import type { LedgerLine } from "../book/proof/forecastProof.ts";
import type { AnnualProfileReport } from "../profile/buildAnnualProfile.ts";
import type { Forecast } from "./forecast.ts";
import { monthPeriods, yearPeriods, type Flows, type Period } from "./periods.ts";

/**
 * What the Forecast ledger can draw, in one place for the page (ForecastLedger) and the
 * proof sweep (proof/figures.ts forecastFigures): its views, the columns of each, and the
 * lines it draws over them. So the sweep clears exactly the cells the page can show, no
 * more (a cell nothing draws) and no fewer (a cell the page would withhold).
 */

/** How many years past this one the year view runs, or "all": through the forecast's last year. */
export type LedgerSpan = "5" | "10" | "all";
export const LEDGER_SPANS: readonly LedgerSpan[] = ["5", "10", "all"];

/** A view of the ledger: the years through a span, or one year month by month. */
export type LedgerView = { span: LedgerSpan } | { monthsOf: number };

/** Lines drawn only when some column of the view isn't zero. */
const OPTIONAL = new Set<LedgerLine>(["otherIncome", "partnerKept", "bonusSpent", "oneOffs"]);

/** A line's value in a column, as the ledger reads it. */
export function ledgerValue(x: Flows, line: LedgerLine): number | null {
  if (line === "toLiquid") return x.saved == null || x.toRetirement == null ? null : x.saved - x.toRetirement;
  if (line === "netWorth" || line === "liquid" || line === "illiquid") return x.close?.[line] ?? null;
  return x[line];
}

/** The forecast's first and last year: the years a month view can show. */
export const ledgerYears = (f: Forecast) => ({ first: f.months[0]?.year ?? f.plan.start.year, last: f.months.at(-1)?.year ?? f.plan.start.year });

/** A view's columns. */
export function ledgerColumns(f: Forecast, r: AnnualProfileReport, v: LedgerView): Period[] {
  if ("monthsOf" in v) return monthPeriods(f, r, v.monthsOf);
  const through = v.span === "all" ? ledgerYears(f).last : r.currentYear + Number(v.span);
  return yearPeriods(f, r, { actualYears: 1, throughYear: through });
}

/** Whether the view draws a line: every line but the optional ones, which show when some column isn't zero. */
export const ledgerDraws = (line: LedgerLine, columns: readonly Period[]) => !OPTIONAL.has(line) || columns.some((p) => (ledgerValue(p.flows, line) ?? 0) !== 0);

/** Every view the page can show: each span, and each year month by month. */
export function ledgerViews(f: Forecast): LedgerView[] {
  const { first, last } = ledgerYears(f);
  return [...LEDGER_SPANS.map((span) => ({ span })), ...Array.from({ length: last - first + 1 }, (_, i) => ({ monthsOf: first + i }))];
}
