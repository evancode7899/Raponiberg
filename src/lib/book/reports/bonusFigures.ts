import type { BlockerQuery } from "../blockers.ts";
import type { BlockerRef } from "./blockerRef.ts";
import type { Forecast } from "../../forecast/forecast.ts";
import type { BonusesDescriptor } from "../proof/bonusesProof.ts";
import type { PayDescriptor, PayLine } from "../proof/payProof.ts";
import type { BonusesReport, BonusPayment, BonusYear, Tranche, VestWindow, WindowStatus } from "./bonuses.ts";

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

// ------------------------------------------------------------------ pay figures

/** A person's calendar year of pay as the stubs give it (year to date on each employer's last stub). */
export const yearPayDescriptor = (personId: string, year: number, lines: PayLine[]): PayDescriptor => ({ report: "pay", basis: "ytd", personId, year, lines });

/** One stub date's bonus lines from one employer: the page shows the day's total, the proof re-adds the day. */
export function stubPayFigure(p: BonusPayment, all: BonusPayment[]): { descriptor: PayDescriptor; cents: number } {
  const day = all.filter((q) => q.personId === p.personId && q.employerKey === p.employerKey && q.date === p.date);
  return {
    descriptor: { report: "pay", basis: "paid", personId: p.personId, employerKeys: [p.employerKey], lines: ["bonus"], start: p.date, end: p.date },
    cents: day.reduce((t, q) => t + q.amountCents, 0),
  };
}

/** A year's bonus paychecks from one employer, to date (Bonus paychecks' by-year table). */
export const paidYearDescriptor = (y: BonusYear): PayDescriptor => ({
  report: "pay",
  basis: "paid",
  personId: y.personId,
  employerKeys: y.employerKeys,
  lines: ["bonus"],
  start: `${y.year}-01-01`,
  end: y.through ?? `${y.year}-12-31`,
});

/** The next award the forecast expects, per person: its estimated payments (no letter or stub shows them yet). */
export function expectedBonuses(f: Forecast) {
  const est = f.schedule.filter((b) => b.source === "ESTIMATE" && b.awardYear != null);
  const first = new Map<string, number>();
  for (const b of est) first.set(b.personId, Math.min(first.get(b.personId) ?? Infinity, b.awardYear!));
  return est.filter((b) => b.awardYear === first.get(b.personId));
}

/** An expected payment's recipe (bonusesProof "estimate"). */
export const estimateDescriptor = (b: Forecast["schedule"][number]): BonusesDescriptor =>
  ({ report: "bonuses", figure: "estimate", personId: b.personId, awardYear: b.awardYear!, month: b.key, part: b.label.split(" · ").slice(1).join(" · ") });

/**
 * Every pay figure the Bonuses page shows beside its letters: each award's base pay read
 * off stubs, each person's year of base and bonus pay, each year's bonus paychecks by
 * employer and each stub date's bonus, with the value each shows. Withheld figures (a
 * finding over the stubs) aren't listed: the page shows them as blocked.
 */
export function bonusPayFigures(r: BonusesReport): { descriptor: PayDescriptor; cents: number }[] {
  const out: { descriptor: PayDescriptor; cents: number }[] = [];
  for (const a of r.awards) if (a.base?.from === "STUBS" && !a.base.blockers?.length) out.push({ descriptor: yearPayDescriptor(a.personId, a.year, ["base"]), cents: a.base.cents });
  for (const y of r.payYears)
    out.push(
      { descriptor: yearPayDescriptor(y.personId, y.year, ["base"]), cents: y.baseCents },
      { descriptor: yearPayDescriptor(y.personId, y.year, ["bonus"]), cents: y.bonusCents },
      { descriptor: yearPayDescriptor(y.personId, y.year, ["base", "bonus"]), cents: y.baseCents + y.bonusCents },
    );
  for (const y of r.byYear) if (!y.blockers.length) out.push({ descriptor: paidYearDescriptor(y), cents: y.cents });
  for (const p of r.payments) out.push(stubPayFigure(p, r.payments));
  return out;
}
