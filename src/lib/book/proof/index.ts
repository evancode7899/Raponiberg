import { cashFlowKind, type CashFlowDescriptor } from "./cashFlowProof.ts";
import { filedReturnKind, type FiledReturnDescriptor } from "./filedReturnProof.ts";
import type { Proof, ProofContext, ProofKind } from "./types.ts";

/**
 * Every kind of proof the app can show, by the `report` its descriptors name.
 *
 * Adding one (net worth, pay, the forecast…):
 *  1. A module beside cashFlowProof.ts exporting its descriptor type and a ProofKind:
 *     `parse` validates a request body, `build` re-derives the figure from the Book and
 *     returns a Proof (types.ts) made of rows / breakdown / chain blocks. The drawer
 *     draws those as they are: a kind needs no UI of its own.
 *  2. Its descriptor in the ProofDescriptor union and its kind in KINDS, below.
 *  3. Tests with invented fixtures: the parts re-add to the figure (selfCheck.ok), and
 *     every link it emits parses and builds (see index.test.ts).
 * Checks over the figure come from checksFor (common.ts), with the list of checks that
 * can withhold that kind of figure.
 */
export type ProofDescriptor = CashFlowDescriptor | FiledReturnDescriptor;

const KINDS: { [R in ProofDescriptor["report"]]: ProofKind<Extract<ProofDescriptor, { report: R }>> } = {
  "cash-flow": cashFlowKind,
  "filed-return": filedReturnKind,
};

const kindOf = (report: string) => (Object.hasOwn(KINDS, report) ? (KINDS[report as ProofDescriptor["report"]] as ProofKind<ProofDescriptor>) : null);

/** A descriptor from a request body, or why it's not one. */
export function parseDescriptor(body: unknown): ProofDescriptor | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object." };
  const d = body as Record<string, unknown>;
  const kind = typeof d.report === "string" ? kindOf(d.report) : null;
  if (!kind) return { error: `report must be one of: ${Object.keys(KINDS).join(", ")}.` };
  return kind.parse(d);
}

/** The proof behind the figure a descriptor names. */
export function buildProof(ctx: ProofContext, d: ProofDescriptor): Promise<Proof> {
  return Promise.resolve(kindOf(d.report)!.build(ctx, d));
}

export type { Proof, ProofBlock, ProofLink } from "./types.ts";
