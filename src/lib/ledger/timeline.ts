import { addDays, dayNumber, fromDayNumber } from "../dates/isoDate.ts";
import type { Lane } from "../classifier/taxonomy.ts";

/**
 * The timeline engine: turns statements that each cover their own window (Chase cycles
 * on the 26th, Amex Gold on the 21st, Blue on the 11th, Fidelity monthly, 401(k)s
 * quarterly) into account values and flows for ANY calendar period.
 *
 * Every committed statement is a *segment* of an account's history: an opening and
 * closing balance with dated flows (and, for investments, market change and fees)
 * between them. Asking "what was this account worth on Mar 31" or "what went in and
 * what grew during Q1" is answered from the segments that overlap:
 *
 *  - Inside a bank/card segment the answer is exact to the day (opening + dated rows).
 *  - Inside an investment segment, market change and undated (quarterly) flows are
 *    spread evenly across the segment's days — exact at statement boundaries, an
 *    estimate in between, and labelled as such.
 *  - In a gap between statements the value is interpolated and labelled; if a year-end
 *    summary covers the gap, the gap's activity is derived from it (summary minus the
 *    statements around it) instead.
 *  - After the last statement the last balance carries forward, labelled stale (unless
 *    the account closed at zero).
 *
 * Decomposition of any period always satisfies, per account and in total:
 *     opening + contributions + growth + fees + unexplained = closing
 * with "unexplained" non-zero only where coverage is missing — never hidden.
 */

export type Quality =
  /** Exact from statements. */
  | "EXACT"
  /** Inside an investment statement: growth/undated flows spread across days. */
  | "ESTIMATED"
  /** From a year-end summary minus the statements around it. */
  | "DERIVED"
  /** Between statements with no data: interpolated. */
  | "INTERPOLATED"
  /** After the latest statement: last balance carried forward. */
  | "STALE"
  /** Before the account's first statement, with a nonzero opening: unknown. */
  | "UNKNOWN";

const QUALITY_RANK: Record<Quality, number> = {
  EXACT: 0,
  ESTIMATED: 1,
  DERIVED: 2,
  STALE: 3,
  INTERPOLATED: 4,
  UNKNOWN: 5,
};

export function worstQuality(qs: Quality[]): Quality {
  return qs.reduce<Quality>((w, q) => (QUALITY_RANK[q] > QUALITY_RANK[w] ? q : w), "EXACT");
}

export type FlowInput = {
  /** YYYY-MM-DD */
  date: string;
  precision: "EXACT" | "PERIOD";
  amountCents: number;
  lane: Lane;
  /** The ledger row it was read from, so a balance can list what made it. */
  id?: string;
};

export type SegmentInput = {
  accountId: string;
  /** The statement (StatementImport) it was read from. */
  importId?: string;
  periodStart: string;
  periodEnd: string;
  openingCents: number;
  closingCents: number;
  growthCents: number;
  feesCents: number;
  flows: FlowInput[];
};

export type Segment = {
  /** The statement behind it: its own, the summary a derived segment came from, or null for an idle window. */
  importId: string | null;
  start: number;
  end: number;
  days: number;
  opening: number;
  closing: number;
  growth: number;
  fees: number;
  derived: boolean;
  /**
   * No statement exists because the issuer sends none for a cycle without activity,
   * proven from the bank side (see book/idleCards.ts): $0, once any balance carried in
   * from the last statement is paid off (the only flows).
   */
  idle: boolean;
  /** Exact flows sorted by (clamped) day. */
  exact: { day: number; amount: number; lane: Lane; id?: string }[];
  /** Undated flows spread over the segment. */
  spread: { amount: number; lane: Lane; id?: string }[];
};

export type AccountTimeline = {
  accountId: string;
  segments: Segment[];
  /** First and last covered day, as YYYY-MM-DD. */
  firstDay: string | null;
  lastDay: string | null;
};

export type ValueAt = { cents: number; quality: Quality; asOf: string | null };

export type FlowTotals = Partial<Record<Lane, number>>;

export type Decomposition = {
  openingCents: number;
  closingCents: number;
  flowsByLane: FlowTotals;
  /** The inflow part of each lane's total (outflows = flowsByLane − inflowsByLane). */
  inflowsByLane: FlowTotals;
  /** Σ flowsByLane — everything that moved money in/out of the account. */
  contributionsCents: number;
  growthCents: number;
  feesCents: number;
  /** Change no statement explains (coverage gaps). */
  unexplainedCents: number;
  quality: Quality;
};

function toSegment(s: SegmentInput, derived: boolean): Segment {
  const start = dayNumber(s.periodStart);
  const end = dayNumber(s.periodEnd);
  const exact: Segment["exact"] = [];
  const spread: Segment["spread"] = [];
  for (const f of s.flows) {
    const id = f.id ? { id: f.id } : {};
    if (f.precision === "PERIOD") spread.push({ amount: f.amountCents, lane: f.lane, ...id });
    else exact.push({ day: Math.min(end, Math.max(start, dayNumber(f.date))), amount: f.amountCents, lane: f.lane, ...id });
  }
  exact.sort((a, b) => a.day - b.day);
  return {
    importId: s.importId ?? null,
    start,
    end,
    days: end - start + 1,
    opening: s.openingCents,
    closing: s.closingCents,
    growth: s.growthCents,
    fees: s.feesCents,
    derived,
    idle: false,
    exact,
    spread,
  };
}

/**
 * Builds an account's timeline from its committed statements, using summaries (e.g. a
 * year-end report) only to fill gaps they fully cover.
 */
export function buildTimeline(accountId: string, statements: SegmentInput[], summaries: SegmentInput[] = []): AccountTimeline {
  const segs = statements.map((s) => toSegment(s, false)).sort((a, b) => a.start - b.start);
  const derived: Segment[] = [];
  for (const sum of summaries) {
    const S = toSegment(sum, true);
    // Uncovered windows inside the summary's period.
    const inside = segs.filter((g) => g.start >= S.start && g.end <= S.end);
    let cursor = S.start;
    const holes: [number, number][] = [];
    for (const g of inside) {
      if (g.start > cursor) holes.push([cursor, g.start - 1]);
      cursor = Math.max(cursor, g.end + 1);
    }
    if (cursor <= S.end) holes.push([cursor, S.end]);
    // Before an account opened (summary and first statement both start at zero) there
    // is nothing to derive.
    if (holes.length > 1 && holes[0]![0] === S.start && S.opening === 0 && inside[0]?.opening === 0) holes.shift();
    // Only a single hole can be derived exactly (summary − everything else).
    if (holes.length !== 1) continue;
    const [hs, he] = holes[0]!;
    if (segs.some((g) => g.start <= he && g.end >= hs)) continue; // partially covered by a straddling statement
    const before = [...segs].reverse().find((g) => g.end === hs - 1);
    const after = segs.find((g) => g.start === he + 1);
    const opening = hs === S.start ? S.opening : before?.closing;
    const closing = he === S.end ? S.closing : after?.opening;
    if (opening == null || closing == null) continue;
    const sumIn = (pick: (g: Segment) => number) => inside.reduce((a, g) => a + pick(g), 0);
    const lanes = new Map<Lane, number>();
    for (const f of [...S.exact, ...S.spread]) lanes.set(f.lane, (lanes.get(f.lane) ?? 0) + f.amount);
    for (const g of inside) for (const f of [...g.exact, ...g.spread]) lanes.set(f.lane, (lanes.get(f.lane) ?? 0) - f.amount);
    const growth = S.growth - sumIn((g) => g.growth);
    const fees = S.fees - sumIn((g) => g.fees);
    const flows = [...lanes.values()].reduce((a, b) => a + b, 0);
    // Whatever the summary's own figures leave unexplained is market change.
    const adjustedGrowth = growth + (closing - opening - flows - growth - fees);
    derived.push({
      importId: S.importId,
      start: hs,
      end: he,
      days: he - hs + 1,
      opening,
      closing,
      growth: adjustedGrowth,
      fees,
      derived: true,
      idle: false,
      exact: [],
      spread: [...lanes].filter(([, v]) => v !== 0).map(([lane, amount]) => ({ lane, amount })),
    });
  }
  const all = [...segs, ...derived].sort((a, b) => a.start - b.start);
  return {
    accountId,
    segments: all,
    firstDay: all.length ? fromDayNumber(all[0]!.start) : null,
    lastDay: all.length ? fromDayNumber(all.at(-1)!.end) : null,
  };
}

/**
 * The timeline with proven idle windows filled by segments that end at $0 (no growth),
 * so every later question (value on a day, decomposition, coverage) treats them as
 * covered. A window may open with a balance carried in from the last statement, paid off
 * inside it by the bank payments in `payoff` (bank-side amounts; the card receives the
 * opposite). A window overlapping any existing segment is ignored.
 */
export function withIdleWindows(
  t: AccountTimeline,
  windows: { from: string; to: string; openingCents?: number; payoff?: { date: string; amountCents: number }[] }[],
): AccountTimeline {
  if (windows.length === 0) return t;
  const segs = [...t.segments];
  for (const w of windows) {
    const start = dayNumber(w.from);
    const end = dayNumber(w.to);
    if (end < start || segs.some((s) => s.start <= end && s.end >= start)) continue;
    const exact = (w.payoff ?? [])
      .map((p) => ({ day: Math.min(end, Math.max(start, dayNumber(p.date))), amount: -p.amountCents, lane: "TRANSFER" as Lane }))
      .sort((a, b) => a.day - b.day);
    const opening = w.openingCents ?? 0;
    const closing = opening + exact.reduce((s, f) => s + f.amount, 0);
    segs.push({ importId: null, start, end, days: end - start + 1, opening, closing, growth: 0, fees: 0, derived: false, idle: true, exact, spread: [] });
  }
  segs.sort((a, b) => a.start - b.start);
  return {
    accountId: t.accountId,
    segments: segs,
    firstDay: segs.length ? fromDayNumber(segs[0]!.start) : null,
    lastDay: segs.length ? fromDayNumber(segs.at(-1)!.end) : null,
  };
}

function segmentQuality(s: Segment, day: number): Quality {
  if (s.derived) return day === s.end ? "EXACT" : "DERIVED";
  if (day === s.end) return "EXACT";
  return s.growth !== 0 || s.fees !== 0 || s.spread.length > 0 ? "ESTIMATED" : "EXACT";
}

/** End-of-day value inside a segment. */
function valueInSegment(s: Segment, day: number): number {
  if (day >= s.end) return s.closing;
  const frac = (day - s.start + 1) / s.days;
  let v = s.opening;
  for (const f of s.exact) if (f.day <= day) v += f.amount;
  for (const f of s.spread) v += f.amount * frac;
  v += (s.growth + s.fees) * frac;
  return Math.round(v);
}

export function valueAt(t: AccountTimeline, iso: string): ValueAt {
  const day = dayNumber(iso);
  const segs = t.segments;
  if (segs.length === 0) return { cents: 0, quality: "UNKNOWN", asOf: null };
  const inSeg = segs.find((s) => s.start <= day && day <= s.end);
  if (inSeg) return { cents: valueInSegment(inSeg, day), quality: segmentQuality(inSeg, day), asOf: iso };
  const first = segs[0]!;
  if (day < first.start) {
    return first.opening === 0
      ? { cents: 0, quality: "EXACT", asOf: iso }
      : { cents: first.opening, quality: "UNKNOWN", asOf: fromDayNumber(first.start - 1) };
  }
  const last = segs.at(-1)!;
  if (day > last.end) {
    return last.closing === 0
      ? { cents: 0, quality: "EXACT", asOf: iso }
      : { cents: last.closing, quality: "STALE", asOf: fromDayNumber(last.end) };
  }
  // In a gap: interpolate between the surrounding statements.
  const prev = [...segs].reverse().find((s) => s.end < day)!;
  const next = segs.find((s) => s.start > day)!;
  if (prev.closing === next.opening) return { cents: prev.closing, quality: "INTERPOLATED", asOf: fromDayNumber(prev.end) };
  // End of the gap's last day equals the next statement's opening balance.
  const frac = (day - prev.end) / (next.start - 1 - prev.end);
  return {
    cents: Math.round(prev.closing + (next.opening - prev.closing) * frac),
    quality: "INTERPOLATED",
    asOf: fromDayNumber(prev.end),
  };
}

/** What happened to one account over [from, to] (inclusive calendar days). */
export function decompose(t: AccountTimeline, from: string, to: string): Decomposition {
  const a = dayNumber(from);
  const b = dayNumber(to);
  const open = valueAt(t, addDays(from, -1));
  const close = valueAt(t, to);
  const flowsByLane: FlowTotals = {};
  const inflowsByLane: FlowTotals = {};
  const add = (lane: Lane, v: number) => {
    flowsByLane[lane] = (flowsByLane[lane] ?? 0) + v;
    if (v > 0) inflowsByLane[lane] = (inflowsByLane[lane] ?? 0) + v;
  };
  let growth = 0;
  let fees = 0;
  const qualities: Quality[] = [open.quality === "UNKNOWN" ? "UNKNOWN" : "EXACT", close.quality];
  let covered = 0;
  for (const s of t.segments) {
    const lo = Math.max(a, s.start);
    const hi = Math.min(b, s.end);
    if (lo > hi) continue;
    covered += hi - lo + 1;
    const frac = (hi - lo + 1) / s.days;
    for (const f of s.exact) {
      if (f.day >= lo && f.day <= hi) add(f.lane, f.amount);
    }
    for (const f of s.spread) add(f.lane, f.amount * frac);
    growth += s.growth * frac;
    fees += s.fees * frac;
    if (frac < 1 && (s.spread.length > 0 || s.growth !== 0 || s.fees !== 0)) qualities.push(s.derived ? "DERIVED" : "ESTIMATED");
    else if (s.derived) qualities.push("DERIVED");
  }
  // Round once at the end so the identity holds to the cent.
  for (const k of Object.keys(flowsByLane) as Lane[]) flowsByLane[k] = Math.round(flowsByLane[k]!);
  for (const k of Object.keys(inflowsByLane) as Lane[]) inflowsByLane[k] = Math.round(inflowsByLane[k]!);
  growth = Math.round(growth);
  fees = Math.round(fees);
  const contributions = Object.values(flowsByLane).reduce((x, y) => x + (y ?? 0), 0);
  let unexplained = close.cents - open.cents - contributions - growth - fees;
  // Sub-cent rounding inside fully covered spans lands in growth, not "unexplained".
  const span = b - a + 1;
  const firstDay = t.segments[0]?.start ?? Infinity;
  const lastDay = t.segments.at(-1)?.end ?? -Infinity;
  const activeSpan = Math.max(0, Math.min(b, lastDay) - Math.max(a, firstDay) + 1);
  if (covered >= activeSpan && Math.abs(unexplained) <= 2) {
    growth += unexplained;
    unexplained = 0;
  }
  if (covered < activeSpan && span > 0) qualities.push("INTERPOLATED");
  return {
    openingCents: open.cents,
    closingCents: close.cents,
    flowsByLane,
    inflowsByLane,
    contributionsCents: contributions,
    growthCents: growth,
    feesCents: fees,
    unexplainedCents: unexplained,
    quality: worstQuality(qualities),
  };
}

export type CoverageGap = { from: string; to: string; kind: "MISSING" | "DERIVED" };

/** Uncovered windows between an account's first and last statement. */
export function coverageGaps(t: AccountTimeline): CoverageGap[] {
  const out: CoverageGap[] = [];
  for (let i = 1; i < t.segments.length; i++) {
    const prev = t.segments[i - 1]!;
    const cur = t.segments[i]!;
    if (cur.derived) out.push({ from: fromDayNumber(cur.start), to: fromDayNumber(cur.end), kind: "DERIVED" });
    if (cur.start > prev.end + 1) out.push({ from: fromDayNumber(prev.end + 1), to: fromDayNumber(cur.start - 1), kind: "MISSING" });
  }
  return out;
}

/** Statements that are contiguous but don't chain (opening ≠ prior closing). */
export function chainBreaks(t: AccountTimeline): { at: string; priorClosingCents: number; openingCents: number }[] {
  const out = [];
  for (let i = 1; i < t.segments.length; i++) {
    const prev = t.segments[i - 1]!;
    const cur = t.segments[i]!;
    if (cur.start === prev.end + 1 && cur.opening !== prev.closing) {
      out.push({ at: fromDayNumber(cur.start), priorClosingCents: prev.closing, openingCents: cur.opening });
    }
  }
  return out;
}

/**
 * Modified Dietz return over [from, to]: market change divided by average capital,
 * weighting each dated flow by the share of the period it was invested. Undated
 * (quarterly) flows count as mid-period. Growth is net of fees.
 */
export function modifiedDietz(t: AccountTimeline, from: string, to: string): number | null {
  const { gainCents, capitalCents } = dietzParts(t, from, to);
  return capitalCents > 0 ? gainCents / capitalCents : null;
}

/**
 * Numerator and denominator of the Modified Dietz return, so several accounts can be
 * combined into one portfolio return (transfers between them cancel in the capital).
 */
export function dietzParts(t: AccountTimeline, from: string, to: string): { gainCents: number; capitalCents: number } {
  const d = decompose(t, from, to);
  const a = dayNumber(from);
  const b = dayNumber(to);
  const span = b - a + 1;
  let weighted = 0;
  for (const s of t.segments) {
    const lo = Math.max(a, s.start);
    const hi = Math.min(b, s.end);
    if (lo > hi) continue;
    for (const f of s.exact) if (f.day >= lo && f.day <= hi) weighted += f.amount * ((b - f.day) / span);
    const frac = (hi - lo + 1) / s.days;
    const mid = (lo + hi) / 2;
    for (const f of s.spread) weighted += f.amount * frac * ((b - mid) / span);
  }
  return { gainCents: d.growthCents + d.feesCents, capitalCents: d.openingCents + weighted };
}

/**
 * Chain-links period returns into a total, annualized only over a year or more (a
 * shorter return scaled up to a year mostly reflects noise).
 */
export function chainReturns(periodReturns: { r: number; days: number }[]): { total: number; annualized: number | null } {
  let growth = 1;
  let days = 0;
  for (const p of periodReturns) {
    growth *= 1 + p.r;
    days += p.days;
  }
  return { total: growth - 1, annualized: days >= 365 ? growth ** (365 / days) - 1 : null };
}

/**
 * Below this average invested capital a period's return is dominated by rounding,
 * bonuses and timing rather than performance, so it's left out of chained returns.
 */
export const MIN_RETURN_CAPITAL_CENTS = 100_000;

/**
 * The timeline from `from` on, as if the account were first on file that day (a partner's
 * own account joining the household at the merge). Statements ending before it drop out;
 * the one holding it is cut there: it opens with the value that morning and keeps its
 * dated flows from then on and its undated flows and fees for the days left, with market
 * change taking the rounding so it still adds up to its closing balance. A cut statement
 * with anything spread over it is an estimate on its first day, as any day inside it is.
 */
export function clipTimeline(t: AccountTimeline, from: string): AccountTimeline {
  if (!t.firstDay || from <= t.firstDay) return t;
  const day = dayNumber(from);
  const segments = t.segments.flatMap((s): Segment[] => {
    if (s.end < day) return [];
    if (s.start >= day) return [s];
    const frac = (s.end - day + 1) / s.days;
    const opening = valueInSegment(s, day - 1);
    const exact = s.exact.filter((f) => f.day >= day);
    const spread = s.spread.map((f) => ({ ...f, amount: f.amount * frac }));
    const fees = s.fees * frac;
    const moved = exact.reduce((v, f) => v + f.amount, 0) + spread.reduce((v, f) => v + f.amount, 0) + fees;
    const estimated = s.spread.length > 0 || s.growth !== 0 || s.fees !== 0;
    return [{ ...s, start: day, days: s.end - day + 1, opening, exact, spread, fees, growth: s.closing - opening - moved, derived: s.derived || estimated }];
  });
  if (!segments.length) return { ...t, segments, firstDay: null, lastDay: null };
  return { ...t, segments, firstDay: fromDayNumber(segments[0]!.start) };
}
