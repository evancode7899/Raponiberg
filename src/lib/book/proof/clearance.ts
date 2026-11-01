import type { FigureBasis } from "../figure.ts";
import type { BlockerRef } from "../reports/blockerRef.ts";
import type { ProofDescriptor } from "./index.ts";
import { composeCleared, isComposite } from "./composite.ts";
import { descriptorKey, whatIfModelKey } from "./key.ts";
import type { ProofValue } from "./types.ts";

/**
 * Fail-closed clearance: whether a page may show a figure's number. Pure; runs on the
 * server and in the browser alike.
 *
 * A figure shows when the proof sweep (sweep.ts) of the very data the page was built from
 * (its stamp, cache.ts stampTag) cleared its recipe, and the page shows the value the sweep
 * cleared. Anything else withholds it: the sweep failing or never answering, a finding
 * blocking it, a flag, a different number, a recipe the sweep never held to its proof.
 *
 * Two exceptions keep the app quick (owner's rule, 2026-11-01). While the sweep of fresh
 * data runs ("verifying"), the page's number shows plain, and is withheld the moment the
 * sweep answers with a problem. A calculator figure on inputs the owner typed stands on the
 * model the sweep cleared on the saved inputs (whatIfStands).
 */

export type SweepProblemKind = "DIFFERS" | "SELF_CHECK" | "CHAIN" | "REDERIVE" | "WITHHELD" | "LINK" | "ERROR" | "SKIPPED";
export type SweepProblem = { kind: SweepProblemKind; page: string; descriptor: ProofDescriptor | null; detail: string };

/** The kinds that keep a figure from clearing. A LINK problem is the linked proof's, not this figure's. */
export const BLOCKING_KINDS: readonly SweepProblemKind[] = ["DIFFERS", "SELF_CHECK", "CHAIN", "REDERIVE", "WITHHELD", "ERROR"];

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
  /** Calculator models the sweep held to their proofs on the saved inputs (key.ts whatIfModelKey): true when every figure of one cleared. */
  models?: Readonly<Record<string, boolean>>;
  /** Why the sweep failed, when it did. */
  error?: string;
};

export const NO_SWEEP: SweepState = { stamp: null, status: "failed", cleared: {}, basis: {}, problems: {}, models: {}, error: "No proof sweep here: figures can't be checked outside the app." };

/** A figure the page shows: its recipe and the value shown (cents before any per-month split; `shown` for a rate or words). */
export type ShownFigure = { descriptor: ProofDescriptor; shownCents: number | null; shown?: ProofValue; perMonths?: number };

/** A figure with no proof yet: always withheld, saying why. F3 gives each one a proof. */
export type Unswept = { unswept: string };
export const unswept = (why: string): Unswept => ({ unswept: why });
export const isUnswept = (x: unknown): x is Unswept => typeof x === "object" && x !== null && ("unswept" in x || "noFigure" in x);

/**
 * Where a figure would sit but there is none to show (no fill-ups logged, no warranty set):
 * not a figure at all, so nothing to prove. It renders the same dash a withheld figure
 * does, and says why; it can never carry a number.
 */
export type NoFigure = { noFigure: string };
export const noFigure = (why: string): Unswept => ({ unswept: why, noFigure: why }) as Unswept & NoFigure;
export const isNoFigure = (x: unknown): x is NoFigure => typeof x === "object" && x !== null && "noFigure" in x;

export type WithheldReason = "unswept" | "no-figure" | "blocked" | "flagged" | "mismatch" | "stale" | "failed" | "not-cleared";

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
  if (isNoFigure(f)) return { state: "withheld", key: null, shown: null, reason: "no-figure", detail: `Nothing to show: ${f.noFigure}` };
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
  // A composite (a share, a change, a sum of proven figures) clears from its parts' cleared values, never the page's.
  if (isComposite(f.descriptor)) {
    const parts = f.descriptor.of.map(descriptorKey);
    const flagged = parts.flatMap((k) => s.problems[k] ?? []);
    if (flagged.length) return withheld("flagged", flagged.map((p) => p.detail).join(" "), { problems: flagged });
    const r = composeCleared(f.descriptor, s.cleared);
    // Parts worked out on inputs the owner typed: the composite is the page's arithmetic on its own model figures.
    if ("missing" in r && r.missing.every((k) => whatIfStands(k, s))) return { state: "cleared", key, shown, cleared: shown ?? ON_TYPED_INPUTS, basis: "proven" };
    if ("missing" in r) return withheld("not-cleared", `${r.missing.length} of its ${parts.length} parts haven't cleared, so it can't be worked out.`);
    if (!r.value) return withheld("not-cleared", "It has no value: a share or growth of nothing.");
    if (shown && differs(shown, r.value)) return withheld("mismatch", `The page shows ${showValue(shown)}; its parts work out to ${showValue(r.value)}.`, { cleared: r.value });
    const basis = parts.map((k) => s.basis[k]).find((b) => b === "estimate") ?? parts.map((k) => s.basis[k]).find(Boolean) ?? "proven";
    return { state: "cleared", key, shown, cleared: r.value, basis };
  }
  const problems = s.problems[key];
  if (problems?.length) return withheld("flagged", problems.map((p) => p.detail).join(" "), { problems });
  const cleared = s.cleared[key];
  // A calculator figure on inputs the owner typed: the same model, on the same Book, the sweep cleared on the saved inputs.
  if (!cleared && whatIfStands(key, s)) return { state: "cleared", key, shown, cleared: shown ?? ON_TYPED_INPUTS, basis: "proven" };
  if (!cleared) return withheld("not-cleared", "The proof sweep doesn't hold this figure to its proof (never swept).");
  if (shown && differs(shown, cleared)) return withheld("mismatch", `The page shows ${showValue(shown)}; its proof cleared ${showValue(cleared)}.`, { cleared });
  return { state: "cleared", key, shown, cleared, basis: s.basis[key] ?? "proven" };
}

/** What a calculator figure on typed inputs clears at when the page states no value of its own (a rate it draws in words). */
const ON_TYPED_INPUTS: ProofValue = { text: "worked out on the inputs typed" };

/**
 * Whether a figure the sweep never saw stands on a model it did: a calculator figure (or a
 * composite of them) on inputs the owner typed, whose model cleared on the saved inputs.
 * Sensitivities and what-ifs update the moment an input changes, with no sweep to wait for.
 */
function whatIfStands(key: string, s: SweepState): boolean {
  // Its drawer builds the proof on the typed inputs themselves, so it can still be opened and checked.
  if (s.cleared[key]) return true;
  if (s.problems[key]?.some((p) => BLOCKING_KINDS.includes(p.kind))) return false;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(key) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (d.report === "composite") return Array.isArray(d.of) && d.of.length > 0 && d.of.every((p) => whatIfStands(descriptorKey(p), s));
  const model = whatIfModelKey(d);
  return model != null && s.models?.[model] === true;
}

/**
 * The browser's sweep state from one answer of GET /api/proof/sweep: 200 the report, 202
 * the sweep of `stamp` still running, anything else (or no answer: `null`) failed. A
 * failure is never "nothing flagged": every figure is withheld until a sweep answers.
 */
export function sweepAnswer(status: number | null, body: unknown, why?: string): SweepState {
  const b = (body ?? {}) as Partial<{ stamp: string; status: string; cleared: Record<string, ProofValue>; basis: Record<string, ClearedBasis>; problems: Record<string, SweepProblem[]>; models: Record<string, boolean>; error: string }>;
  const failed = (error: string): SweepState => ({ stamp: typeof b.stamp === "string" ? b.stamp : null, status: "failed", cleared: {}, basis: {}, problems: {}, error });
  if (status == null) return failed(why ?? "The server didn't answer.");
  if (status === 202 && typeof b.stamp === "string") return { stamp: b.stamp, status: "pending", cleared: {}, basis: {}, problems: {} };
  if (status !== 200) return failed(b.error ?? `The server answered ${status}.`);
  if (typeof b.stamp !== "string" || !b.cleared || !b.problems) return failed("The sweep's answer has no stamp or verdicts.");
  return { stamp: b.stamp, status: "ready", cleared: b.cleared, basis: b.basis ?? {}, problems: b.problems, models: b.models ?? {} };
}
