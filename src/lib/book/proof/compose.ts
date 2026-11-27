import type { Figure } from "../figure.ts";
import { isUnswept, noFigure, type Unswept } from "./clearance.ts";
import type { CompositeDescriptor, CompositeOp } from "./composite.ts";
import type { ProofDescriptor } from "./index.ts";
import type { ProofValue } from "./types.ts";

/**
 * A figure and the recipe its proof re-derives it from, apart from how a page draws it: pure,
 * so a report built on the server can hand a page its figures with their proofs
 * (dashboard/briefing.ts), and the pages use the same (components/ui/proof/context.ts).
 */

export type ProofTarget = {
  descriptor: ProofDescriptor;
  /**
   * The figure as the page shows it (cents, before any per-month split), or null for a
   * figure that isn't money (a rate, a date). Required: it's held to the value the proof
   * sweep cleared before the page may show it, and the drawer compares it with the proof.
   */
  shownCents: number | null;
  /** A rate or words the page shows, held to the cleared value like shownCents. */
  shown?: ProofValue;
  /** The page shows the total divided by this many months. */
  perMonths?: number;
};

/**
 * What every figure on a page must say about its proof: a recipe the sweep holds it to,
 * or that it has none yet (unswept(why): withheld until it has one). There's no
 * "no proof" option: a figure without one never shows as if it were proven.
 */
export type ProofRef = ProofTarget | Unswept;

/** A Figure as the target its proof drawer opens. */
export const targetOf = (f: Figure): ProofTarget => ({
  descriptor: f.descriptor,
  shownCents: "cents" in f.value ? f.value.cents : null,
  ...("cents" in f.value ? {} : { shown: f.value }),
  ...(f.perMonths ? { perMonths: f.perMonths } : {}),
});

/**
 * A share, change, sum or growth of figures that have proofs (composite.ts): it shows only
 * once every part has cleared, at the value worked out from their cleared values, and its
 * drawer shows the arithmetic. A part with no proof (or nothing to show) leaves the composite
 * without one too. `shown` is the value the page works out and draws.
 */
export function compositeOf(op: CompositeOp, parts: readonly (ProofRef | Figure)[], shown: ProofValue, per?: readonly number[], n?: number): ProofRef {
  const refs = parts.map((p) => ("class" in p ? targetOf(p) : p));
  const none = refs.find((p): p is Unswept => isUnswept(p));
  if (none) return none;
  const of = (refs as ProofTarget[]).map((p) => p.descriptor) as CompositeDescriptor["of"];
  return { descriptor: { report: "composite", op, of, ...(per && per.some((k) => k !== 1) ? { per } : {}), ...(n != null ? { n } : {}) }, shownCents: "cents" in shown ? shown.cents : null, ...("cents" in shown ? {} : { shown }) };
}

/** The sum of a few figures that have proofs: the one figure itself, a composite sum of several, or nothing to show. */
export function sumOf(parts: readonly ProofRef[], cents: number): ProofRef {
  if (!parts.length) return noFigure("nothing to add up");
  return parts.length === 1 ? parts[0]! : compositeOf("sum", parts, { cents });
}

/**
 * A run's average per month (a trailing average a chart draws): the sum of its months'
 * figures, shown divided by how many months (perMonths), so the proof is the months added up.
 * `totalCents` is the run's total as the page added it, before the division.
 */
export function averageOf(parts: readonly ProofRef[], totalCents: number): ProofRef {
  const s = sumOf(parts, totalCents);
  if (isUnswept(s) || parts.length <= 1) return s;
  return { ...s, perMonths: parts.length };
}

/**
 * The median of a few figures that have proofs (a typical month): the middle one's own proof,
 * or with an even count the two middle ones averaged, as `median` works it out. Each item's
 * `cents` is the value the page sorts by.
 */
export function medianOf(items: readonly { cents: number; proof: ProofRef }[]): ProofRef {
  if (!items.length) return noFigure("nothing to take the middle of");
  const s = [...items].sort((a, b) => a.cents - b.cents);
  const m = Math.floor(s.length / 2);
  if (s.length % 2) return s[m]!.proof;
  return averageOf([s[m - 1]!.proof, s[m]!.proof], s[m - 1]!.cents + s[m]!.cents);
}
