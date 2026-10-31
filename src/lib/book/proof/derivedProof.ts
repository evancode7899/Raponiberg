import { DERIVED_PAGES, derivedList } from "../derived/load.ts";
import { derivedKey, type DerivedDescriptor, type DerivedPage, type DerivedScope } from "../derived/types.ts";
export type { DerivedScope };
import { checksFor } from "./common.ts";
import type { Proof, ProofBlock, ProofContext, ProofKind } from "./types.ts";

/**
 * The proof behind a derived figure (derived/types.ts): the page's report rebuilt on the
 * server as its route builds it, the figure found in the page's own list, and how it is
 * worked out, line by line, with the parts it is made of and the checks over the data it
 * reads. A chain's "=" lines are held to re-add, as every chain is (sweep.ts CHAIN); a
 * figure the page's loader re-derives by a second route carries it (independence.ts).
 */

export type { DerivedDescriptor };

export function parseDerivedDescriptor(d: Record<string, unknown>): DerivedDescriptor | { error: string } {
  if (!DERIVED_PAGES.includes(d.page as DerivedPage)) return { error: `page must be one of: ${DERIVED_PAGES.join(", ")}.` };
  if (typeof d.figure !== "string" || !d.figure || d.figure.length > 80) return { error: "figure must be a figure's name." };
  if (d.key != null && (typeof d.key !== "string" || !d.key || d.key.length > 200)) return { error: "key must be an id." };
  return { report: "derived", page: d.page as DerivedPage, figure: d.figure, ...(d.key != null ? { key: d.key as string } : {}) };
}

export async function buildDerivedProof(ctx: ProofContext, d: DerivedDescriptor): Promise<Proof> {
  const { figures, scope, through, rederived } = await derivedList(ctx, d.page);
  const f = figures.find((x) => x.figure === d.figure && (x.key ?? null) === (d.key ?? null));
  if (!f?.value) throw new Error(`The ${d.page} page shows no "${d.figure}"${d.key ? ` for ${d.key}` : ""}.`);
  const s = f.scope ?? scope;
  const { checks, withheld } = s ? checksFor(ctx.book, s.query, s.checks) : { checks: [], withheld: false };
  const blocks: ProofBlock[] = [];
  if (f.lines.length) blocks.push({ kind: "chain", title: "How it's worked out", lines: f.lines, ...(f.note ? { note: f.note } : {}) });
  if (f.parts?.length) blocks.push({ kind: "breakdown", title: "What it's made of", items: f.parts });
  return {
    report: "derived",
    descriptor: d,
    describes: f.describes,
    figure: f.value,
    selfCheck: null,
    ...(rederived?.[derivedKey(f)] ? { rederived: rederived[derivedKey(f)] } : {}),
    withheld,
    blocks,
    checks,
    estimates: [],
    through,
    today: ctx.book.today,
  };
}


export const derivedKind: ProofKind<DerivedDescriptor> = {
  report: "derived",
  parse: parseDerivedDescriptor,
  build: buildDerivedProof,
};
