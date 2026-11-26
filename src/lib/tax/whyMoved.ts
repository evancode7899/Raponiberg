import type { TaxReport } from "./buildTaxReport.ts";
import { taxComparison } from "./comparison.ts";

/**
 * Why the household's tax moved from one year to the next: the total tax on each year's own
 * return (the Joint vs separate table's household column, "Total tax") split into its parts,
 * each part's change beside it. The parts are the return's own lines; whatever the total holds
 * beyond them (Connecticut's paid-leave payroll tax) is one line of its own, so the changes add
 * up to the change in the total to the cent. A year a part doesn't exist in counts it as zero.
 */

export type MovedRow = { id: string; label: string; priorCents: number; cents: number; deltaCents: number };
export type TaxMoved = { year: number; prior: number; rows: MovedRow[]; total: MovedRow };

/** The parts of the total, in the order the return computes them. */
const PARTS: [id: string, label: string][] = [
  ["ordinary-tax", "Federal tax on ordinary income"],
  ["preferential-tax", "Federal tax on qualified dividends & long-term gains"],
  ["amt", "Alternative minimum tax"],
  ["credits", "Federal credits"],
  ["medicare-extra", "Additional Medicare tax (0.9%)"],
  ["niit", "Net investment income tax (3.8%)"],
  ["ct", "Connecticut tax"],
  ["ny-state", "New York State tax"],
  ["ny-city", "New York City tax"],
  ["social-security", "Social Security"],
  ["medicare", "Medicare (1.45%)"],
];

/** The household's own return's value of each comparison row: the last column (Joint, or the filer's in a Single year). */
function household(r: Pick<TaxReport, "scenarios" | "people">): Map<string, number> {
  const cmp = taxComparison(r);
  const j = cmp.cols.length - 1;
  return new Map(cmp.rows.flatMap((row) => (row.kind === "usd" && row.values[j] != null ? [[row.id, row.values[j]!] as const] : [])));
}

export function taxMoved(cur: Pick<TaxReport, "year" | "scenarios" | "people">, prior: Pick<TaxReport, "year" | "scenarios" | "people">): TaxMoved {
  const now = household(cur);
  const was = household(prior);
  const row = (id: string, label: string, p: number, c: number): MovedRow => ({ id, label, priorCents: p, cents: c, deltaCents: c - p });
  const rows = PARTS.map(([id, label]) => row(id, label, was.get(id) ?? 0, now.get(id) ?? 0)).filter((x) => x.priorCents || x.cents);
  const total = row("total", "Total tax", was.get("total") ?? 0, now.get("total") ?? 0);
  const restPrior = total.priorCents - rows.reduce((s, x) => s + x.priorCents, 0);
  const restNow = total.cents - rows.reduce((s, x) => s + x.cents, 0);
  if (Math.round(restPrior) || Math.round(restNow)) rows.push(row("other", "Other lines of the total (Connecticut paid leave and the like)", restPrior, restNow));
  return { year: cur.year, prior: prior.year, rows, total };
}
