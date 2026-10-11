"use client";

import { useState } from "react";

/**
 * True on the first render and on any render where `deps` differ (by identity) from the
 * previous render's: React's "adjust state when a prop changes" pattern
 * (react.dev/learn/you-might-not-need-an-effect). Set state from it during render, e.g.
 * flag a fetch as loading the moment what's fetched changes, instead of in an effect,
 * which renders once with stale state first.
 */
export function useChanged(deps: readonly unknown[]): boolean {
  const [seen, setSeen] = useState<readonly unknown[] | null>(null);
  const changed = seen === null || seen.length !== deps.length || deps.some((d, i) => d !== seen[i]);
  if (changed) setSeen(deps);
  return changed;
}
