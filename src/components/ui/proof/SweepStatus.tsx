"use client";

import type { SweepState } from "@/lib/book/proof/clearance";
import { NO_BADGE, sweepBadge, type SweepBadge } from "@/lib/book/proof/sweepBadge";
import Link from "next/link";
import { useSyncExternalStore } from "react";

/** How long "All clear" stays before it goes. */
const CLEAR_MS = 4000;

/**
 * The top bar sits outside ProofProvider (it wraps the page, not the shell), so the provider
 * hands each sweep answer here (publishSweep) and the bar reads the badge from this one store.
 */
let badge: SweepBadge = NO_BADGE;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const set = (next: SweepBadge) => {
  if (next === badge) return;
  badge = next;
  for (const l of listeners) l();
};

export function publishSweep(s: SweepState): void {
  const next = sweepBadge(badge, s);
  if (next.kind !== "clear") clearTimeout(clearTimer);
  else if (badge.kind !== "clear") clearTimer = setTimeout(() => set(NO_BADGE), CLEAR_MS);
  set(next);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Beside the search bar: a turning wheel while the proof sweep runs, "All clear" when it's done. */
export function SweepStatus() {
  const b = useSyncExternalStore(subscribe, () => badge, () => NO_BADGE);
  const box = "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs";
  return (
    <div role="status" aria-live="polite" className="contents">
      {b.kind === "running" && (
        <span className={`${box} text-muted`} title="The proof sweep is holding every figure to its proof. Figures show meanwhile, and go to a red dash if one doesn't tie." data-sweep-status="running">
          <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          <span className="hidden md:inline">Checking figures…</span>
        </span>
      )}
      {b.kind === "clear" && (
        <span className={`${box} text-pos`} title="The proof sweep held every figure to its proof: all tie." data-sweep-status="clear">
          <span aria-hidden>✓</span>
          <span className="hidden md:inline">All clear</span>
        </span>
      )}
      {b.kind === "withheld" && (
        <Link
          href="/statements?tab=checks"
          className={`${box} text-neg outline-none hover:bg-neg-soft focus-visible:ring-2 focus-visible:ring-focus`}
          title="The proof sweep is done, and some figures don't tie to their proofs: a bug in the app, not your documents. Open Checks for each one."
          data-sweep-status="withheld"
        >
          <span aria-hidden>!</span>
          <span>
            {b.figures} withheld
          </span>
        </Link>
      )}
      {b.kind === "failed" && (
        <Link
          href="/statements?tab=checks"
          className={`${box} text-neg outline-none hover:bg-neg-soft focus-visible:ring-2 focus-visible:ring-focus`}
          title={`The proof sweep didn't finish, so every figure is withheld: ${b.error}. It tries again on its own.`}
          data-sweep-status="failed"
        >
          <span aria-hidden>!</span>
          <span className="hidden md:inline">Sweep failed</span>
        </Link>
      )}
    </div>
  );
}
