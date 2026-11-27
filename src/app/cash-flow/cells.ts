import { compositeOf, sumOf, type ProofRef } from "@/components/ui/proof/context";
import { isUnswept, noFigure } from "@/lib/book/proof/clearance";
import type { SpendingKind, SpendingMonth } from "@/lib/book/reports/spending";
import type { CashFlowMetric } from "@/lib/book/proof/cashFlowProof";
import type { ProofOptions } from "./model";

/**
 * A chart point's proof on Cash flow, built from the months the sweep proves one by one
 * (figures.ts cashFlowFigures: each month's income, spending and net, each category's, each
 * band's): a run of months is their sum, an average that sum per month, a share or a rate
 * the arithmetic over those. No new window is swept for a chart (owner's rule: the chart's
 * table is the page's own figures, composed).
 */
export type MonthPick = { metric: "income" | "spending" | "net"; category?: string; spendingKind?: SpendingKind };
type ProofOf = (metric: CashFlowMetric, months: SpendingMonth[], o: ProofOptions) => ProofRef;

const KIND_CENTS: Record<SpendingKind, keyof SpendingMonth["kinds"]> = { bill: "billCents", big: "bigCents", everyday: "everydayCents" };

/** A month's value of one figure, as the sweep proves it. */
export function monthCents(m: SpendingMonth, p: MonthPick): number {
  if (p.spendingKind) return m.kinds[KIND_CENTS[p.spendingKind]];
  if (p.category) return (p.metric === "income" ? m.incomeByCategory : m.spendingByCategory).find((c) => c.category === p.category)?.cents ?? 0;
  return p.metric === "income" ? m.incomeCents : p.metric === "spending" ? m.spendingCents : m.netCents;
}

/** Whether a month has the figure at all: a category the month never touched has none (the sweep proves the categories a month has). */
const has = (m: SpendingMonth, p: MonthPick) => !p.category || (p.metric === "income" ? m.incomeByCategory : m.spendingByCategory).some((c) => c.category === p.category);

/** One month's proof of one figure; a category the month never touched is a zero with nothing to prove. */
export const monthProof = (proof: ProofOf, m: SpendingMonth, p: MonthPick): ProofRef =>
  has(m, p)
    ? proof(p.metric, [m], { ...(p.category ? { category: p.category } : {}), ...(p.spendingKind ? { spendingKind: p.spendingKind } : {}), shownCents: monthCents(m, p) })
    : noFigure("nothing in it that month", true);

/** A run of months added up, each month that has the figure its own proof (one without it adds nothing). */
export const runSum = (proof: ProofOf, months: readonly SpendingMonth[], p: MonthPick): ProofRef => runsSum(proof, months, [p]);

/** A run's average per month: the months added up, shown per month of the run (a month without the figure counts as a zero). */
export function runAverage(proof: ProofOf, months: readonly SpendingMonth[], p: MonthPick): ProofRef {
  const s = runSum(proof, months, p);
  return isUnswept(s) || months.length <= 1 ? s : { ...s, perMonths: months.length };
}

/** Several figures' runs added up (a group of categories): one sum of every month of each that has it. */
export function runsSum(proof: ProofOf, months: readonly SpendingMonth[], picks: readonly MonthPick[]): ProofRef {
  const parts = picks.flatMap((p) => months.filter((m) => has(m, p)).map((m) => monthProof(proof, m, p)));
  if (!parts.length) return noFigure("nothing in it in these months", true);
  return sumOf(parts, picks.reduce((s, p) => s + months.reduce((t, m) => t + monthCents(m, p), 0), 0));
}

/** One figure as a share of another (the ratio the page draws), or nothing to show when the whole is zero. */
export function shareOf(part: ProofRef, whole: ProofRef, partCents: number, wholeCents: number): ProofRef {
  if (!wholeCents) return noFigure("a share of nothing");
  return compositeOf("share", [part, whole], { ratio: partCents / wholeCents });
}

/** A run's savings rate: its income less its spending, over its income. */
export function savingsRateOf(proof: ProofOf, months: readonly SpendingMonth[]): ProofRef {
  const inc = months.reduce((s, m) => s + m.incomeCents, 0);
  const sp = months.reduce((s, m) => s + m.spendingCents, 0);
  if (inc <= 0) return noFigure("no income to save from");
  const saved = compositeOf("diff", [runSum(proof, months, { metric: "income" }), runSum(proof, months, { metric: "spending" })], { cents: inc - sp });
  return compositeOf("share", [saved, runSum(proof, months, { metric: "income" })], { ratio: (inc - sp) / inc });
}
