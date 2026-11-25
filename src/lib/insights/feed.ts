import { cashFlowDerived } from "../book/derived/cashFlow.ts";
import { recordsDerived } from "../book/derived/netWorth.ts";
import { derivedTarget } from "../book/derived/types.ts";
import type { ProofRef } from "../book/proof/compose.ts";
import type { CalendarItem } from "../book/reports/moneyCalendar.ts";
import type { GoalProgress } from "../book/reports/goals.ts";
import type { NetWorthReport } from "../book/reports/netWorth.ts";
import type { HighlightSeg, NetWorthChange } from "../book/reports/netWorthChanges.ts";
import { latestClosed, monthStory } from "../book/reports/monthStory.ts";
import { netWorthRecords, provenRun, roundMark } from "../book/reports/records.ts";
import { sliceRange } from "../book/reports/cashFlowWindows.ts";
import type { SpendingReport } from "../book/reports/spending.ts";
import { formatDisplayDateFromYmd } from "../displayTime.ts";
import { usd0 } from "../formatMoney.ts";
import { buildInsights, proofTarget, type Seg } from "./cashFlow.ts";

/**
 * One ranked list of what's worth knowing across the app: what moved net worth, what changed
 * in spending, records, deadlines close by and goals. Every number in it is a figure another
 * page already shows, with that page's proof; nothing is worked out here but the order.
 */
/** Words, a figure with its proof, or text that only looks like a figure (a goal's name, a round number), saying what it is. */
export type FeedSeg = Seg | { text: string; notFigure: string };

export type FeedItem = {
  id: string;
  tone: "good" | "bad" | "warn" | "info";
  area: "NW" | "CF" | "CAL" | "GOAL";
  segs: FeedSeg[];
  /** What it says, as words: a dismissed item returns once this changes (a countdown to a date is left out, so a date drawing nearer is still the same item). */
  says: string;
  href: string;
  /** What orders the list: dollars at stake, times how soon or how unusual. */
  score: number;
};

export type FeedInputs = {
  today: string;
  spending: SpendingReport;
  netWorth: NetWorthReport;
  /** What changed, month by month, oldest first. */
  changes?: readonly NetWorthChange[];
  change: NetWorthChange | null;
  calendar: CalendarItem[];
  goals: GoalProgress[];
};

const fig = (text: string, proof: ProofRef): Seg => ({ text, proof });
const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** A sweep-proven month-end net worth. */
const balanceAt = (date: string, cents: number): ProofRef => ({ descriptor: { report: "net-worth", metric: "balance", date }, shownCents: cents });

/** The months a record counts as news: it was set in one of the latest this many. */
const FRESH = 3;

/** Records from proven months alone (reports/records.ts): highs, runs, best months, and the round marks either side. */
export function records(nw: NetWorthReport, changes: readonly NetWorthChange[] = []): FeedItem[] {
  const x = netWorthRecords(nw, changes);
  if (!x) return [];
  const run = provenRun(nw);
  const { last } = x;
  const derived = recordsDerived(nw, changes);
  const out: FeedItem[] = [];
  const push = (i: Omit<FeedItem, "area" | "href" | "says"> & { href?: string }) => out.push({ area: "NW", href: "/net-worth", says: segsText(i.segs), ...i });
  const before = run.slice(0, -1);
  const peak = before.reduce((m, p) => (p.cents > m.cents ? p : m), before[0]!);
  const streak = x.currentRise?.months ?? 0;
  if (last.cents > peak.cents) {
    push({
      id: `record-high:${last.end}`,
      tone: "good",
      segs: ["New high: net worth closed ", last.label, " at ", fig(usd0(last.cents), balanceAt(last.end, last.cents)), streak >= 3 ? `, up ${streak} months running.` : "."],
      score: 6_000_00 + streak * 1_000_00,
    });
  } else if (peak.cents > 0 && last.cents < peak.cents * 0.97) {
    push({
      id: `below-high:${last.end}`,
      tone: "info",
      segs: ["Net worth is below its high of ", fig(usd0(peak.cents), balanceAt(peak.end, peak.cents)), ` (${peak.label}).`],
      score: 4_000_00,
    });
  }
  // The longest rise there has been, while it's still going and there was an earlier one to beat.
  if (x.currentRise && x.longestRise === x.currentRise && streak >= 4 && x.currentRise.from !== run[0])
    push({
      id: `record-rise:${x.currentRise.from.end}`,
      tone: "good",
      segs: ["The longest run of rising months on file: ", fig(String(streak), derivedTarget("net-worth", derived, "record-rise")), ` in a row, since ${x.currentRise.from.label}.`],
      score: 4_500_00 + streak * 500_00,
    });
  const fresh = (end: string) => run.findIndex((p) => p.end === end) >= run.length - FRESH;
  // A best month is news among a year of them, and only while it's recent.
  const best = (id: string, words: string, c: NetWorthChange | null, cents: number, proof: ProofRef | null) => {
    if (!c || !proof || run.length < 12 || !fresh(c.end)) return;
    push({ id: `${id}:${c.start}`, tone: "good", segs: [`${words}: ${c.label}, `, fig(usd0(cents), proof), "."], href: "/net-worth?tab=changes", score: 5_500_00 });
  };
  best("record-saved", "The most saved in a month", x.bestSaved, x.bestSaved?.savedCents ?? 0, x.bestSaved && { descriptor: x.bestSaved.proofs.saved, shownCents: x.bestSaved.savedCents });
  best("record-markets", "The best month for markets", x.bestMarkets, x.bestMarkets?.marketsCents ?? 0, x.bestMarkets && { descriptor: x.bestMarkets.proofs.markets, shownCents: x.bestMarkets.marketsCents });
  const round = (cents: number): FeedSeg => ({ text: roundMark(cents), notFigure: "a round number, not a figure of yours" });
  // The largest round mark crossed in the latest month-ends.
  const at = x.passed?.at;
  if (x.passed && at && fresh(at.end))
    push({ id: `mark:${x.passed.markCents}`, tone: "good", segs: ["Passed ", round(x.passed.markCents), ` in ${at.label}, closing at `, fig(usd0(at.cents), balanceAt(at.end, at.cents)), "."], score: 5_000_00 });
  if (x.next)
    push({
      id: `next-mark:${x.next.markCents}`,
      tone: "info",
      segs: ["Next milestone: ", round(x.next.markCents), ", ", fig(usd0(x.next.gapCents), derivedTarget("net-worth", derived, "record-next")), " to go."],
      score: 1_500_00,
    });
  return out;
}

/** One of What changed's sentences, each number in it a figure with its proof. */
export const highlightSegs = (h: HighlightSeg[]): FeedSeg[] =>
  h.map((s): FeedSeg => (typeof s === "string" ? s : { text: s.text, proof: { descriptor: s.descriptor, shownCents: s.cents ?? null, ...(s.ratio != null ? { shown: { ratio: s.ratio } } : {}) } }));

/** A sentence as plain words. */
export const segsText = (segs: readonly FeedSeg[]) => segs.map((s) => (typeof s === "string" ? s : s.text)).join("");

export function buildFeed(x: FeedInputs, limit = 12): FeedItem[] {
  const items: FeedItem[] = [...records(x.netWorth, x.changes)];
  if (x.change)
    x.change.highlights.slice(0, 1).forEach((h, i) =>
      items.push({
        id: `change:${x.change!.start}:${i}`,
        tone: x.change!.changeCents >= 0 ? "good" : "warn",
        area: "NW",
        segs: highlightSegs(h),
        says: segsText(highlightSegs(h)),
        href: "/net-worth?tab=changes",
        score: 8_000_00 + Math.min(4_000_00, Math.abs(x.change!.changeCents) / 100),
      }),
    );
  // A month just proven: what stood out in it (its story's last line), while it's news.
  const closed = x.changes ? latestClosed(x.changes) : null;
  if (closed && daysBetween(closed.end, x.today) <= 45) {
    const story = monthStory(closed);
    const segs = [`${closed.label} is proven. `, ...highlightSegs(story.sentences.at(-1)!)];
    items.push({ id: `month-closed:${closed.start}`, tone: "info", area: "NW", segs, says: segsText(segs), href: "/net-worth?tab=changes", score: 7_000_00 });
  }
  const slice = sliceRange(x.spending, "12m", { from: "", to: "" });
  if (slice.months.length) {
    const derived = cashFlowDerived(x.spending);
    const insights = buildInsights(slice, x.spending, {
      proof: (metric, months, o) => proofTarget(metric, months, undefined, o),
      dp: (figure, key) => derivedTarget("cash-flow", derived, figure, key),
    });
    for (const i of insights) {
      // Context and "nothing changed" stay on the Cash flow page.
      if (i.rank > 1) continue;
      items.push({
        id: `cf:${i.key}`,
        tone: i.tone,
        area: "CF",
        segs: [...i.title, ". ", ...i.body],
        says: segsText([...i.title, ". ", ...i.body]),
        href: `/cash-flow${i.action?.tab ? `?tab=${i.action.tab}` : ""}`,
        score: (i.rank === 0 ? 5_000_00 : 2_000_00) + Math.min(4_000_00, i.weight / 10),
      });
    }
  }
  for (const c of x.calendar) {
    const left = daysBetween(x.today, c.date);
    if (c.done || left < 0 || left > 60 || !c.cents) continue;
    const proof: ProofRef = c.proof ? { descriptor: c.proof, shownCents: c.cents } : { descriptor: { report: "derived", page: "calendar", figure: "item", key: c.id }, shownCents: c.cents };
    items.push({
      id: `due:${c.id}`,
      tone: left <= 14 ? "warn" : "info",
      area: "CAL",
      segs: [`${c.title}: `, fig(usd0(Math.abs(c.cents)), proof), c.perPaycheck ? " a paycheck" : "", left === 0 ? ", now." : `, due ${formatDisplayDateFromYmd(c.date)} (${left} day${left === 1 ? "" : "s"}).`],
      says: `${c.title}: ${usd0(Math.abs(c.cents))}${c.perPaycheck ? " a paycheck" : ""}, due ${c.date}`,
      href: "/calendar",
      score: 3_000_00 + Math.min(4_000_00, Math.abs(c.cents) / 20) + (60 - left) * 50_00,
    });
  }
  for (const g of x.goals) {
    if (g.status !== "BEHIND" && g.status !== "NO_PACE" && g.status !== "REACHED") continue;
    const cur: ProofRef = { descriptor: { report: "planning", page: "goals", figure: "current", goalId: g.goal.id }, shownCents: g.currentCents };
    items.push({
      id: `goal:${g.goal.id}:${g.status}`,
      tone: g.status === "REACHED" ? "good" : "warn",
      area: "GOAL",
      segs: [
        { text: g.goal.name, notFigure: "the goal's name, as you typed it" },
        g.status === "REACHED" ? " is funded, at " : g.status === "BEHIND" ? " is behind its date, at " : " isn't reached in the forecast, at ",
        fig(usd0(g.currentCents), cur),
        ".",
      ],
      says: `${g.goal.name}: ${g.status}, ${usd0(g.currentCents)}`,
      href: "/goals",
      score: g.status === "REACHED" ? 1_000_00 : 4_500_00,
    });
  }
  const seen = new Set<string>();
  return items
    .filter((i) => !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
