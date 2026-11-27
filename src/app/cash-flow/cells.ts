import { averageOf, compositeOf, sumOf, type ProofRef } from "@/components/ui/proof/context";
import { noFigure } from "@/lib/book/proof/clearance";
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

/** One month's proof of one figure. */
export const monthProof = (proof: ProofOf, m: SpendingMonth, p: MonthPick): ProofRef =>
  proof(p.metric, [m], { ...(p.category ? { category: p.category } : {}), ...(p.spendingKind ? { spendingKind: p.spendingKind } : {}), shownCents: monthCents(m, p) });

/** A run of months added up, each month its own proof. */
export const runSum = (proof: ProofOf, months: readonly SpendingMonth[], p: MonthPick): ProofRef =>
  sumOf(months.map((m) => monthProof(proof, m, p)), months.reduce((s, m) => s + monthCents(m, p), 0));

/** A run's average per month: the months added up, shown per month. */
export const runAverage = (proof: ProofOf, months: readonly SpendingMonth[], p: MonthPick): ProofRef =>
  averageOf(months.map((m) => monthProof(proof, m, p)), months.reduce((s, m) => s + monthCents(m, p), 0));

/** Several figures' runs added up (a group of categories): one sum of every month of each. */
export const runsSum = (proof: ProofOf, months: readonly SpendingMonth[], picks: readonly MonthPick[]): ProofRef =>
  sumOf(
    picks.flatMap((p) => months.map((m) => monthProof(proof, m, p))),
    picks.reduce((s, p) => s + months.reduce((t, m) => t + monthCents(m, p), 0), 0),
  );

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

/**
 * Why a per-day chart's table draws n.a. for now: no proof covers one day of a month, and the
 * owner is choosing how to prove one (renderAudit.ts CHART_TABLE_PENDING lists these tables).
 */
export const DAY_PENDING = "A day of the month has no proof of its own yet: the month it falls in has one, and how to prove a single day is the owner's open choice.";
