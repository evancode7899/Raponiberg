import type { FigureBasis } from "../figure.ts";
import type { BlockerRef } from "../reports/blockerRef.ts";
import type { ProofDescriptor } from "./index.ts";
import { descriptorKey } from "./key.ts";
import type { ProofValue } from "./types.ts";

/**
 * Fail-closed clearance: whether a page may show a figure's number. Pure; runs on the
 * server and in the browser alike.
 *
 * A figure shows only when the proof sweep (sweep.ts) of the very data the page was built
 * from (its stamp, cache.ts stampTag) cleared its recipe, and the page shows the value the
 * sweep cleared. Anything else withholds it: the sweep still running ("verifying…"), the
 * sweep failing or never answering, a finding blocking it, a flag, a different number, a
 * recipe the sweep never held to its proof. Nothing shows just because nobody objected.
 */

export type SweepProblemKind = "DIFFERS" | "SELF_CHECK" | "CHAIN" | "WITHHELD" | "LINK" | "ERROR" | "SKIPPED";
export type SweepProblem = { kind: SweepProblemKind; page: string; descriptor: ProofDescriptor | null; detail: string };

/** The kinds that keep a figure from clearing. A LINK problem is the linked proof's, not this figure's. */
export const BLOCKING_KINDS: readonly SweepProblemKind[] = ["DIFFERS", "SELF_CHECK", "CHAIN", "WITHHELD", "ERROR"];

/** How a cleared figure stands, when not plainly proven. */
export type ClearedBasis = Exclude<FigureBasis, "proven">;

/** The sweep's verdicts as the browser holds them. */
export type SweepState = {
  /** The data the verdicts are for (stampTag), or null before any answer. */
  stamp: string | null;
  status: "pending" | "ready" | "failed";
  /** Every figure that tied, by descriptor key, with the value its proof works out. */
  cleared: Readonly<Record<string, ProofValue>>;
  /** Cleared figures that rest on an estimate or an accepted exception. */
  basis: Readonly<Record<string, ClearedBasis>>;
  problems: Readonly<Record<string, SweepProblem[]>>;
  /** Why the sweep failed, when it did. */
  error?: string;
};

export const NO_SWEEP: SweepState = { stamp: null, status: "failed", cleared: {}, basis: {}, problems: {}, error: "No proof sweep here: figures can't be checked outside the app." };

/** A figure the page shows: its recipe and the value shown (cents before any per-month split; `shown` for a rate or words). */
export type ShownFigure = { descriptor: ProofDescriptor; shownCents: number | null; shown?: ProofValue; perMonths?: number };

/** A figure with no proof yet: always withheld, saying why. F3 gives each one a proof. */
export type Unswept = { unswept: string };
export const unswept = (why: string): Unswept => ({ unswept: why });
export const isUnswept = (x: unknown): x is Unswept => typeof x === "object" && x !== null && "unswept" in x;

export type WithheldReason = "unswept" | "blocked" | "flagged" | "mismatch" | "stale" | "failed" | "not-cleared";

export type Clearance =
  | { state: "cleared"; key: string; shown: ProofValue | null; cleared: ProofValue; basis: FigureBasis }
  | { state: "verifying"; key: string | null; shown: ProofValue | null }
  | {
      state: "withheld";
      key: string | null;
      shown: ProofValue | null;
      reason: WithheldReason;
      detail: string;
      /** What the sweep cleared, on a mismatch. */
      cleared?: ProofValue;
      problems?: SweepProblem[];
      blockers?: BlockerRef[];
    };

/** Whether two values differ (cents to the cent, ratios to 1e-9, words exactly). */
export function differs(shown: ProofValue, figure: ProofValue): boolean {
  if ("cents" in shown) return !("cents" in figure) || Math.round(shown.cents) !== Math.round(figure.cents);
  if ("ratio" in shown) return !("ratio" in figure) || Math.abs(shown.ratio - figure.ratio) > 1e-9;
  return !("text" in figure) || shown.text !== figure.text;
}

export const showValue = (v: ProofValue) => ("cents" in v ? `${(v.cents / 100).toFixed(2)}` : "ratio" in v ? `${v.ratio}` : v.text);

/** The value a page shows for a figure (the total, before any per-month split), or null when it states none. */
export const shownOf = (f: ShownFigure): ProofValue | null => (f.shownCents != null ? { cents: f.shownCents } : (f.shown ?? null));

/**
 * Whether a figure may show. `pageStamp` is the stamp of the data the page was built from
 * (useApi's x-data-stamp); `blockers` the findings the page knows block it.
 */
export function clearanceOf(f: ShownFigure | Unswept, s: SweepState, pageStamp: string | null, blockers: readonly BlockerRef[] = []): Clearance {
  // Findings first: a blocked figure says what blocks it, proof or none.
  if (blockers.length)
    return { state: "withheld", key: isUnswept(f) ? null : descriptorKey(f.descriptor), shown: isUnswept(f) ? null : shownOf(f), reason: "blocked", detail: `Can't be proven: ${blockers.map((b) => b.title).join("; ")}`, blockers: [...blockers] };
  if (isUnswept(f)) return { state: "withheld", key: null, shown: null, reason: "unswept", detail: `No proof yet: ${f.unswept}` };
  const key = descriptorKey(f.descriptor);
  const shown = shownOf(f);
  const withheld = (reason: WithheldReason, detail: string, extra: object = {}): Clearance => ({ state: "withheld", key, shown, reason, detail, ...extra });
  if (s.status === "failed") return withheld("failed", `The proof sweep didn't answer, so nothing can be cleared: ${s.error ?? "no answer"}`);
  if (pageStamp == null || s.stamp !== pageStamp) {
    if (s.status === "pending") return { state: "verifying", key, shown };
    return withheld("stale", pageStamp == null ? "The page's data carries no stamp, so no sweep can vouch for it." : "The proof sweep ran on other data than this page shows.");
  }
  if (s.status === "pending") return { state: "verifying", key, shown };
  const problems = s.problems[key];
  if (problems?.length) return withheld("flagged", problems.map((p) => p.detail).join(" "), { problems });
  const cleared = s.cleared[key];
  if (!cleared) return withheld("not-cleared", "The proof sweep doesn't hold this figure to its proof (never swept).");
  if (shown && differs(shown, cleared)) return withheld("mismatch", `The page shows ${showValue(shown)}; its proof cleared ${showValue(cleared)}.`, { cleared });
  return { state: "cleared", key, shown, cleared, basis: s.basis[key] ?? "proven" };
}

/**
 * The browser's sweep state from one answer of GET /api/proof/sweep: 200 the report, 202
 * the sweep of `stamp` still running, anything else (or no answer: `null`) failed. A
 * failure is never "nothing flagged": every figure is withheld until a sweep answers.
 */
export function sweepAnswer(status: number | null, body: unknown, why?: string): SweepState {
  const b = (body ?? {}) as Partial<{ stamp: string; status: string; cleared: Record<string, ProofValue>; basis: Record<string, ClearedBasis>; problems: Record<string, SweepProblem[]>; error: string }>;
  const failed = (error: string): SweepState => ({ stamp: typeof b.stamp === "string" ? b.stamp : null, status: "failed", cleared: {}, basis: {}, problems: {}, error });
  if (status == null) return failed(why ?? "The server didn't answer.");
  if (status === 202 && typeof b.stamp === "string") return { stamp: b.stamp, status: "pending", cleared: {}, basis: {}, problems: {} };
  if (status !== 200) return failed(b.error ?? `The server answered ${status}.`);
  if (typeof b.stamp !== "string" || !b.cleared || !b.problems) return failed("The sweep's answer has no stamp or verdicts.");
  return { stamp: b.stamp, status: "ready", cleared: b.cleared, basis: b.basis ?? {}, problems: b.problems };
}
