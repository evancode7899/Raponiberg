"use client";

import { Card } from "@/components/ledger/LedgerBits";
import { NotFigure } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { taxesDerived } from "@/lib/book/derived/taxes";
import { cellKey, derivedTarget } from "@/lib/book/derived/types";
import { taxComparison, type CompareRow } from "@/lib/tax/comparison";
import { useMemo } from "react";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { balanceText, lawLabel, NumberTable, pct, usd, type Row } from "./taxUi";

/** Line-by-line: each spouse filing separately, the two combined, and the joint return. */
export function TaxComparison({ r }: { r: TaxResponse }) {
  const cmp = useMemo(() => taxComparison(r), [r]);
  // Every number here is the year's own derived figure (book/derived/taxes.ts), held to its proof.
  const derived = useMemo(() => taxesDerived(r), [r]);
  const cell = (figure: string, row: string, col: string | number, text: string, drawn?: "zero") => (
    <ProofValue proof={derivedTarget("taxes", derived, figure, cellKey(r.year, row, col))} drawn={drawn ? { zeroWithin: 1 } : undefined}>
      {text}
    </ProofValue>
  );
  const show = (row: CompareRow, v: number | null, j: number): string => {
    if (v == null) return "—";
    if (row.kind === "pct") return pct(v);
    if (row.kind === "bracket") return pct(v, 0);
    if (row.kind === "balance") return balanceText(v);
    if (row.kind === "deduction") return `${usd(v)} ${row.words![j]}`;
    return usd(v);
  };
  const rows: Row[] = cmp.rows.map((row) => ({
    label: lawLabel(row.label),
    values: row.values.map((v, j) => (v == null ? (row.kind === "bracket" ? "" : "—") : cell("compare", row.id, cmp.cols[j]!.id, show(row, v, j), row.kind === "balance" ? "zero" : undefined))),
    ...(row.strong ? { strong: true } : {}),
    ...(row.indent ? { indent: true } : {}),
    ...(row.help ? { help: row.help } : {}),
  }));
  const diff = cmp.diff;
  const saves = (text: string) => <ProofValue proof={derivedTarget("taxes", derived, "compare-diff", String(r.year))}>{text}</ProofValue>;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Married filing jointly vs separately"
        subtitle={
          Math.abs(diff) < 100 ? (
            "Both come out about the same."
          ) : diff > 0 ? (
            <>Filing jointly saves {saves(usd(diff))}.</>
          ) : (
            <>Filing separately saves {saves(usd(-diff))}.</>
          )
        }
      >
        <NumberTable columns={cmp.cols.map((c) => c.name)} rows={rows} />
        <p className="mt-2 text-xs text-muted">
          <NotFigure why="set by tax law">
            Filing separately: each spouse reports their own pay and accounts; joint accounts, joint estimated payments and household deductions are split evenly. Separate filers lose the
            dependent-care credit, get half the SALT cap and capital-loss limit, and hit the 0.9%/3.8% surtaxes and the child-credit phase-out at half the joint thresholds.
          </NotFigure>
        </p>
      </Card>
      <Card title="Effect of the dependent">
        <NumberTable columns={["Without", "With", "Savings"]} rows={cmp.dependents.map((row) => ({ label: row.label, values: row.values.map((v, j) => cell("dependents", row.id, cmp.dependentCols[j]!, usd(v))) }))} />
      </Card>
    </div>
  );
}
