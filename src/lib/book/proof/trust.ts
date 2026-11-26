import type { SweepReport } from "./sweep.ts";

/**
 * How far to trust the figures, read straight off the proof sweep's own report: no figure
 * of its own, only the sweep's counts side by side. Every figure the pages show, how many it
 * cleared, how many a second route worked out again, how many rest on an estimate or on an
 * exception the owner accepted, how many it flagged, and the source whose data is oldest.
 */
export type Trust = {
  figures: number;
  cleared: number;
  /** Worked out again by a route that shares nothing with the page's report. */
  rederived: number;
  /** Can't be re-derived (a typed input, a model's draw): each proof says why. */
  declared: number;
  /** Re-run on a route of their own kind, or on the page's own report only. */
  ownRoute: number;
  unchecked: number;
  estimates: number;
  accepted: number;
  problems: number;
  skipped: number;
  sources: SweepReport["sources"] | null;
  /** The day the sweep's Book was built for. */
  today: string;
};

export function trustOf(r: SweepReport): Trust {
  const basis = Object.values(r.basis);
  return {
    figures: r.figures,
    cleared: Object.keys(r.cleared).length,
    rederived: r.independence.rederived,
    declared: r.independence.declared,
    ownRoute: r.independence["own-route"],
    unchecked: r.independence.unchecked,
    estimates: basis.filter((b) => b === "estimate").length,
    accepted: basis.filter((b) => b === "accepted").length,
    problems: r.problemCount,
    skipped: r.skipped.length,
    sources: r.sources ?? null,
    today: r.today,
  };
}
