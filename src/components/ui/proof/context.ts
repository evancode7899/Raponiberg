"use client";

import type { Figure } from "@/lib/book/figure";
import type { ProofDescriptor } from "@/lib/book/proof";
import { clearanceOf, isUnswept, NO_SWEEP, noFigure, type Clearance, type SweepState, type Unswept } from "@/lib/book/proof/clearance";
import type { CompositeDescriptor, CompositeOp } from "@/lib/book/proof/composite";
import type { ProofValue } from "@/lib/book/proof/types";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { createContext, useContext } from "react";

export { unswept, type Unswept } from "@/lib/book/proof/clearance";

/**
 * A figure that can show its proof: the recipe the server re-derives it from, and how
 * the page shows it (a total, or that total per month). Kept apart from the provider so
 * kit.tsx can take it without importing the drawer (which imports kit).
 */
export type ProofTarget = {
  descriptor: ProofDescriptor;
  /**
   * The figure as the page shows it (cents, before any per-month split), or null for a
   * figure that isn't money (a rate, a date). Required: it's held to the value the proof
   * sweep cleared before the page may show it, and the drawer compares it with the proof.
   */
  shownCents: number | null;
  /** A rate or words the page shows, held to the cleared value like shownCents. */
  shown?: ProofValue;
  /** The page shows the total divided by this many months. */
  perMonths?: number;
};

/**
 * What every figure on a page must say about its proof: a recipe the sweep holds it to,
 * or that it has none yet (unswept(why): withheld until F3 gives it one). There's no
 * "no proof" option: a figure without one never shows as if it were proven.
 */
export type ProofRef = ProofTarget | Unswept;

/** A Figure as the target its proof drawer opens. */
export const targetOf = (f: Figure): ProofTarget => ({
  descriptor: f.descriptor,
  shownCents: "cents" in f.value ? f.value.cents : null,
  ...("cents" in f.value ? {} : { shown: f.value }),
  ...(f.perMonths ? { perMonths: f.perMonths } : {}),
});

/** Opens the proof drawer: on a figure's proof, or (a figure with no proof) only on why it's withheld. */
export type OpenProof = (t: ProofTarget | null, clearance?: Clearance) => void;
export const ProofContext = createContext<OpenProof | null>(null);

/** The proof sweep's verdicts (clearance.ts). Outside the app shell there is none, and every figure is withheld. */
export const SweepContext = createContext<SweepState>(NO_SWEEP);

/** The data the page's figures were built from (useApi's x-data-stamp), or null before any answer. */
export const DataStampContext = createContext<string | null>(null);

/** Whether a figure may show, for the page's data. */
export function useClearance(ref: ProofRef | Figure, blockers: readonly BlockerRef[] = []): Clearance {
  const sweep = useContext(SweepContext);
  const stamp = useContext(DataStampContext);
  if ("class" in ref) return clearanceOf(targetOf(ref), sweep, stamp, [...ref.blockers, ...blockers]);
  return clearanceOf(ref, sweep, stamp, blockers);
}

/** Opens the proof drawer for a figure; null outside the app shell. */
export function useProof() {
  return useContext(ProofContext);
}

/**
 * A share, change, sum or growth of figures that have proofs (lib/book/proof/composite.ts):
 * it shows only once every part has cleared, at the value worked out from their cleared
 * values, and its drawer shows the arithmetic. A part with no proof (or nothing to show)
 * leaves the composite without one too. `shown` is the value the page works out and draws.
 */
export function compositeOf(op: CompositeOp, parts: readonly (ProofRef | Figure)[], shown: ProofValue, per?: readonly number[], n?: number): ProofRef {
  const refs = parts.map((p) => ("class" in p ? targetOf(p) : p));
  const none = refs.find((p): p is Unswept => isUnswept(p));
  if (none) return none;
  const of = (refs as ProofTarget[]).map((p) => p.descriptor) as CompositeDescriptor["of"];
  return { descriptor: { report: "composite", op, of, ...(per && per.some((k) => k !== 1) ? { per } : {}), ...(n != null ? { n } : {}) }, shownCents: "cents" in shown ? shown.cents : null, ...("cents" in shown ? {} : { shown }) };
}

/** The sum of a few figures that have proofs: the one figure itself, a composite sum of several, or nothing to show. */
export function sumOf(parts: readonly ProofRef[], cents: number): ProofRef {
  if (!parts.length) return noFigure("nothing to add up");
  return parts.length === 1 ? parts[0]! : compositeOf("sum", parts, { cents });
}
