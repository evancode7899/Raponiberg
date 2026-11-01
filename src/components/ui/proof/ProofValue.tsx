"use client";

import type { Figure, FigureBasis } from "@/lib/book/figure";
import { isUnswept, showValue } from "@/lib/book/proof/clearance";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import type { Quality } from "@/lib/ledger/timeline";
import type { ReactNode } from "react";
import { targetOf, useClearance, useProof, type ProofRef } from "./context";

/** What a figure says about its proof: a recipe (or an explicit unswept marker), or a whole Figure. */
export type FigureProps = ({ proof: ProofRef; figure?: never } | { figure: Figure; proof?: never }) & {
  /** Findings that block it: any one withholds it. */
  blockers?: readonly BlockerRef[];
  /** How it stands, when the page knows better than the sweep (an estimate it made itself). */
  basis?: FigureBasis;
  quality?: Quality;
  /**
   * How the children draw the value, when not as the number itself: "words" (a label that
   * opens the proof and holds no number of its own), or the number in other units: one
   * drawn unit is `per` of the shown value's (dollars for money; 1000 for $k), rounded or
   * floored to `step` drawn units; `zeroWithin`: words in place of a number (About even,
   * Filled) that stand for zero, so the value is within this many drawn units of it. The
   * render audit holds the drawn text to it (lib/book/proof/renderAudit.ts).
   */
  drawn?: "words" | { per?: number; step?: number; zeroWithin?: number };
};

const WEAKER: Record<FigureBasis, number> = { proven: 0, accepted: 1, estimate: 2 };
const weakest = (...bs: (FigureBasis | undefined)[]): FigureBasis => bs.reduce<FigureBasis>((w, b) => (b && WEAKER[b] > WEAKER[w] ? b : w), "proven");

const QUALITY_WORDS: Partial<Record<Quality, string>> = { ESTIMATED: "est.", DERIVED: "derived", INTERPOLATED: "interp.", STALE: "stale" };

/** The estimate / accepted-exception / quality marks shown beside a cleared figure, on the page itself. */
function Marks({ basis, quality }: { basis: FigureBasis; quality?: Quality }) {
  const q = quality ? QUALITY_WORDS[quality] : undefined;
  if (basis === "proven" && !q) return null;
  const mark = "ml-1 inline-block rounded-sm px-1 align-super text-[9px] font-semibold uppercase leading-tight tracking-wide not-italic";
  return (
    <>
      {basis === "estimate" && (
        <span data-proof-mark="estimate" title="An estimate: part of it isn't read off a statement (the proof says which)." className={`${mark} bg-warn-soft text-warn`}>
          est
        </span>
      )}
      {basis === "accepted" && (
        <span data-proof-mark="accepted" title="Rests on an exception you accepted (the proof lists it)." className={`${mark} bg-info-soft text-info`}>
          acc
        </span>
      )}
      {q && basis !== "estimate" && (
        <span data-proof-mark="quality" title={`Quality: ${quality!.toLowerCase()}`} className={`${mark} bg-surface-3 text-fg-2`}>
          {q}
        </span>
      )}
    </>
  );
}

/**
 * A figure, fail-closed: its number shows only when the proof sweep of the page's own data
 * cleared it at the very value the page shows (clearance.ts). Until the sweep answers it
 * shows the page's number, plain; blocked, flagged, a different number, never swept, or no sweep at all,
 * it's withheld: a dash that opens the drawer saying why. A cleared figure opens its proof.
 *
 * Every one carries data-proof-key (its descriptor key, or "unswept"), data-shown (the
 * value the page shows), data-shown-kind, data-per-months and data-drawn, so the render audit
 * (scripts/render-audit.ts) can read every figure on a page and hold its text to it.
 */
export function ProofValue({ children, className = "", ...props }: FigureProps & { children: ReactNode; className?: string }) {
  const open = useProof();
  const ref = props.figure ?? props.proof;
  const c = useClearance(ref, props.blockers);
  const target = props.figure ? targetOf(props.figure) : isUnswept(props.proof) ? null : props.proof;
  const data = {
    "data-proof-key": c.key ?? (c.state === "withheld" && c.reason === "no-figure" ? "none" : "unswept"),
    "data-shown": c.shown ? showValue(c.shown) : "",
    "data-shown-kind": c.shown ? ("cents" in c.shown ? "cents" : "ratio" in c.shown ? "ratio" : "text") : "",
    ...(target?.perMonths && target.perMonths > 1 ? { "data-per-months": target.perMonths } : {}),
    ...(props.drawn === "words" ? { "data-drawn": "words" } : props.drawn ? { "data-drawn": `per:${props.drawn.per ?? 1};step:${props.drawn.step ?? 0};zero:${props.drawn.zeroWithin ?? -1}` } : {}),
    "data-clearance": c.state === "withheld" ? `withheld:${c.reason}` : c.state,
  };
  // While the sweep of fresh data runs, the page's number shows at once (owner's rule,
  // 2026-11-01: the app is never kept waiting); the sweep withholds it the moment it finds
  // a problem. Kept apart from a cleared figure: no proof drawer or marks until it answers.
  if (c.state === "verifying")
    return (
      <span {...data} title="Checking: the proof sweep of this data is still running." className={className}>
        {children}
      </span>
    );
  if (c.state === "withheld") {
    const bad = c.reason === "mismatch" || (c.reason === "flagged" && c.problems?.some((p) => p.kind !== "WITHHELD")) || (c.reason === "blocked" && c.blockers?.some((b) => b.status === "FAIL"));
    return (
      <button
        type="button"
        {...data}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          open?.(target, c);
        }}
        title={`Withheld: ${c.detail}`}
        className={`cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${bad ? "text-neg decoration-neg" : "text-muted decoration-line-strong"} ${className}`}
      >
        —
      </button>
    );
  }
  const basis = weakest(c.basis, props.basis, props.figure?.basis);
  const quality = props.quality ?? props.figure?.quality;
  return (
    <button
      type="button"
      {...data}
      onClick={(e) => {
        // Inside a clickable row or a link, open the proof rather than the row's own drill-down or the link's page.
        e.preventDefault();
        e.stopPropagation();
        open?.(target, c);
      }}
      title="Show the rows and checks behind this figure"
      className={`cursor-pointer rounded-sm text-inherit underline decoration-line-strong decoration-dotted underline-offset-4 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      {children}
      <Marks basis={basis} quality={quality} />
    </button>
  );
}
