import { RENT_VS_BUY_FIGURES } from "../../home-budget/rentVsBuy.ts";
import { showValue } from "./clearance.ts";
import type { ProofDescriptor } from "./index.ts";
import { derivedKey, type DerivedFigure } from "../derived/types.ts";
import type { Proof, ProofLink, ProofValue, Rederivation, RederivedRoute } from "./types.ts";

/**
 * Independent proofs (SSOT F5): a figure worked out a second way that shares nothing with
 * the report the page reads, so a wrong report is caught, not only a page that drifts from
 * the server.
 *
 * Most proof kinds already are a second route: they re-add the Book's rows, statements and
 * stubs themselves. Two are not: the derived kind (derived/*.ts) re-reads the page's own
 * report, and the F4 planning figures re-run the page's own model. Their proofs carry
 * `rederived`: routes that must each tie (or the sweep's REDERIVE withholds the figure),
 * or the reason none can (a seeded simulation, a typed input). The sweep tallies which
 * figures still stand on their own route only.
 */

/** Whether a figure's proof re-runs the page's own report or model, so needs a second route of its own. */
export function sameRoute(d: ProofDescriptor): boolean {
  if (d.report === "derived") return true;
  if (d.report !== "planning") return false;
  switch (d.page) {
    case "mortgage":
    case "annual-estimate":
      return true;
    case "home":
      return (RENT_VS_BUY_FIGURES as readonly string[]).includes(d.figure);
    case "fire":
      return d.figure === "plan-cell" || d.figure === "access" || d.figure === "stress";
    default:
      return false;
  }
}

/**
 * How a figure stands apart from the page's report: re-derived by a second route,
 * declared as having none (and why), re-derived by its proof kind from the Book itself,
 * or still on the page's own route only.
 */
export type Independence = "rederived" | "declared" | "own-route" | "unchecked";

export function independenceOf(d: ProofDescriptor, p: Pick<Proof, "rederived">): Independence {
  if (p.rederived) {
    if ("none" in p.rederived) return "declared";
    if (p.rederived.routes.length) return "rederived";
  }
  return sameRoute(d) ? "unchecked" : "own-route";
}

/** How far a second route may land from the figure: cents after rounding each, a ratio to `ratio`. */
export type Tolerance = { cents?: number; ratio?: number };

function within(figure: ProofValue, value: ProofValue, tol: Tolerance): boolean {
  if ("cents" in figure) return "cents" in value && Math.abs(Math.round(figure.cents) - Math.round(value.cents)) <= (tol.cents ?? 0);
  if ("ratio" in figure) return "ratio" in value && Math.abs(figure.ratio - value.ratio) <= (tol.ratio ?? 1e-9);
  return "text" in value && figure.text === value.text;
}

/** A second route to `figure`: what it came to (`value`), held to the figure. */
export function route(name: string, figure: ProofValue, value: ProofValue, explain: string, opts: { tolerance?: Tolerance; link?: ProofLink } = {}): RederivedRoute {
  return { route: name, value, ok: within(figure, value, opts.tolerance ?? {}), explain, ...(opts.link ? { link: opts.link } : {}) };
}

/** An invariant the figure must hold (a ≤ b, a share within 0–1): a route whose value is the figure itself when it holds. */
export function invariant(name: string, figure: ProofValue, holds: boolean, explain: string): RederivedRoute {
  return { route: name, value: figure, ok: holds, explain };
}

/**
 * A page's re-derivations, by derivedKey: `by` works each figure out a second way (routes),
 * says why it can't (none), or leaves it (null). Routes are held to the figure's value.
 */
export function rederiveList(figures: readonly DerivedFigure[], by: (f: DerivedFigure & { value: ProofValue }) => RederivedRoute[] | { none: string } | null): Record<string, Rederivation> {
  const out: Record<string, Rederivation> = {};
  for (const f of figures) {
    if (!f.value) continue;
    const r = by(f as DerivedFigure & { value: ProofValue });
    if (r) out[derivedKey(f)] = Array.isArray(r) ? { routes: r } : r;
  }
  return out;
}

/** A route over money worked out in cents, held to the figure. */
export const centsRoute = (name: string, figure: ProofValue, cents: number, explain: string, tolerance = 0) => route(name, figure, { cents }, explain, { tolerance: { cents: tolerance } });
/** A route over a ratio. */
export const ratioRoute = (name: string, figure: ProofValue, ratio: number | null, explain: string, tolerance = 1e-9) => route(name, figure, ratio == null ? { text: "—" } : { ratio }, explain, { tolerance: { ratio: tolerance } });
/** A route over a count or words. */
export const textRoute = (name: string, figure: ProofValue, text: string, explain: string) => route(name, figure, { text }, explain);

/** The routes that didn't tie, in words for the sweep's listing. */
export function failedRoutes(p: Pick<Proof, "describes" | "figure" | "rederived">): string[] {
  if (!p.rederived || "none" in p.rederived) return [];
  return p.rederived.routes.filter((r) => !r.ok).map((r) => `${p.describes}: by ${r.route} it comes to ${showValue(r.value)}, the page's report to ${showValue(p.figure)} (${r.explain}).`);
}
