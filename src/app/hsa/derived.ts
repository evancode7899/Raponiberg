import { useMemo } from "react";
import { hsaPageDerived } from "@/lib/book/derived/planning";
import { derivedTarget } from "@/lib/book/derived/types";
import { sumOf, type ProofRef } from "@/components/ui/proof/context";
import type { ExpenseView, HsaReport } from "@/lib/hsa/report";

/** A figure the HSA page works out from its report (book/derived/planning.ts hsaPageDerived), as a proof. */
export type HsaDp = (figure: string, key?: string) => ProofRef;

export function useHsaDerived(r: HsaReport | null | undefined): HsaDp {
  const list = useMemo(() => (r ? hsaPageDerived(r) : []), [r]);
  return (figure, key) => derivedTarget("hsa", list, figure, key);
}

/** Logged expenses added up: each one's own figure. */
export const expensesSum = (dp: HsaDp, xs: readonly ExpenseView[]): ProofRef => sumOf(xs.map((e) => dp("expense", e.id)), xs.reduce((s, e) => s + e.amountCents, 0));

/** Statement charges added up, each the ledger row it is (a charge: negative on the row). */
export const chargesSum = (xs: readonly { rowId: string | null; amountCents: number }[]): ProofRef =>
  sumOf(
    xs.map((x) => (x.rowId ? { descriptor: { report: "row", rowId: x.rowId }, shownCents: -x.amountCents } : { unswept: "a charge no longer in the ledger" })),
    -xs.reduce((s, x) => s + x.amountCents, 0),
  );
