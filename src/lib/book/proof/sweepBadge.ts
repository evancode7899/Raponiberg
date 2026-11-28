import { BLOCKING_KINDS, type SweepState } from "./clearance.ts";

/**
 * What the top bar says about the proof sweep, beside the search bar
 * (components/ui/proof/SweepStatus.tsx). Pure; the browser folds every sweep answer into it.
 *
 * While the sweep of the data runs it turns; when that sweep finishes it says "all clear" a
 * moment and goes, or how many figures it withheld (and stays, as a link to Checks). A sweep
 * that was already done when the app opened says nothing: the pages say what they withhold.
 */
export type SweepBadge =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "clear" }
  | { kind: "withheld"; figures: number }
  | { kind: "failed"; error: string };

export const NO_BADGE: SweepBadge = { kind: "none" };

/** How many figures, on any page, the sweep withholds for a problem of the app's own (pageNotice.ts counts the same, per page). */
export function withheldFigures(s: SweepState): number {
  if (s.status !== "ready") return 0;
  return Object.values(s.problems).filter((ps) => ps.some((p) => BLOCKING_KINDS.includes(p.kind))).length;
}

/** The badge after one more sweep answer, given the badge before it. */
export function sweepBadge(prev: SweepBadge, s: SweepState): SweepBadge {
  if (s.status === "failed") return { kind: "failed", error: s.error ?? "no answer" };
  // No stamp: the browser's own placeholder before the first answer, not a sweep running.
  if (s.status === "pending") return s.stamp == null ? prev : { kind: "running" };
  if (prev.kind === "running" || prev.kind === "failed" || prev.kind === "withheld") {
    const figures = withheldFigures(s);
    if (figures) return { kind: "withheld", figures };
    return prev.kind === "withheld" ? NO_BADGE : { kind: "clear" };
  }
  return prev;
}
