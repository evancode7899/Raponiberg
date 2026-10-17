"use client";

import type { ProofDescriptor } from "@/lib/book/proof";
import { createContext, useContext } from "react";

/**
 * A figure that can show its proof: the recipe the server re-derives it from, and how
 * the page shows it (a total, or that total per month). Kept apart from the provider so
 * kit.tsx can take it without importing the drawer (which imports kit).
 */
export type ProofTarget = {
  descriptor: ProofDescriptor;
  /** The figure as the page computed it (cents, before any per-month split), to spot data that changed since the page loaded. */
  shownCents?: number;
  /** The page shows the total divided by this many months. */
  perMonths?: number;
};

export const ProofContext = createContext<((t: ProofTarget) => void) | null>(null);

/** Opens the proof drawer for a figure; null outside the app shell (figures then render as plain text). */
export function useProof() {
  return useContext(ProofContext);
}
