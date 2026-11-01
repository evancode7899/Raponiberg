import type { ProofValue } from "../book/proof/types.ts";
import type { TaxReport } from "./buildTaxReport.ts";
import { allTaxes, computeReturn, type PersonIncome, type ReturnResult } from "./computeReturn.ts";
import { estimateColumns, type EstimateBasis, type EstimateColumn } from "./estimateLines.ts";
import { taxYearParams } from "./params.ts";
import { applyWhatIf, NO_WHAT_IF } from "./scenarios.ts";
import { returnSchedules, type Schedule } from "./schedules.ts";

/**
 * Taxes › Worksheet beyond its estimate lines, as numbers: each return's marginal rate on the
 * next $1,000 of pay and its federal bracket, every bracket schedule's bands and totals, and
 * the supporting cards (US-obligation income, CHET, capital gains, IRA rollovers). One pure
 * function for the page and its proofs (book/derived/taxes.ts).
 */

export type WorksheetCell = { row: string; col: string; describes: string; value: ProofValue | null };

const wages = (p: PersonIncome) => p.w2s.reduce((s, w) => s + w.box5MedicareWages, 0);

/** Marginal rate: $1,000 more wages for that return's highest earner, and what every tax takes of it. */
export function marginalRate(c: EstimateColumn, fs: ReturnResult["filingStatus"], r: Pick<TaxReport, "year" | "ny">): number | null {
  const params = taxYearParams(r.year);
  const top = [...c.incomes].sort((a, b) => wages(b) - wages(a))[0];
  if (!top || !top.w2s.length) return null;
  const bumped = applyWhatIf(c.incomes, { ...NO_WHAT_IF, people: { [top.id]: { extraWages: 100_000, extraPretax401k: 0 } } }, params);
  const b = computeReturn({ params, filingStatus: fs, people: bumped, dependents: c.dependents, ny: r.ny?.filing ?? null, itemizeMode: c.r.federal.itemizes ? "ITEMIZE" : "STANDARD" });
  return (allTaxes(b) - allTaxes(c.r)) / 100_000;
}

/** A schedule's numbers, row by row: a calculation's lines, or a bracket schedule's bands (included, owed) and totals. */
export function scheduleCells(s: Schedule, col: string, title: string): WorksheetCell[] {
  const d = (what: string) => `${title}: ${s.title}, ${what}`;
  if (s.kind === "lines") return s.lines.map((l, i) => ({ row: `sched:${s.key}:line:${i}`, col, describes: d(l.label), value: l.kind === "rate" ? { ratio: l.value } : { cents: l.value } }));
  return [
    ...s.rows.flatMap((row, i): WorksheetCell[] => [
      { row: `sched:${s.key}:band:${i}:included`, col, describes: d(`band ${i + 1}, income in it`), value: { cents: row.included } },
      { row: `sched:${s.key}:band:${i}:owed`, col, describes: d(`band ${i + 1}, tax on it`), value: { cents: row.owed } },
    ]),
    { row: `sched:${s.key}:total:included`, col, describes: d("income in every band"), value: { cents: s.included } },
    { row: `sched:${s.key}:total:owed`, col, describes: d("tax over every band"), value: { cents: s.owed } },
    { row: `sched:${s.key}:total:rate`, col, describes: d("average rate"), value: s.included > 0 ? { ratio: s.owed / s.included } : null },
  ];
}

/** Every number the Worksheet draws for a basis beyond its estimate lines, by row and column. */
export function worksheetCells(r: TaxReport, basis: EstimateBasis): WorksheetCell[] {
  const params = taxYearParams(r.year);
  const { cols } = estimateColumns(r, basis);
  const out: WorksheetCell[] = [];
  for (const c of cols) {
    const fs = c.id === "joint" ? c.r.filingStatus : "MFS";
    out.push(
      { row: "marginal", col: c.id, describes: `${c.name}: marginal rate on the next $1,000 of pay`, value: ((m) => (m == null ? null : { ratio: m }))(marginalRate(c, fs, r)) },
      { row: "bracket", col: c.id, describes: `${c.name}: federal bracket`, value: c.r.federal.taxableIncome > 0 ? { ratio: c.r.federal.marginalBracket } : null },
    );
    for (const s of returnSchedules(c.r, c.incomes, params)) out.push(...scheduleCells(s, c.id, c.name));
  }
  // The supporting cards read the joint return (the last column) and the year's documents.
  const joint = cols.at(-1)!.r;
  const pick = basis === "ytd" ? "ytd" : "projected";
  const one = (row: string, describes: string, cents: number) => out.push({ row, col: "joint", describes, value: { cents } });
  one("mm", "Money-market dividends", r.people.flatMap((p) => p.accounts).filter((a) => a.kind === "TAXABLE").reduce((s, a) => s + a[pick].moneyMarketDividends, 0));
  one("us-obligations", "Subtracted from CT AGI (US-obligation income)", joint.ct.usObligationSubtraction);
  one("chet", "CHET 529 contributions this year", r.chet.total);
  one("chet-deducted", "CHET 529 deducted on the joint CT return", joint.ct.chetDeduction);
  one("gain-net", "Net capital gain / (loss)", joint.federal.capitalGainNet);
  one("gain-counted", "Capital gain counted this year (joint)", joint.federal.capitalGainAllowed);
  one("loss-carry", "Capital loss carried to next year", -joint.federal.capitalLossCarryover);
  one("rollovers", "Direct IRA rollovers (not taxable)", r.people.reduce((s, p) => s + p.retirement.rollovers, 0));
  one("conversions", "Roth conversions", r.people.reduce((s, p) => s + p.retirement.conversions, 0));
  one("ira-basis", "Non-deductible IRA basis", -r.people.reduce((s, p) => s + p.retirement.basis, 0));
  one("ira-taxable", "IRA/retirement taxable", joint.federal.retirementTaxable);
  return out;
}
