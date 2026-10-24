import { addDays, maxIso, minIso } from "../dates/isoDate.ts";
import type { Book } from "./load.ts";
import type { AcceptedFinding, CheckPass, Finding, FindingScope } from "./types.ts";

export type BlockerQuery = {
  affects: FindingScope["affects"][number];
  from: string;
  to: string;
  /** Only findings for these accounts (any account when omitted). */
  accountIds?: string[];
  personId?: string;
  /** Only findings for these employers (stub employer keys; any employer when omitted). */
  employerKeys?: string[];
};

/**
 * The findings that make a figure unprovable: failures or missing data of the right kind
 * whose window overlaps the figure's period (and its accounts/person, when given). A
 * finding past the data edge (Finding.atEdge) only ever blocks days after the edge: its
 * window's lead-in (a transfer's matching days) doesn't reach back into proven data.
 */
export function blockersFor(book: Book, q: BlockerQuery): Finding[] {
  const hits = scopeHits(book, q);
  return book.integrity.findings.filter((f) => [f.scope, ...(f.extraScopes ?? [])].some((s) => hits(s, !!f.atEdge)));
}

/**
 * Whether a scope bears on a figure: the right kind, a window overlapping the figure's
 * period, and its accounts/person when both name one. The one test behind blockers, the
 * exceptions and the passes a figure's proof lists (book/proof), so they can't disagree
 * about what covers a figure.
 */
export function scopeHits(book: Book, q: BlockerQuery): (s: FindingScope, atEdge?: boolean) => boolean {
  // Only findings past the data edge need it; a figure's passes ask thousands of times.
  let afterEdge: string | undefined;
  return (s, atEdge = false) => {
    if (!s.affects.includes(q.affects)) return false;
    const from = atEdge ? maxIso(s.from, (afterEdge ??= addDays(book.horizon.netWorth, 1))) : s.from;
    if (s.to < q.from || from > q.to) return false;
    if (q.accountIds && s.accountId && !q.accountIds.includes(s.accountId)) return false;
    if (q.personId && s.personId && s.personId !== q.personId) return false;
    if (q.employerKeys && s.employerKey && !q.employerKeys.includes(s.employerKey)) return false;
    return true;
  };
}

/**
 * Book.passes by what each affects and its account ("" for none), as positions in the list,
 * made once per list: a proof sweep asks for thousands of figures' passes, most of them
 * one account's, and testing every pass for each was most of its time.
 */
type PassIndex = { n: number; all: Map<string, number[]>; byAccount: Map<string, number[]> };
const passIndexes = new WeakMap<CheckPass[], PassIndex>();
const append = (m: Map<string, number[]>, k: string, i: number) => {
  const list = m.get(k);
  if (list) list.push(i);
  else m.set(k, [i]);
};

/** The passing checks that cover a figure (Book.passes), by the same test as its blockers. */
export function passesFor(book: Book, q: BlockerQuery): CheckPass[] {
  const passes = book.passes;
  let ix = passIndexes.get(passes);
  if (!ix || ix.n !== passes.length) {
    ix = { n: passes.length, all: new Map(), byAccount: new Map() };
    passes.forEach((p, i) => {
      for (const a of new Set(p.scope.affects)) {
        append(ix!.all, a, i);
        append(ix!.byAccount, `${a}|${p.scope.accountId ?? ""}`, i);
      }
    });
    passIndexes.set(passes, ix);
  }
  // A pass for another account never covers a figure scoped to some accounts (scopeHits): only those accounts' and account-less ones can.
  const at = q.accountIds
    ? [...(ix.byAccount.get(`${q.affects}|`) ?? []), ...q.accountIds.flatMap((id) => (id ? (ix.byAccount.get(`${q.affects}|${id}`) ?? []) : []))].sort((a, b) => a - b)
    : (ix.all.get(q.affects) ?? []);
  const hits = scopeHits(book, q);
  const out: CheckPass[] = [];
  let last = -1;
  for (const i of at) {
    if (i === last) continue;
    last = i;
    if (hits(passes[i]!.scope)) out.push(passes[i]!);
  }
  return out;
}

/** The owner's accepted exceptions that cover a figure: listed, never blocking. */
export function acceptedFor(book: Book, q: BlockerQuery): AcceptedFinding[] {
  const hits = scopeHits(book, q);
  return book.integrity.accepted.filter((f) => [f.scope, ...(f.extraScopes ?? [])].some((s) => hits(s, !!f.atEdge)));
}

/**
 * Net worth over [from, to] needs the balance at the end of the day before `from` too
 * (the opening), so its blockers are looked up from that day.
 */
export function netWorthBlockers(book: Book, from: string, to: string, accountIds?: string[]): Finding[] {
  return blockersFor(book, { affects: "NET_WORTH", from: addDays(from, -1), to, accountIds });
}

/** Net worth at the end of one day: only that day's balances matter. */
export function netWorthAtBlockers(book: Book, date: string, accountIds?: string[]): Finding[] {
  return blockersFor(book, { affects: "NET_WORTH", from: date, to: date, accountIds });
}

/**
 * A tax year needs pay and investment income proven for the year (for the current year,
 * through the cash-flow horizon: the year so far, up to the data edge), and the bank
 * accounts holding interest and tax payments proven through the filing deadline (or as
 * far as statements go). `window` narrows all three to part of the year (a month or
 * quarter of the integrity timeline).
 */
export function taxBlockers(book: Book, year: number, window?: { from: string; to: string }): Finding[] {
  const yearEnd = taxYearThrough(book, year);
  const from = window?.from ?? `${year}-01-01`;
  const to = window ? minIso(window.to, yearEnd) : yearEnd;
  const bankTo = window?.to ?? minIso(`${year + 1}-04-30`, book.horizon.cashFlow);
  const bankIds = book.accounts.filter((a) => a.group === "Cash").map((a) => a.id);
  const all = [
    ...blockersFor(book, { affects: "PAY", from, to }),
    ...blockersFor(book, { affects: "TAX", from, to }),
    ...blockersFor(book, { affects: "CASH_FLOW", from, to: bankTo, accountIds: bankIds }),
  ];
  return [...new Map(all.map((f) => [f.id, f])).values()];
}

/** The last day a tax year's figures run through: year end, or for the current year the cash-flow horizon. */
export function taxYearThrough(book: Book, year: number): string {
  const end = `${year}-12-31`;
  return Number(book.today.slice(0, 4)) === year ? minIso(end, book.horizon.cashFlow) : minIso(end, book.today);
}
