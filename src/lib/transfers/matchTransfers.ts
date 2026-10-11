import { daysBetween } from "../dates/isoDate.ts";
import type { AccountSubtype } from "../ingest/types.ts";

/**
 * Pairs the legs of money moving between the household's own accounts, so a dollar
 * moved from checking to brokerage (or to pay a card) is never counted as spending,
 * income, or new savings.
 *
 * Design rule: a wrong pair is worse than no pair. An unmatched transfer leg is still
 * excluded from cash flow (the classifier already knows it went to an own account) and
 * shows up on review; a wrong pair would silently hide a real transaction. So the
 * matcher only pairs what is provably unambiguous:
 *
 *   - amounts equal to the cent, opposite signs, different accounts;
 *   - each leg's named counterparty (institution / account number / account kind) must
 *     fit the other leg's account — a Chase→Fidelity EFT can't pair with an Amex row;
 *   - dates within a window sized to how that kind of money moves;
 *   - and the pairing is forced: if two candidates could claim the same leg, nothing is
 *     paired unless the only consistent assignment is the chronological one.
 *
 * Quarterly 401(k) statements report a period total (a single "Transfers" line) that can
 * be several dated legs on the other side; those match only when exactly one subset of
 * candidates sums to the cent.
 *
 * Every run recomputes AUTO matches from scratch, so the result doesn't depend on the
 * order statements were uploaded. Owner-confirmed matches and rejections are inputs.
 */

export type LegRole =
  /** Classified as a transfer with one of our own accounts. */
  | "TRANSFER"
  /**
   * A low-confidence deposit/withdrawal (e.g. "Remote Online Deposit") that may be the
   * other leg of a transfer. Can only pair with a TRANSFER leg, never another unknown.
   */
  | "UNKNOWN";

export type Leg = {
  id: string;
  accountId: string;
  institution: string;
  subtype: AccountSubtype;
  /** All identifiers (aliases) of the leg's account. */
  identifiers: string[];
  /** YYYY-MM-DD */
  date: string;
  datePrecision: "EXACT" | "PERIOD";
  /** Statement period, used to place PERIOD legs. */
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  role: LegRole;
  counterpartyInstitution?: string | null;
  counterpartyAccountHint?: string | null;
  counterpartySubtypes?: AccountSubtype[] | null;
};

export type MatchMethod = "EXACT_PAIR" | "ORDERED_PAIR" | "AGGREGATE";

export type ProposedMatch = { legIds: string[]; method: MatchMethod };

export type MatchResult = {
  matches: ProposedMatch[];
  /** Legs that had candidates but no forced pairing — owner decides. */
  ambiguous: string[][];
  /** Close-but-not-exact candidates for unmatched transfer legs (rollover fees etc.). */
  suggestions: { legIds: string[]; differenceCents: number }[];
};

const RETIREMENT: AccountSubtype[] = ["401K", "ROLLOVER_IRA", "TRADITIONAL_IRA", "ROTH_IRA"];
/** ACH/EFT/card payments settle within a few business days. */
const WINDOW_DAYS = 6;
/** Unknown-source deposits must be closer, since they carry no counterparty evidence. */
const WINDOW_UNKNOWN_DAYS = 4;
/** Plan-to-IRA rollovers move by mailed check. */
const WINDOW_ROLLOVER_DAYS = 45;
/** Slack around a quarterly statement's period for its undated legs. */
const PERIOD_SLACK_DAYS = 45;
const MAX_AGGREGATE_CANDIDATES = 16;

export function legKey(ids: string[]): string {
  return [...ids].sort().join("|");
}

function fits(from: Leg, to: Leg): boolean {
  if (from.role === "UNKNOWN") return true;
  if (from.counterpartyInstitution && from.counterpartyInstitution !== to.institution) return false;
  if (from.counterpartySubtypes?.length && !from.counterpartySubtypes.includes(to.subtype)) return false;
  const hint = from.counterpartyAccountHint;
  if (hint && !to.identifiers.some((id) => id === hint || id.endsWith(hint) || hint.endsWith(id))) return false;
  return true;
}

function isRollover(a: Leg, b: Leg): boolean {
  return (RETIREMENT.includes(a.subtype) || RETIREMENT.includes(b.subtype)) && a.institution !== b.institution;
}

function withinWindow(a: Leg, b: Leg): boolean {
  if (a.datePrecision === "PERIOD" || b.datePrecision === "PERIOD") {
    const p = a.datePrecision === "PERIOD" ? a : b;
    const o = p === a ? b : a;
    const oStart = o.datePrecision === "PERIOD" ? o.periodStart : o.date;
    const oEnd = o.datePrecision === "PERIOD" ? o.periodEnd : o.date;
    return daysBetween(p.periodStart, oEnd) >= -PERIOD_SLACK_DAYS && daysBetween(oStart, p.periodEnd) >= -PERIOD_SLACK_DAYS;
  }
  const gap = Math.abs(daysBetween(a.date, b.date));
  if (isRollover(a, b)) return gap <= WINDOW_ROLLOVER_DAYS;
  if (a.role === "UNKNOWN" || b.role === "UNKNOWN") return gap <= WINDOW_UNKNOWN_DAYS;
  return gap <= WINDOW_DAYS;
}

function canPair(a: Leg, b: Leg, rejected: Set<string>): boolean {
  if (a.accountId === b.accountId) return false;
  if (a.role === "UNKNOWN" && b.role === "UNKNOWN") return false;
  if (Math.sign(a.amountCents) === Math.sign(b.amountCents)) return false;
  if (a.amountCents + b.amountCents !== 0) return false;
  if (!fits(a, b) || !fits(b, a)) return false;
  if (!withinWindow(a, b)) return false;
  return !rejected.has(legKey([a.id, b.id]));
}

export function matchTransfers(legsIn: Leg[], rejectedKeys: Iterable<string> = []): MatchResult {
  const rejected = new Set(rejectedKeys);
  const legs = legsIn.filter((l) => l.amountCents !== 0);
  const matched = new Set<string>();
  const matches: ProposedMatch[] = [];
  const ambiguous: string[][] = [];

  // ---- 1. One-to-one pairs, resolved per connected component ----
  const byAbs = new Map<number, Leg[]>();
  for (const l of legs) {
    const k = Math.abs(l.amountCents);
    byAbs.set(k, [...(byAbs.get(k) ?? []), l]);
  }
  for (const group of byAbs.values()) {
    if (group.length < 2) continue;
    const adj = new Map<string, Leg[]>();
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (!canPair(a, b, rejected)) continue;
        adj.set(a.id, [...(adj.get(a.id) ?? []), b]);
        adj.set(b.id, [...(adj.get(b.id) ?? []), a]);
      }
    }
    const seen = new Set<string>();
    for (const start of group) {
      if (seen.has(start.id) || !adj.has(start.id)) continue;
      const comp: Leg[] = [];
      const stack = [start];
      seen.add(start.id);
      while (stack.length) {
        const n = stack.pop()!;
        comp.push(n);
        for (const m of adj.get(n.id) ?? []) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            stack.push(m);
          }
        }
      }
      resolveComponent(comp, adj, matches, ambiguous, matched);
    }
  }

  // ---- 2. Aggregates: one undated period total = several dated legs ----
  const free = legs.filter((l) => !matched.has(l.id));
  for (const p of free.filter((l) => l.datePrecision === "PERIOD" && l.role === "TRANSFER")) {
    if (matched.has(p.id)) continue;
    const candidates = free.filter(
      (c) =>
        !matched.has(c.id) &&
        c.id !== p.id &&
        c.role === "TRANSFER" &&
        c.datePrecision === "EXACT" &&
        c.accountId !== p.accountId &&
        Math.sign(c.amountCents) === -Math.sign(p.amountCents) &&
        fits(p, c) &&
        fits(c, p) &&
        withinWindow(p, c),
    );
    if (candidates.length < 2 || candidates.length > MAX_AGGREGATE_CANDIDATES) continue;
    const target = -p.amountCents;
    const solutions: Leg[][] = [];
    const n = candidates.length;
    for (let mask = 1; mask < 1 << n && solutions.length < 2; mask++) {
      if ((mask & (mask - 1)) === 0) continue; // single legs were handled as pairs
      let sum = 0;
      const pick: Leg[] = [];
      for (let b = 0; b < n; b++) {
        if (mask & (1 << b)) {
          sum += candidates[b]!.amountCents;
          pick.push(candidates[b]!);
        }
      }
      if (sum === target && !rejected.has(legKey([p.id, ...pick.map((x) => x.id)]))) solutions.push(pick);
    }
    if (solutions.length === 1) {
      const ids = [p.id, ...solutions[0]!.map((x) => x.id)];
      ids.forEach((id) => matched.add(id));
      matches.push({ legIds: ids, method: "AGGREGATE" });
    } else if (solutions.length > 1) {
      ambiguous.push([p.id, ...candidates.map((c) => c.id)]);
    }
  }

  // ---- 3. Near misses, offered for confirmation only ----
  const suggestions: MatchResult["suggestions"] = [];
  const leftover = legs.filter((l) => !matched.has(l.id) && l.role === "TRANSFER");
  for (let i = 0; i < leftover.length; i++) {
    for (let j = i + 1; j < leftover.length; j++) {
      const a = leftover[i]!;
      const b = leftover[j]!;
      if (a.accountId === b.accountId || Math.sign(a.amountCents) === Math.sign(b.amountCents)) continue;
      const diff = a.amountCents + b.amountCents;
      if (diff === 0) continue;
      const tolerance = Math.max(5_000, Math.round(Math.abs(a.amountCents) * 0.01));
      if (Math.abs(diff) > tolerance) continue;
      if (!fits(a, b) || !fits(b, a) || !withinWindow(a, b)) continue;
      if (rejected.has(legKey([a.id, b.id]))) continue;
      suggestions.push({ legIds: [a.id, b.id], differenceCents: diff });
    }
  }

  return { matches, ambiguous, suggestions };
}

/**
 * All legs in a component share one absolute amount. Pair only when forced: either
 * every leg has exactly one candidate, or outs and ins are equal in number and pairing
 * them in date order uses only valid edges (recurring same-amount transfers).
 */
function resolveComponent(
  comp: Leg[],
  adj: Map<string, Leg[]>,
  matches: ProposedMatch[],
  ambiguous: string[][],
  matched: Set<string>,
): void {
  if (comp.every((l) => (adj.get(l.id)?.length ?? 0) === 1)) {
    for (const l of comp) {
      const other = adj.get(l.id)![0]!;
      if (l.amountCents < 0 && !matched.has(l.id)) {
        matched.add(l.id);
        matched.add(other.id);
        matches.push({ legIds: [l.id, other.id], method: "EXACT_PAIR" });
      }
    }
    return;
  }
  const order = (a: Leg, b: Leg) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1);
  const outs = comp.filter((l) => l.amountCents < 0).sort(order);
  const ins = comp.filter((l) => l.amountCents > 0).sort(order);
  if (outs.length === ins.length) {
    const pairs = outs.map((o, i) => [o, ins[i]!] as const);
    const valid = pairs.every(([o, n]) => adj.get(o.id)!.some((x) => x.id === n.id));
    // Same-day ties would make the order arbitrary between different accounts.
    const tieFree = new Set(outs.map((o) => `${o.date}|${o.accountId}`)).size === outs.length &&
      new Set(ins.map((o) => `${o.date}|${o.accountId}`)).size === ins.length;
    if (valid && tieFree) {
      for (const [o, n] of pairs) {
        matched.add(o.id);
        matched.add(n.id);
        matches.push({ legIds: [o.id, n.id], method: "ORDERED_PAIR" });
      }
      return;
    }
  }
  ambiguous.push(comp.map((l) => l.id));
}
