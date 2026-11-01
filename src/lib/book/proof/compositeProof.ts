import { compose, COMPOSITE_OPS, type CompositeDescriptor, type CompositeOp } from "./composite.ts";
import { buildProof, parseDescriptor } from "./index.ts";
import type { ChainLine, Proof, ProofContext, ProofKind } from "./types.ts";

/**
 * The proof behind a composite figure (composite.ts): each part's own proof built on the
 * server, and the arithmetic over the values they prove, each part opening its proof. The
 * page clears the figure from the parts' cleared values; this is what the drawer shows.
 */

export function parseCompositeDescriptor(d: Record<string, unknown>, depth = 0): CompositeDescriptor | { error: string } {
  const op = d.op as CompositeOp;
  if (!Object.hasOwn(COMPOSITE_OPS, op)) return { error: `op must be one of: ${Object.keys(COMPOSITE_OPS).join(", ")}.` };
  const { min, max } = COMPOSITE_OPS[op];
  if (!Array.isArray(d.of) || d.of.length < min || d.of.length > max) return { error: `of must list ${min === max ? min : `${min} to ${max}`} figures.` };
  const of: CompositeDescriptor["of"][number][] = [];
  for (const x of d.of) {
    // One level of nesting (a share of a sum); a part's parts are figures of their own.
    if (depth > 0 && x && typeof x === "object" && (x as { report?: unknown }).report === "composite") return { error: "A composite nests one level at most." };
    const p = x && typeof x === "object" && (x as { report?: unknown }).report === "composite" ? parseCompositeDescriptor(x as Record<string, unknown>, depth + 1) : parseDescriptor(x);
    if ("error" in p) return { error: `A part: ${p.error}` };
    of.push(p as CompositeDescriptor["of"][number]);
  }
  if (op === "times" && (typeof d.n !== "number" || !Number.isFinite(d.n) || Math.abs(d.n) > 1e9)) return { error: "times needs the number it multiplies by (n)." };
  if (d.per != null && (!Array.isArray(d.per) || d.per.length !== of.length || d.per.some((n) => !Number.isInteger(n) || (n as number) < 1 || (n as number) > 1200))) return { error: "per must give each part a whole number of months." };
  return { report: "composite", op, of, ...(d.per ? { per: d.per as number[] } : {}), ...(op === "times" ? { n: d.n as number } : {}) };
}

const OPS: Record<CompositeOp, ChainLine["op"]> = { share: "÷", growth: "÷", diff: "−", sum: "+", scale: "×", times: "×" };

export async function buildCompositeProof(ctx: ProofContext, d: CompositeDescriptor): Promise<Proof> {
  const parts = await Promise.all(d.of.map((p) => buildProof(ctx, p)));
  const value = compose(
    d.op,
    parts.map((p) => p.figure),
    d.per,
    d.n,
  );
  if (!value) throw new Error("It has no value: a share or growth of nothing.");
  const each = (p: Proof, i: number): ChainLine[] => {
    const line: ChainLine = { label: p.describes, value: p.figure, source: "derived", link: { label: p.describes, descriptor: d.of[i]! } };
    const n = d.per?.[i];
    if (!n || n === 1 || !("cents" in p.figure)) return [{ ...(i ? { op: OPS[d.op] } : {}), ...line }];
    // A part over months: its total, then a month of it, which is what the arithmetic uses.
    return [{ ...line, ...(i ? { note: "over its months, next line" } : {}) }, { ...(i ? { op: OPS[d.op] } : {}), label: `${p.describes}, a month (÷ ${n})`, value: { cents: p.figure.cents / n }, source: "derived" }];
  };
  const lines: ChainLine[] = parts.flatMap(each);
  if (d.op === "times") lines.push({ op: "×", label: "The number you typed", value: { ratio: d.n! }, source: "assumption" });
  // a × b ÷ c: the third part divides.
  if (d.op === "scale" && lines.length === 3) lines[2] = { ...lines[2]!, op: "÷" };
  if (d.op === "growth" && "ratio" in value) lines.push({ op: "=", label: "Ratio", value: { ratio: value.ratio + 1 }, source: "derived" }, { op: "−", label: "Less one", value: { ratio: 1 }, source: "derived" });
  lines.push({ op: "=", label: "This figure", value, source: "derived" });
  return {
    report: "composite",
    descriptor: d,
    describes: d.op === "scale" ? `${parts[0]!.describes}, scaled by ${parts[1]!.describes} over ${parts[2]!.describes}` : `${parts.map((p) => p.describes).join(d.op === "sum" ? " + " : d.op === "diff" ? " − " : " ÷ ")}${d.op === "growth" ? ", less one" : ""}`,
    figure: value,
    selfCheck: null,
    // Its parts are proven on their own, each by its own route: the arithmetic is all it adds.
    rederived: { none: "Arithmetic over figures each proven on its own: their proofs carry the independent routes." },
    withheld: parts.some((p) => p.withheld),
    blocks: [{ kind: "chain", title: `How it's worked out: ${COMPOSITE_OPS[d.op].words}`, lines }],
    checks: parts.flatMap((p) => p.checks),
    estimates: parts.flatMap((p) => p.estimates),
    through: parts.map((p) => p.through).sort()[0] ?? ctx.book.today,
    today: ctx.book.today,
  };
}

export const compositeKind: ProofKind<CompositeDescriptor> = {
  report: "composite",
  parse: parseCompositeDescriptor,
  build: buildCompositeProof,
};
