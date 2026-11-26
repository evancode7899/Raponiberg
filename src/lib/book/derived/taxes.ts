import type { TaxReport } from "../../tax/buildTaxReport.ts";
import { taxComparison } from "../../tax/comparison.ts";
import { worksheetCells } from "../../tax/worksheetExtras.ts";
import { incomeCells } from "../../tax/incomeExtras.ts";
import { overviewCells } from "../../tax/overviewExtras.ts";
import { W4_REACHES, w4Cells } from "../../tax/w4Extras.ts";
import { c, ln, r, tableFigures, type DerivedFigure, type TableCell } from "./types.ts";
import { bracketFill } from "../../tax/bracketFill.ts";
import { harborQuarters } from "../../tax/harborQuarters.ts";
import { bonusGaps } from "../../tax/bonusGap.ts";
import type { TaxMoved } from "../../tax/whyMoved.ts";
import { estimateColumns, type EstimateKey } from "../../tax/estimateLines.ts";
import { taxYearParams } from "../../tax/params.ts";

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
    // Joint vs separate says what one saves only once it's $100 or more ("about the same" under that).
    ...(Math.abs(cmp.diff) >= 100 ? [{ figure: "compare-diff", key: String(y), describes: `${y}: separate returns' tax less the joint return's`, value: c(cmp.diff), lines: [] }] : []),
    ...tableFigures("overview", y, overviewCells(report).map((x) => ({ ...x, describes: `${y} ${x.describes}` }))),
    ...W4_REACHES.flatMap((reach) => tableFigures("w4", `${y}:${reach}`, w4Cells(report, reach).map((x) => ({ ...x, describes: `${y} ${x.describes}, the new W-4 reaching paycheck ${Number(reach) + 1} from now` })))),
    ...bracketDerived(report),
    ...tableFigures("harbor", y, harborCells(report)),
    ...tableFigures("bonus-gap", y, bonusGapCells(report)),
    ...tableFigures("income", y, incomeCells(report).map((x) => ({ ...x, describes: `${y} ${x.describes}` }))),
    ...(["projected", "ytd"] as const).flatMap((basis) => tableFigures("worksheet", `${y}:${basis}`, worksheetCells(report, basis).map((x) => ({ ...x, describes: `${y} ${basis === "ytd" ? "to date" : "projected"}: ${x.describes}` })))),
  ];
}

/** The safe-harbor tracker's authorities (Payments): federal, Connecticut, and New York when the year has a New York return. */
export function harborsOf(report: TaxReport) {
  const h = report.safeHarbor;
  return [
    { id: "FEDERAL" as const, name: "Federal", sh: h.federal },
    { id: "CT" as const, name: "Connecticut", sh: h.ct },
    ...(h.ny ? [{ id: "OTHER_STATE" as const, name: "New York", sh: h.ny }] : []),
  ].map((a) => ({ ...a, quarters: harborQuarters(a.sh, report.year, report.payments, a.id, report.today) }));
}

/** Payments › safe harbor quarter by quarter (tax/harborQuarters.ts): rows `<authority>:<quarter>`, columns required, withheld, estimates, short. */
function harborCells(report: TaxReport): TableCell[] {
  return harborsOf(report).flatMap((a) =>
    a.quarters.flatMap((q) => {
      const row = `${a.id}:${q.quarter}`;
      const at = `${a.name}, by the Q${q.quarter} due date (${q.date})`;
      return [
        { row, col: "required", describes: `${at}: ${q.quarter} quarter${q.quarter > 1 ? "s" : ""} of the required annual payment`, value: c(q.requiredCents) },
        { row, col: "withheld", describes: `${at}: ${q.quarter} quarter${q.quarter > 1 ? "s" : ""} of the year's withholding`, value: c(q.withheldCents) },
        { row, col: "estimates", describes: `${at}: estimated payments on file by then`, value: c(q.estimatesCents) },
        { row, col: "short", describes: `${at}: short of the required amount`, value: c(q.shortCents) },
        // A zero draws a dash, not a figure.
      ].filter((x) => !("cents" in x.value) || x.value.cents !== 0);
    }),
  );
}

/** W-4 › bonus withholding (tax/bonusGap.ts), per person: rows `<person>:<check>`, columns gross, withheld, at-rate, gap. */
export const bonusGapsOf = (report: TaxReport) => (!report.isCurrentYear ? [] : report.people).map((p) => ({ id: p.id, name: p.name, rows: bonusGaps(p.bonusChecks ?? [], report.marginal.federal) }));

function bonusGapCells(report: TaxReport): TableCell[] {
  return bonusGapsOf(report).flatMap((p) =>
    p.rows.flatMap((x, i) => {
      const row = `${p.id}:${i}`;
      const at = `${p.name}'s bonus ${x.payDate ?? x.label}`;
      return [
        { row, col: "gross", describes: `${at}: bonus pay`, value: c(x.grossCents) },
        { row, col: "withheld", describes: `${at}: federal tax withheld${x.withheldFrom === "STUB" ? ", as the stub prints it" : " at the 22% supplemental rate"}`, value: c(x.withheldCents) },
        { row, col: "at-rate", describes: `${at}: at the year's federal rate on the next dollar`, value: c(x.atRateCents) },
        { row, col: "gap", describes: `${at}: at that rate less withheld`, value: c(x.gapCents) },
      ].filter((cell) => !("cents" in cell.value) || cell.value.cents !== 0);
    }),
  );
}

/** Overview › why tax moved (tax/whyMoved.ts): rows the parts and the total, columns prior, now, change. Key scope: the later year. */
export function movedDerived(m: TaxMoved): DerivedFigure[] {
  const cells = [...m.rows, m.total].flatMap((x): TableCell[] =>
    [
      { row: x.id, col: "prior", describes: `${x.label}, ${m.prior}`, value: c(x.priorCents) },
      { row: x.id, col: "now", describes: `${x.label}, ${m.year}`, value: c(x.cents) },
      { row: x.id, col: "change", describes: `${x.label}: ${m.year} less ${m.prior}`, value: c(x.deltaCents) },
    ].filter((cell) => "cents" in cell.value! && Math.round(cell.value!.cents) !== 0),
  );
  return tableFigures("moved", m.year, cells);
}

/** A bracket's key: the year and the bracket (0 = 10%). */
export const bracketKey = (year: number, i: number) => `${year}|${i}`;

/** The household's return's ordinary taxable income as it fills the federal brackets (tax/bracketFill.ts). */
export function bracketsOf(report: TaxReport) {
  const joint = estimateColumns(report, "projected").cols.find((x) => x.id === "joint")!;
  const f = joint.r.federal;
  const ordinary = Math.max(0, f.taxableIncome - Math.min(Math.max(0, f.preferentialIncome), Math.max(0, f.taxableIncome)));
  return { ordinary, taxable: f.taxableIncome, preferential: f.preferentialIncome, slices: bracketFill(ordinary, taxYearParams(report.year).federal.brackets[report.filingStatus]) };
}

/**
 * Overview › the brackets: each federal bracket's share of the year's ordinary taxable income
 * and the tax on it (key: bracketKey), worked out from the Worksheet's taxable income less the
 * part taxed at 0/15/20%. A bracket the income doesn't reach is left out.
 */
export function bracketDerived(report: TaxReport): DerivedFigure[] {
  const y = report.year;
  const b = bracketsOf(report);
  const est = (key: EstimateKey, label: string, cents: number, op?: "−") => ln(label, c(cents), op, { source: "derived", link: { label, descriptor: { report: "tax-estimate", year: y, basis: "projected", key } } });
  const base = [est("fed.taxableIncome", "Federal taxable income", b.taxable), est("fed.preferentialIncome", "Taxed at 0/15/20% instead", Math.min(Math.max(0, b.preferential), Math.max(0, b.taxable)), "−"), ln("Ordinary taxable income", c(b.ordinary), "=")];
  return b.slices.flatMap((s, i): DerivedFigure[] => {
    if (!s.incomeCents) return [];
    const span = `${Math.round(s.rate * 100)}% bracket`;
    return [
      { figure: "bracket-income", key: bracketKey(y, i), describes: `${y}: ordinary taxable income in the ${span}`, value: c(s.incomeCents), lines: [...base, ln(`The part of it in the ${span}`, c(s.incomeCents), undefined, { source: "law", note: "Between the bracket's bounds for the year and filing status." })] },
      { figure: "bracket-tax", key: bracketKey(y, i), describes: `${y}: tax on the income in the ${span}`, value: c(s.taxCents), lines: [ln(`Income in the ${span}`, c(s.incomeCents)), ln("× the bracket's rate", r(s.rate), "×", { source: "law" }), ln("Tax", c(s.taxCents), "=")] },
    ];
  });
}

/** The year's federal marginal rate on the next dollar of joint income (key: the year): what the Mortgage page links for the interest deduction. */
export function marginalDerived(t: Pick<TaxReport, "year" | "marginal">): DerivedFigure[] {
  return [{ figure: "marginal-federal", key: String(t.year), describes: `The federal income-tax rate on the next dollar, ${t.year}`, value: r(t.marginal.federal), lines: [ln("The tax estimate's federal bracket on the next dollar", r(t.marginal.federal))] }];
}
