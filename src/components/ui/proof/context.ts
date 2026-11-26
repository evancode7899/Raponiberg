"use client";

import type { Figure } from "@/lib/book/figure";
import { clearanceOf, NO_SWEEP, type Clearance, type SweepState } from "@/lib/book/proof/clearance";
import { targetOf, type ProofRef, type ProofTarget } from "@/lib/book/proof/compose";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import type { Quality } from "@/lib/ledger/timeline";
import { createContext, useContext } from "react";

export { unswept, type Unswept } from "@/lib/book/proof/clearance";

/** Pins changed somewhere (the command line's SAVE, the proof drawer's Pin): the command line reads them again. */
export const PINS_CHANGED_EVENT = "pf:pins-changed";
export { compositeOf, sumOf, targetOf, type ProofRef, type ProofTarget } from "@/lib/book/proof/compose";

/**
 * Opens the proof drawer: on a figure's proof, or (a figure with no proof) only on why it's
 * withheld. `quality` is the data quality the page knows the figure by: the drawer says it,
 * the page never does.
 */
export type OpenProof = (t: ProofTarget | null, clearance?: Clearance, quality?: Quality) => void;
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
