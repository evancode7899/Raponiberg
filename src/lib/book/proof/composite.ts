import type { ProofDescriptor } from "./index.ts";
import { descriptorKey } from "./key.ts";
import type { ProofValue } from "./types.ts";

/**
 * A composite figure (SSOT F6): plain arithmetic a page draws over figures the proof sweep
 * proves on their own — a share of a total, the change between two of them, a sum of a few,
 * a growth rate. It has no sweep entry of its own and needs none: it clears only once every
 * part has cleared, at the value worked out here from the parts' cleared values (never from
 * the page's numbers), so it can't drift from them. Its proof is the arithmetic, each part
 * opening its own proof (compositeProof.ts). Pure; runs on the server and in the browser.
 */

export type CompositeOp = "share" | "diff" | "sum" | "growth" | "scale" | "times";
/**
 * `per`: each part divided by this many (months) first, so a change compares monthly averages
 * of runs of different lengths. `n`: what "times" multiplies its one part by — a number you
 * typed (a trip's miles), named in the recipe so the proof says so.
 */
export type CompositeDescriptor = { report: "composite"; op: CompositeOp; of: readonly ProofDescriptor[]; per?: readonly number[]; n?: number };

/** What each operation is: how many parts, and in words. */
export const COMPOSITE_OPS: Record<CompositeOp, { min: number; max: number; words: string }> = {
  share: { min: 2, max: 2, words: "the first as a share of the second" },
  diff: { min: 2, max: 2, words: "the first less the second" },
  sum: { min: 2, max: 5000, words: "the parts added up" },
  growth: { min: 2, max: 2, words: "the first over the second, less one" },
  scale: { min: 3, max: 3, words: "the first, scaled by the second over the third" },
  times: { min: 1, max: 1, words: "the figure times the number you typed" },
};

export const isComposite = (d: { report: string }): d is CompositeDescriptor => d.report === "composite";

const num = (v: ProofValue): number | null => ("cents" in v ? v.cents : "ratio" in v ? v.ratio : null);

/** The composite's value from its parts' values (each over its `per`), or null where it has none (a share of nothing). */
export function compose(op: CompositeOp, parts: readonly ProofValue[], per?: readonly number[], n?: number): ProofValue | null {
  const xs = parts.map((v, i) => {
    const x = num(v);
    return x == null ? null : x / (per?.[i] || 1);
  });
  if (xs.some((x) => x == null) || xs.length < COMPOSITE_OPS[op].min) return null;
  const [a, b] = xs as number[];
  const money = "cents" in parts[0]!;
  switch (op) {
    case "times":
      return n == null ? null : money ? { cents: a! * n } : { ratio: a! * n };
    case "share":
      return b ? { ratio: a! / b } : null;
    case "growth":
      return b ? { ratio: a! / b - 1 } : null;
    case "diff":
      return money ? { cents: a! - b! } : { ratio: a! - b! };
    case "scale": {
      const c = xs[2]!;
      return c ? (money ? { cents: (a! * b!) / c } : { ratio: (a! * b!) / c }) : null;
    }
    case "sum": {
      const s = (xs as number[]).reduce((t, x) => t + x, 0);
      return money ? { cents: s } : { ratio: s };
    }
  }
}

/** A composite worked out from the sweep's cleared values, or the parts it still waits on. */
export function composeCleared(d: CompositeDescriptor, cleared: Readonly<Record<string, ProofValue>>): { value: ProofValue | null; parts: string[] } | { missing: string[] } {
  // A part may itself be a composite (a share of a sum): worked out from its own parts.
  const parts = d.of.map(descriptorKey);
  const values = parts.map((k) => clearedValue(k, cleared));
  const missing = parts.filter((_, i) => !values[i]);
  if (missing.length) return { missing };
  return { value: compose(d.op, values as ProofValue[], d.per, d.n), parts };
}

/** A figure's cleared value by its descriptor key: the sweep's own, or a composite's worked out from its parts. Null when it hasn't cleared. */
export function clearedValue(key: string, cleared: Readonly<Record<string, ProofValue>>): ProofValue | null {
  if (cleared[key]) return cleared[key];
  if (!key.startsWith("{")) return null;
  try {
    const d = JSON.parse(key) as { report?: string };
    if (d.report !== "composite") return null;
    const r = composeCleared(d as CompositeDescriptor, cleared);
    return "value" in r ? r.value : null;
  } catch {
    return null;
  }
}
