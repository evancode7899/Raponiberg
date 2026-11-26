import { formatPercentRatio, usd0 } from "../../formatMoney.ts";
import { typicalKey } from "../derived/netWorth.ts";
import { cellKey, derivedDescriptor } from "../derived/types.ts";
import type { ProofDescriptor } from "../proof/index.ts";
import type { ChangeMover, HighlightSeg, NetWorthChange } from "./netWorthChanges.ts";

/**
 * A month once it's proven, in five plain sentences and one picture: pay, spending, saving,
 * markets and what stood out. Every number in it is a figure What changed already proves
 * (its totals, its averages, its movers) or plain arithmetic over two of them (a composite),
 * so nothing here needs a proof of its own. Pure.
 */

export type MonthStory = {
  label: string;
  start: string;
  sentences: HighlightSeg[][];
  /** The picture: each driver this month against its average (null without one). Dollars, for the chart's bars only. */
  bars: { key: "income" | "spending" | "saved" | "markets"; label: string; now: number; typical: number | null }[];
};

const fig = (text: string, descriptor: ProofDescriptor, value: { cents?: number; ratio?: number }): HighlightSeg => ({ text, descriptor, ...value });
const diff = (a: ProofDescriptor, b: ProofDescriptor): ProofDescriptor => ({ report: "composite", op: "diff", of: [a, b] });
const share = (a: ProofDescriptor, b: ProofDescriptor): ProofDescriptor => ({ report: "composite", op: "share", of: [a, b] });
const way = (cents: number, up: string, down: string) => (cents >= 0 ? up : down);

/** The story of one month of What changed (month granularity). */
export function monthStory(c: NetWorthChange): MonthStory {
  const t = c.typical;
  const typical = (what: string) => derivedDescriptor("net-worth", { figure: "change-typical", key: typicalKey("month", c.start, what) });
  // How far a figure is from its average: "$1,234 more than a typical month (…)".
  const against = (now: number, avg: number | undefined, proof: ProofDescriptor, what: string, more: string, less: string): HighlightSeg[] =>
    t && avg != null ? [", ", fig(usd0(Math.abs(now - avg)), diff(proof, typical(what)), { cents: now - avg }), ` ${way(now - avg, more, less)} than a typical month (`, fig(usd0(avg), typical(what), { cents: avg }), ")"] : [];
  const mover = (m: ChangeMover, metric: "spending" | "income"): HighlightSeg[] => [
    `${m.category}, `,
    fig(usd0(m.cents), m.proof, { cents: m.cents }),
    " against a typical ",
    fig(usd0(m.typicalCents), typical(`${metric}:${m.category}`), { cents: m.typicalCents }),
  ];

  const sentences: HighlightSeg[][] = [];
  sentences.push(
    c.incomeCents ? ["Income came to ", fig(usd0(c.incomeCents), c.proofs.income, { cents: c.incomeCents }), ...against(c.incomeCents, t?.incomeCents, c.proofs.income, "income", "more", "less"), "."] : ["No income came in."],
  );
  const up = c.spendingMovers.filter((m) => m.deltaCents > 0)[0];
  sentences.push([
    "Spending was ",
    fig(usd0(c.spendingCents), c.proofs.spending, { cents: c.spendingCents }),
    ...against(c.spendingCents, t?.spendingCents, c.proofs.spending, "spending", "more", "less"),
    ...(up && t && c.spendingCents > t.spendingCents ? [", led by ", up.category] : []),
    ".",
  ]);
  const kept = c.incomeCents - c.spendingCents;
  const keptProof = diff(c.proofs.income, c.proofs.spending);
  sentences.push([
    ...(kept >= 0
      ? ["You kept ", ...(c.incomeCents > 0 ? [fig(formatPercentRatio(kept / c.incomeCents, 0), share(keptProof, c.proofs.income), { ratio: kept / c.incomeCents }), " of it, "] : []), fig(usd0(kept), keptProof, { cents: kept })]
      : ["Spending ran ", fig(usd0(-kept), keptProof, { cents: kept }), " past income"]),
    "; with retirement money from pay, saving ",
    way(c.savedCents, "added ", "took "),
    fig(usd0(Math.abs(c.savedCents)), c.proofs.saved, { cents: c.savedCents }),
    way(c.savedCents, " to net worth.", " from net worth."),
  ]);
  sentences.push([
    `Markets ${way(c.marketsCents, "added", "took away")} `,
    fig(usd0(Math.abs(c.marketsCents)), c.proofs.markets, { cents: c.marketsCents }),
    ...(c.portfolioReturn != null
      ? [", a ", { text: formatPercentRatio(c.portfolioReturn, 1), descriptor: derivedDescriptor("net-worth", { figure: "built", key: cellKey("month", `${c.start}:return`, "household") }), ratio: c.portfolioReturn }, " return"]
      : []),
    ", and net worth ",
    way(c.changeCents, "rose ", "fell "),
    fig(usd0(Math.abs(c.changeCents)), c.proofs.change, { cents: c.changeCents }),
    ".",
  ]);
  // What stood out: the category furthest from its average, spending or income.
  const all = [...c.spendingMovers.map((m) => ({ m, metric: "spending" as const })), ...c.incomeMovers.map((m) => ({ m, metric: "income" as const }))].sort((a, b) => Math.abs(b.m.deltaCents) - Math.abs(a.m.deltaCents));
  const top = all[0];
  sentences.push(
    top
      ? [`What stood out: ${top.metric === "spending" ? "spending on " : "income from "}`, ...mover(top.m, top.metric), "."]
      : t
        ? ["Nothing stood out: every category was near its average."]
        : ["The first proven month: nothing before it to compare with."],
  );

  const d = (cents: number) => cents / 100;
  return {
    label: c.label,
    start: c.start,
    sentences,
    bars: [
      { key: "income", label: "Income", now: d(c.incomeCents), typical: t ? d(t.incomeCents) : null },
      { key: "spending", label: "Spending", now: d(c.spendingCents), typical: t ? d(t.spendingCents) : null },
      { key: "saved", label: "Saved", now: d(c.savedCents), typical: t ? d(t.savedCents) : null },
      { key: "markets", label: "Markets", now: d(c.marketsCents), typical: t ? d(t.marketsCents) : null },
    ],
  };
}

/** The month that closed most recently, if it's a whole proven month. */
export const latestClosed = (periods: readonly NetWorthChange[]): NetWorthChange | null => {
  const last = periods.at(-1);
  return last && !last.through ? last : null;
};
