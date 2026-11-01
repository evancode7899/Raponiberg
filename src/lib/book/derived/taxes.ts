import type { TaxReport } from "../../tax/buildTaxReport.ts";
import { taxComparison } from "../../tax/comparison.ts";
import { worksheetCells } from "../../tax/worksheetExtras.ts";
import { incomeCells } from "../../tax/incomeExtras.ts";
import { overviewCells } from "../../tax/overviewExtras.ts";
import { W4_REACHES, w4Cells } from "../../tax/w4Extras.ts";
import { c, ln, r, tableFigures, type DerivedFigure, type TableCell } from "./types.ts";

/**
 * Taxes' derived figures for a year: the tables the tabs draw from the year's report beyond
 * the Worksheet's own lines (proven as tax estimates): Joint vs separate, cell by cell, and
 * what filing separately saves; the dependent's effect. The page draws each from this list.
 */
export function taxesDerived(report: TaxReport): DerivedFigure[] {
  const y = report.year;
  const cmp = taxComparison(report);
  const money = (kind: string) => kind !== "pct" && kind !== "bracket";
  const cells: TableCell[] = cmp.rows.flatMap((row) =>
    row.values.map((v, j) => ({ row: row.id, col: cmp.cols[j]!.id, describes: `${y} ${row.label}, ${cmp.cols[j]!.name}`, value: v == null ? null : money(row.kind) ? c(v) : r(v) })),
  );
  const deps: TableCell[] = cmp.dependents.flatMap((row) => row.values.map((v, j) => ({ row: row.id, col: cmp.dependentCols[j]!, describes: `${y} the dependent's effect, ${row.label}: ${cmp.dependentCols[j]}`, value: c(v!) })));
  return [
    ...tableFigures("compare", y, cells),
    ...tableFigures("dependents", y, deps),
    { figure: "compare-diff", key: String(y), describes: `${y}: separate returns' tax less the joint return's`, value: c(cmp.diff), lines: [] },
    ...tableFigures("overview", y, overviewCells(report).map((x) => ({ ...x, describes: `${y} ${x.describes}` }))),
    ...W4_REACHES.flatMap((reach) => tableFigures("w4", `${y}:${reach}`, w4Cells(report, reach).map((x) => ({ ...x, describes: `${y} ${x.describes}, the new W-4 reaching paycheck ${Number(reach) + 1} from now` })))),
    ...tableFigures("income", y, incomeCells(report).map((x) => ({ ...x, describes: `${y} ${x.describes}` }))),
    ...(["projected", "ytd"] as const).flatMap((basis) => tableFigures("worksheet", `${y}:${basis}`, worksheetCells(report, basis).map((x) => ({ ...x, describes: `${y} ${basis === "ytd" ? "to date" : "projected"}: ${x.describes}` })))),
  ];
}

/** The year's federal marginal rate on the next dollar of joint income (key: the year): what the Mortgage page links for the interest deduction. */
export function marginalDerived(t: Pick<TaxReport, "year" | "marginal">): DerivedFigure[] {
  return [{ figure: "marginal-federal", key: String(t.year), describes: `The federal income-tax rate on the next dollar, ${t.year}`, value: r(t.marginal.federal), lines: [ln("The tax estimate's federal bracket on the next dollar", r(t.marginal.federal))] }];
}
