import type { BlockerQuery } from "../blockers.ts";
import type { BlockerRef } from "./blockerRef.ts";
import type { BonusesReport, Tranche, VestWindow, WindowStatus } from "./bonuses.ts";

/** One of the Bonuses page's figures, as its proof names it (bonusesProof.ts BonusesDescriptor). */
export type BonusFigureRef =
  | { figure: "window"; window: string; measure: "scheduled" | "paid" }
  | { figure: "tranche"; letterId: string; year: number; window: string; kind: string }
  | { figure: "award"; letterId: string; year: number; measure: string }
  | { figure: "letter"; letterId: string; measure: "scheduled" | "paid" }
  | { figure: "totals"; measure: string }
  | { figure: "reconcile"; year: number; personId: string; employer: string }
  | { figure: "estimate" };

const OUTSTANDING_STATUSES: WindowStatus[] = ["UPCOMING", "DUE", "NOT_ON_STUBS", "NO_STUBS"];

/**
 * What one of the page's figures reads from the pay stubs, and so the only pay findings that
 * can withhold it: the one rule the page (to mark it), the sweep and its proof all use. An
 * amount a letter prints reads no stubs. What was paid, forfeited or is still to vest reads
 * the payment windows it settles against, each on its own (a missing stub elsewhere, years
 * later, has no bearing on a window that closed). A year's bonus paychecks read that year's
 * stubs from the employer, to date; total compensation built on base pay from the stubs reads
 * that year's pay.
 */
export function figureReads(r: Pick<BonusesReport, "windows" | "awards" | "byYear">, d: BonusFigureRef): { queries: BlockerQuery[]; blockers: BlockerRef[] } {
  const windows = (pick: (w: VestWindow) => boolean) => r.windows.filter(pick);
  const ofTranches = (ts: Tranche[]) => windows((w) => ts.some((t) => t.window === w.key));
  let ws: VestWindow[] = [];
  const extra: { q: BlockerQuery; b: BlockerRef[] }[] = [];
  if (d.figure === "window" || d.figure === "tranche") ws = windows((w) => w.key === d.window);
  else if (d.figure === "letter") ws = d.measure === "paid" ? windows((w) => w.letterId === d.letterId) : [];
  else if (d.figure === "award" || d.figure === "totals") {
    const awards = d.figure === "award" ? r.awards.filter((a) => a.letterId === d.letterId && a.year === d.year) : r.awards.filter((a) => !a.partial);
    const take: Record<string, ((t: Tranche) => boolean) | undefined> = {
      paid: (t) => t.paidCents !== 0,
      deferredPaid: (t) => t.kind === "DEFERRED" && t.paidCents !== 0,
      forfeited: (t) => t.status === "FORFEITED",
      outstanding: (t) => OUTSTANDING_STATUSES.includes(t.status),
    };
    const pick = take[d.measure];
    if (pick) ws = ofTranches(awards.flatMap((a) => a.tranches.filter(pick)));
    if (d.figure === "award" && d.measure === "totalComp")
      for (const a of awards) if (a.totalComp?.from === "SUM" && a.base?.payQuery) extra.push({ q: a.base.payQuery, b: a.base.blockers ?? [] });
  } else if (d.figure === "reconcile") {
    for (const y of r.byYear) if (y.year === d.year && y.personId === d.personId && y.employer === d.employer) extra.push({ q: y.payQuery, b: y.blockers });
  }
  const queries = [...ws.map((w) => w.payQuery).filter((q): q is BlockerQuery => q != null), ...extra.map((x) => x.q)];
  const blockers = [...new Map([...ws.flatMap((w) => w.blockers), ...extra.flatMap((x) => x.b)].map((b) => [b.id, b])).values()];
  return { queries, blockers };
}
