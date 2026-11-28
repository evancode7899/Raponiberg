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
  /** Re-derived by their own kind of proof from the Book; and re-run on the page's own report only. */
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

/** The Dashboard's Trust panel (GET /api/proof/trust): the sweep's counts with the data edge, restatements, audit chain and restore drill. */
export type TrustPanelBody = {
  trust: Trust;
  /** The data edge: every figure stops here. */
  provenThrough: string;
  /** Cleared figures whose value moved since the last month-end's record, and how many were compared. */
  restated: { month: string; moved: number; compared: number } | null;
  /** The audit log's hash chain: whether it holds, and how many events it links. */
  chain: { ok: boolean; chained: number; problems: number; head: { seq: number; at: string } | null };
  /** The latest restore drill of the newest backup snapshot. */
  drill: { at: string; ok: boolean; matches: boolean } | null;
};

