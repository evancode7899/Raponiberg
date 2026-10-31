import { acceptedFor, blockersFor, passesFor, type BlockerQuery } from "../blockers.ts";
import type { Book } from "../load.ts";
import { CHECKS, type CheckId } from "../types.ts";
import { deepFreeze } from "../freeze.ts";
import type { ChainLine, ProofCheck, ProofContext, ProofEstimate } from "./types.ts";

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
  // A finding that withholds the figure is always listed, even from a check this kind of
  // figure doesn't usually name (a damaged settings file): nothing withholds unexplained.
  const listed = [...ids, ...once(open.map((f) => f.check)).filter((id) => !ids.includes(id))];
  const checks = listed.map((id): ProofCheck => {
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
 * rows, rows the classifier wasn't sure of (counted as filed until answered on Review),
 * and card cycles with no statement counted as $0 (proven idle from the paying bank's
 * side) for the accounts and window in scope.
 */
export function estimatesFor(book: Book, opts: { rowIds: Set<string>; from: string; to: string; accountIds?: string[] }): ProofEstimate[] {
  const inScope = (id: string) => !opts.accountIds?.length || opts.accountIds.includes(id);
  const name = (id: string) => book.accounts.find((a) => a.id === id)?.name;
  const unreviewed = [...opts.rowIds].map((id) => book.rowById.get(id)).filter((r) => r?.needsReview);
  return [
    ...book.integrity.inferences
      .filter((i) => i.rowIds?.some((id) => opts.rowIds.has(id)) || (i.scope?.accountId && inScope(i.scope.accountId) && i.scope.from <= opts.to && i.scope.to >= opts.from))
      .map((i) => ({ id: i.id, title: i.title, detail: i.detail })),
    ...(unreviewed.length ? [unreviewedEstimate(unreviewed.map((r) => r!))] : []),
    ...book.idle.proven
      .filter((w) => inScope(w.accountId) && w.from <= opts.to && w.to >= opts.from)
      .map((w) => ({
        id: `idle:${w.accountId}:${w.from}`,
        title: `${name(w.accountId) ?? "A card"}: no statement ${w.from} – ${w.to}, counted as $0${w.provisionalFrom ? ` (provisional from ${w.provisionalFrom})` : ""}`,
        detail: w.provisionalFrom
          ? "The issuer sends no statement for a cycle without activity; the paying bank's statements show no payment to it, though from the provisional date a payment could still come on the next bank statement."
          : "The issuer sends no statement for a cycle without activity; the paying bank's statements prove nothing happened.",
      })),
  ];
}

/** Rows counted as the classifier filed them, though it asked for a person's answer. */
export function unreviewedEstimate(rows: { amountCents: number; category: string }[]): ProofEstimate {
  const cents = rows.reduce((s, r) => s + Math.abs(r.amountCents), 0);
  return {
    id: "review:unanswered",
    title: `${rows.length} row${rows.length === 1 ? "" : "s"} awaiting review counted as filed (${(cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })})`,
    detail: `The classifier wasn't sure of ${rows.length === 1 ? "this row" : "these rows"} (${[...new Set(rows.map((r) => r.category))].join(", ")}). Answer ${rows.length === 1 ? "it" : "them"} on Review to settle the figure.`,
  };
}

/** A YYYY-MM-DD date in a request body. */
export const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Whether parts re-added on their own come to the figure. */
export function sumCheck(figureCents: number, partsCents: number, explain: string) {
  return { ok: figureCents === partsCents, deltaCents: partsCents - figureCents, explain };
}

/**
 * Where a chain's money steps don't re-add: every line up to an "=" adds or subtracts into
 * a running total that must equal the "=" line exactly. A step with a × or ÷, a line in
 * words, or a list (a second line with no op) isn't a sum, so it isn't held to one.
 */
export function chainReAdds(lines: ChainLine[]): string[] {
  const bad: string[] = [];
  let acc: number | null = null;
  let additive = true;
  for (const l of lines) {
    const c = "cents" in l.value ? l.value.cents : null;
    if (l.op === "=") {
      if (additive && acc != null && c != null && acc !== c) bad.push(`${l.label}: parts ${acc} ≠ ${c}`);
      acc = c;
      additive = true;
    } else if (l.op === "×" || l.op === "÷" || c == null) additive = false;
    else if (l.op === "−") acc = (acc ?? 0) - c;
    else if (l.op === "+" || acc == null) acc = (acc ?? 0) + c;
    else additive = false; // a second line without an op: a list, not a sum
  }
  return bad;
}

const memos = new WeakMap<object, WeakMap<object, Map<string, Promise<unknown>>>>();

/**
 * What a proof reads besides the Book (a page's report, the forecast, a year's tax return),
 * worked out once per Book and settings database and shared by every proof built on them:
 * the drawer opens figures in a row and the sweep opens thousands, and each would otherwise
 * rebuild the same report. A new Book (any change to the data or settings) starts afresh.
 * The value is frozen, so a proof that tried to change what the next one reads throws.
 */
export function perBook<T>(ctx: ProofContext, key: string, work: () => T | Promise<T>): Promise<T> {
  let byDb = memos.get(ctx.book);
  if (!byDb) memos.set(ctx.book, (byDb = new WeakMap()));
  let byKey = byDb.get(ctx.db);
  if (!byKey) byDb.set(ctx.db, (byKey = new Map()));
  if (!byKey.has(key)) {
    const p = Promise.resolve().then(work).then((v) => deepFreeze(v));
    // A failed load isn't kept: the next proof tries again.
    p.catch(() => byKey!.delete(key));
    byKey.set(key, p);
  }
  return byKey.get(key) as Promise<T>;
}
