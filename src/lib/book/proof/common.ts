import { acceptedFor, blockersFor, passesFor, type BlockerQuery } from "../blockers.ts";
import type { Book } from "../load.ts";
import { CHECKS, type CheckId } from "../types.ts";
import type { ProofCheck, ProofEstimate } from "./types.ts";

/** What a pass list shows per check before "… and N more". */
const SUBJECT_CAP = 200;

/**
 * Every check in `ids` over a figure's scope, each in one of four states: passed (with
 * what it passed on), open (a finding withholds the figure), accepted (the owner
 * explained it), or nothing in scope, so a check with nothing to look at is never
 * presented as a pass. Blockers, exceptions and passes are all found by the same scope
 * test (blockers.ts scopeHits). `withheld`: some open finding covers the figure. Several
 * queries take whatever any of them covers.
 */
export function checksFor(book: Book, q: BlockerQuery | BlockerQuery[], ids: CheckId[]): { checks: ProofCheck[]; withheld: boolean } {
  // Several queries (a figure built from pay, taxes and bank accounts): each finding and pass once.
  const qs = Array.isArray(q) ? q : [q];
  const once = <T,>(xs: T[]) => [...new Set(xs)];
  const open = once(qs.flatMap((x) => blockersFor(book, x)));
  const accepted = once(qs.flatMap((x) => acceptedFor(book, x)));
  const passes = once(qs.flatMap((x) => passesFor(book, x)));
  const checks = ids.map((id): ProofCheck => {
    const def = CHECKS.find((c) => c.id === id)!;
    const mine = passes.filter((p) => p.check === id);
    const o = open.filter((f) => f.check === id);
    const a = accepted.filter((f) => f.check === id);
    const passed = mine.reduce((t, p) => t + p.n, 0);
    return {
      id,
      title: def.title,
      description: def.description,
      state: o.length ? "open" : a.length ? "accepted" : passed ? "passed" : "none",
      passed,
      subjects: mine.slice(0, SUBJECT_CAP).map((p) => p.subject),
      open: o.map((f) => ({ id: f.id, status: f.status, title: f.title, detail: f.detail, fix: f.fix })),
      accepted: a.map((f) => ({ id: f.id, status: f.status, title: f.title, detail: f.detail, note: f.note, acceptedAt: f.acceptedAt })),
    };
  });
  return { checks, withheld: open.length > 0 };
}

/**
 * What stands on an inference rather than a printed line: inferences about the listed
 * rows, and card cycles with no statement counted as $0 (proven idle from the paying
 * bank's side) for the accounts and window in scope.
 */
export function estimatesFor(book: Book, opts: { rowIds: Set<string>; from: string; to: string; accountIds?: string[] }): ProofEstimate[] {
  const inScope = (id: string) => !opts.accountIds?.length || opts.accountIds.includes(id);
  const name = (id: string) => book.accounts.find((a) => a.id === id)?.name;
  return [
    ...book.integrity.inferences.filter((i) => i.rowIds?.some((id) => opts.rowIds.has(id))).map((i) => ({ id: i.id, title: i.title, detail: i.detail })),
    ...book.idle.proven
      .filter((w) => inScope(w.accountId) && w.from <= opts.to && w.to >= opts.from)
      .map((w) => ({
        id: `idle:${w.accountId}:${w.from}`,
        title: `${name(w.accountId) ?? "A card"}: no statement ${w.from} – ${w.to}, counted as $0`,
        detail: "The issuer sends no statement for a cycle without activity; the paying bank's statements prove nothing happened.",
      })),
  ];
}

/** A YYYY-MM-DD date in a request body. */
export const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Whether parts re-added on their own come to the figure. */
export function sumCheck(figureCents: number, partsCents: number, explain: string) {
  return { ok: figureCents === partsCents, deltaCents: partsCents - figureCents, explain };
}
