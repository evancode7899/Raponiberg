import type { Quality } from "../ledger/timeline.ts";
import type { ProofDescriptor } from "./proof/index.ts";
import type { ProofValue } from "./proof/types.ts";
import type { BlockerRef } from "./reports/blockerRef.ts";

/**
 * One figure as a page shows it, with everything that decides whether it may show at
 * all: the recipe its proof re-derives it from, the findings that block it, and how it
 * stands. Routes can hand these to pages whole; ProofValue, Stat and StatCell take one
 * and draw the blocked, verifying, withheld and estimate states themselves, so no page
 * has to remember to.
 */

/** How the figure stands: read off statements, resting on an exception the owner accepted, or estimated. */
export type FigureBasis = "proven" | "accepted" | "estimate";

/** What kind of figure it is: as a document prints it, worked out from facts, or a projection past today. */
export type FigureClass = "FACT" | "DERIVED" | "PROJECTION";

export type Figure = {
  /** The figure as the page shows it, before any per-month split. */
  value: ProofValue;
  descriptor: ProofDescriptor;
  /** Findings that keep it from being proven: any one withholds it. */
  blockers: BlockerRef[];
  quality?: Quality;
  basis: FigureBasis;
  class: FigureClass;
  /** The page shows the value divided by this many months. */
  perMonths?: number;
};

/** A money figure. */
export function moneyFigure(descriptor: ProofDescriptor, cents: number, opts: Partial<Omit<Figure, "value" | "descriptor">> = {}): Figure {
  return { value: { cents }, descriptor, blockers: [], basis: "proven", class: "DERIVED", ...opts };
}
