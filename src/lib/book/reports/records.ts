import type { NetWorthReport } from "./netWorth.ts";
import type { NetWorthChange } from "./netWorthChanges.ts";

/**
 * The household's records, from proven months alone: the highest month-end, the longest
 * run of rising months, the best months for saving and for markets, and the round marks
 * either side of where net worth is now. Net worth › Overview draws them and the
 * Dashboard's feed names them; both read this, so neither can keep its own.
 *
 * Months are the unbroken proven run back from the latest one: a record across a gap would
 * compare months nothing connects.
 */

export type MonthEnd = { start: string; end: string; label: string; cents: number };

/** Month-ends that can be proven, oldest first, up to the first gap from the latest back. */
export function provenRun(nw: Pick<NetWorthReport, "periods">): MonthEnd[] {
  const out: MonthEnd[] = [];
  for (const p of [...nw.periods].reverse()) {
    if (p.blockers.length) break;
    out.unshift({ start: p.start, end: p.end, label: p.label, cents: p.household.closingCents });
  }
  return out;
}

/** A run of month-ends each above the one before: how many rises, from the month it rose from. */
export type Rise = { months: number; from: MonthEnd; to: MonthEnd };

/** Each unbroken run of rising month-ends, oldest first. */
export function risesOf(run: readonly MonthEnd[]): Rise[] {
  const out: Rise[] = [];
  let from = 0;
  for (let i = 1; i <= run.length; i++) {
    if (i < run.length && run[i]!.cents > run[i - 1]!.cents) continue;
    if (i - 1 > from) out.push({ months: i - 1 - from, from: run[from]!, to: run[i - 1]! });
    from = i;
  }
  return out;
}

/** The round step marks come in at this size of net worth. */
export const markStep = (cents: number) => (cents >= 5_000_000_00 ? 1_000_000_00 : cents >= 1_000_000_00 ? 500_000_00 : 100_000_00);

export type Records = {
  last: MonthEnd;
  /** The highest month-end of the run. */
  high: MonthEnd;
  /** The longest run of rising months (the latest, where two tie), and the one under way. */
  longestRise: Rise | null;
  currentRise: Rise | null;
  /** The month that saved the most, and the best one for markets: What changed's own months. */
  bestSaved: NetWorthChange | null;
  bestMarkets: NetWorthChange | null;
  /** The largest mark net worth is above, and the first month-end at or above it (null when the run began above it). */
  passed: { markCents: number; at: MonthEnd | null } | null;
  /** The next mark up, and how far net worth is from it. */
  next: { markCents: number; gapCents: number } | null;
};

/** Null under three proven months: nothing is a record yet. */
export function netWorthRecords(nw: Pick<NetWorthReport, "periods">, changes: readonly NetWorthChange[] = []): Records | null {
  const run = provenRun(nw);
  const last = run.at(-1);
  if (!last || run.length < 3) return null;
  const rises = risesOf(run);
  const longest = rises.reduce<Rise | null>((m, x) => (!m || x.months >= m.months ? x : m), null);
  const inRun = changes.filter((c) => c.start >= run[0]!.start && !c.through);
  // A month an account first appears in "saved" the balance it brought: never a record.
  const saving = inRun.filter((c) => !c.firstOnFileCents);
  const best = (pick: (c: NetWorthChange) => number, from = inRun) => from.reduce<NetWorthChange | null>((m, c) => (pick(c) > 0 && (!m || pick(c) > pick(m)) ? c : m), null);
  const step = markStep(last.cents);
  const mark = Math.floor(last.cents / step) * step;
  const crossed = mark > 0 ? run.findIndex((p) => p.cents >= mark) : -1;
  const nextMark = mark + step;
  return {
    last,
    high: run.reduce((m, p) => (p.cents > m.cents ? p : m), run[0]!),
    longestRise: longest,
    currentRise: rises.at(-1)?.to === last ? rises.at(-1)! : null,
    bestSaved: best((c) => c.savedCents, saving),
    bestMarkets: best((c) => c.marketsCents),
    passed: mark > 0 ? { markCents: mark, at: crossed > 0 ? run[crossed]! : null } : null,
    next: nextMark > 0 ? { markCents: nextMark, gapCents: nextMark - last.cents } : null,
  };
}

/** A round mark in words: "$1.5 million", "$900,000". */
export const roundMark = (cents: number) =>
  cents >= 1_000_000_00 ? `$${(cents / 1_000_000_00).toLocaleString("en-US", { maximumFractionDigits: 1 })} million` : `$${Math.round(cents / 100).toLocaleString("en-US")}`;
