"use client";

import type { ProofDescriptor } from "@/lib/book/proof";
import { descriptorKey } from "@/lib/book/proof/key";
import { createContext, useContext } from "react";

/**
 * A figure that can show its proof: the recipe the server re-derives it from, and how
 * the page shows it (a total, or that total per month). Kept apart from the provider so
 * kit.tsx can take it without importing the drawer (which imports kit).
 */
export type ProofTarget = {
  descriptor: ProofDescriptor;
  /**
   * The figure as the page shows it (cents, before any per-month split), or null for a
   * figure that isn't money (a rate, a date). Required: the drawer compares it with the
   * proof's own figure, so a page and its proof can never disagree unnoticed.
   */
  shownCents: number | null;
  /** The page shows the total divided by this many months. */
  perMonths?: number;
};

export const ProofContext = createContext<((t: ProofTarget) => void) | null>(null);

/**
 * Figures the proof sweep found disagreeing with their proofs (lib/book/proof/sweep.ts), by
 * descriptor key (proof/key.ts), with what's wrong: pages withhold them, as they withhold
 * a figure an open finding covers. Empty until the sweep's answer arrives.
 */
export type ProofFlag = { kind: "WITHHELD" | "BUG"; detail: string };
export const ProofFlagsContext = createContext<ReadonlyMap<string, ProofFlag>>(new Map());

/** What the sweep found about this figure's proof, or null when nothing. */
export function useProofFlag(t: ProofTarget | undefined): ProofFlag | null {
  const flags = useContext(ProofFlagsContext);
  return t && flags.size ? (flags.get(descriptorKey(t.descriptor)) ?? null) : null;
}

/** Opens the proof drawer for a figure; null outside the app shell (figures then render as plain text). */
export function useProof() {
  return useContext(ProofContext);
}
