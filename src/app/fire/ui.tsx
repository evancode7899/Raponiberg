"use client";

import { Segmented } from "@/components/ui/kit";
import type { FireAnalysis } from "@/lib/fire/fire";
import type { FireFigure, FireSettings } from "@/lib/book/proof/planningProof";
import { compositeOf, sumOf, unswept, type ProofRef } from "@/components/ui/proof/context";
import { noFigure } from "@/lib/book/proof/clearance";
import type { OutlookSeeds, ResolvedBasePay } from "@/lib/profile/basePay";
import type { OutlookAssumptions } from "@/lib/profile/settings";
import { planValue, type AccessFigure, type PlanCellValue, type StressFigure } from "@/lib/fire/longTerm";
import { formatPercentRatio, formatUsd, usd0 } from "@/lib/formatMoney";
import type { OutlookPlan } from "@/lib/profile/outlook";

/** Whole dollars from cents. */
export const usd = usd0;
export const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : formatPercentRatio(r, digits));
/** $1.25M / $480k / $900 from cents. */
export function short(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const d = cents / 100;
  const a = Math.abs(d);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}k` : `$${Math.round(a)}`;
  return d < 0 ? `−${s}` : s;
}
/** Tooltip formatter: whole dollars. */
export const tipUsd = (v: unknown) => formatUsd(Math.round(Number(v)));

export type Dollars = "nominal" | "real";

/** Divisor turning a future (nominal) amount on Jan 1 of `year` into start-year dollars. */
export const deflator = (plan: OutlookPlan, dollars: Dollars, year: number) => (dollars === "real" ? (1 + plan.inflation) ** (year - plan.start.year) : 1);

export function DollarsToggle({ value, onChange }: { value: Dollars; onChange: (d: Dollars) => void }) {
  return (
    <Segmented view
      size="xs"
      ariaLabel="Dollars"
      options={[
        { value: "nominal", label: "Future $" },
        { value: "real", label: "Today's $" },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** "2034 (age 41)" or "2034". */
export const yearAge = (year: number | null | undefined, plan: OutlookPlan) =>
  year == null ? "—" : plan.birthYear != null ? `${year} (age ${year - plan.birthYear})` : String(year);

/** "in 8 years" relative to the plan's first year. */
export const yearsFrom = (year: number | null | undefined, plan: OutlookPlan) => {
  if (year == null) return "not within 60 years";
  const n = year - plan.start.year;
  return n <= 0 ? "already there" : `in ${n} year${n === 1 ? "" : "s"}`;
};

export type FireProps = { f: FireAnalysis; dollars: Dollars; setDollars: (d: Dollars) => void; d: FireData };

/** Why every FIRE figure is withheld while the settings differ from the saved ones: the sweep proves the saved plan only. */
const UNSAVED = "the settings have unsaved edits: save them to have these proven";

/** A FIRE figure's proof ("planning" kind), on the saved settings; withheld while they have unsaved edits. */
export type FireProof = (figure: FireFigure, shownCents: number | null, milestone?: string) => ProofRef;
export const fireProof =
  (fire: FireSettings, dirty = false): FireProof =>
  (figure, shownCents, milestone) => (dirty ? unswept(UNSAVED) : { descriptor: { report: "planning", page: "fire", figure, fire, ...(milestone ? { milestone } : {}) }, shownCents });

/**
 * The owner's own numbers the plan starts from, each its forecast seed proof: starting net
 * worth, household base salary (each person's pay), the share kept after tax, living cost.
 * Null where it was typed on the Forecast page instead (a labelled assumption, not data).
 */
export type FireData = { start: ProofRef; salary: ProofRef | null; keep: ProofRef | null; living: ProofRef | null };
export function fireData(s: OutlookSeeds, a: OutlookAssumptions, pay: ResolvedBasePay): FireData {
  const seed = s.living[a.livingBasis];
  return {
    start: { descriptor: { report: "forecast", figure: "seed", which: "start" }, shownCents: s.start.liquid + s.start.illiquid },
    salary: pay.people.some((p) => p.salaryTyped)
      ? null
      : sumOf(
          pay.people.map((p) => ({ descriptor: { report: "forecast", figure: "seed", which: "pay", personId: p.personId, paycheck: p.basis }, shownCents: p.salary })),
          pay.salary,
        ),
    keep: pay.rateTyped ? null : { descriptor: { report: "forecast", figure: "seed", which: "take-home", paycheck: Object.fromEntries(pay.people.map((p) => [p.personId, p.basis])) }, shownCents: null, shown: { ratio: pay.computedRate } },
    living: pay.living.typed || !seed ? null : { descriptor: { report: "forecast", figure: "seed", which: "living", basis: a.livingBasis }, shownCents: seed.cents },
  };
}

/** Living cost times a share (Lean FIRE's 70%), a composite of the living-cost seed; null when living cost was typed. */
export const livingTimes = (d: FireData, share: number, cents: number): ProofRef | null => (d.living ? compositeOf("times", [d.living], { cents: Math.round(cents) }, undefined, share) : null);

/** Which FIRE › Plan or Stress test figure: a long-term table cell, a bridge tile, a stress tile. */
export type FirePlanFigure = { figure: "plan-cell"; row: string; col: string } | { figure: "access"; metric: AccessFigure } | { figure: "stress"; metric: StressFigure; volatility: number };
/** A FIRE › Plan or Stress test figure's proof, on the settings as the page has them; a dash (no value) is no figure. */
export type FirePlanProof = (which: FirePlanFigure, v: PlanCellValue) => ProofRef;
export const firePlanProof =
  (fire: FireSettings, dirty = false): FirePlanProof =>
  (which, v) => {
    if (dirty) return unswept(UNSAVED);
    const value = planValue(v);
    if (!value) return noFigure("nothing that year");
    return { descriptor: { report: "planning", page: "fire", fire, ...which }, shownCents: "cents" in value ? value.cents : null, ...("cents" in value ? {} : { shown: value }) };
  };
