import { cashFlowDerived } from "../book/derived/cashFlow.ts";
import { derivedTarget } from "../book/derived/types.ts";
import type { ProofRef } from "../book/proof/compose.ts";
import type { CalendarItem } from "../book/reports/moneyCalendar.ts";
import type { GoalProgress } from "../book/reports/goals.ts";
import type { NetWorthReport } from "../book/reports/netWorth.ts";
import type { NetWorthChange } from "../book/reports/netWorthChanges.ts";
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
  href: string;
  /** What orders the list: dollars at stake, times how soon or how unusual. */
  score: number;
};

export type FeedInputs = {
  today: string;
  spending: SpendingReport;
  netWorth: NetWorthReport;
  change: NetWorthChange | null;
  calendar: CalendarItem[];
  goals: GoalProgress[];
};

const fig = (text: string, proof: ProofRef): Seg => ({ text, proof });
const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** A sweep-proven month-end net worth. */
const balanceAt = (date: string, cents: number): ProofRef => ({ descriptor: { report: "net-worth", metric: "balance", date }, shownCents: cents });

/** Month-ends that can be proven, oldest first, up to the first gap from the latest back. */
function provenRun(nw: NetWorthReport) {
  const out: { end: string; label: string; cents: number }[] = [];
  for (const p of [...nw.periods].reverse()) {
    if (p.blockers.length) break;
    out.unshift({ end: p.end, label: p.label, cents: p.household.closingCents });
  }
  return out;
}

/** A round mark in words: "$1.5 million", "$900,000". */
const roundMark = (cents: number) => (cents >= 1_000_000_00 ? `$${(cents / 1_000_000_00).toLocaleString("en-US", { maximumFractionDigits: 1 })} million` : usd0(cents));

/** High-water marks and round numbers passed, from proven month-ends alone. */
export function records(nw: NetWorthReport): FeedItem[] {
  const run = provenRun(nw);
  const last = run.at(-1);
  if (!last || run.length < 3) return [];
  const out: FeedItem[] = [];
  const before = run.slice(0, -1);
  const peak = before.reduce((m, p) => (p.cents > m.cents ? p : m), before[0]!);
  if (last.cents > peak.cents) {
    let streak = 0;
    for (let i = run.length - 1; i > 0 && run[i]!.cents > run[i - 1]!.cents; i--) streak++;
    out.push({
      id: `record-high:${last.end}`,
      tone: "good",
      area: "NW",
      segs: ["New high: net worth closed ", last.label, " at ", fig(usd0(last.cents), balanceAt(last.end, last.cents)), streak >= 3 ? `, up ${streak} months running.` : "."],
      href: "/net-worth",
      score: 6_000_00 + streak * 1_000_00,
    });
  } else if (peak.cents > 0 && last.cents < peak.cents * 0.97) {
    out.push({
      id: `below-high:${last.end}`,
      tone: "info",
      area: "NW",
      segs: ["Net worth is below its high of ", fig(usd0(peak.cents), balanceAt(peak.end, peak.cents)), ` (${peak.label}).`],
      href: "/net-worth",
      score: 4_000_00,
    });
  }
  // The largest round mark crossed in the last three month-ends.
  const step = last.cents >= 5_000_000_00 ? 1_000_000_00 : last.cents >= 1_000_000_00 ? 500_000_00 : 100_000_00;
  const mark = Math.floor(last.cents / step) * step;
  const crossed = mark > 0 ? run.findIndex((p) => p.cents >= mark) : -1;
  if (crossed > 0 && crossed >= run.length - 3)
    out.push({
      id: `mark:${mark}`,
      tone: "good",
      area: "NW",
      segs: ["Passed ", { text: roundMark(mark), notFigure: "a round number, not a figure of yours" }, ` in ${run[crossed]!.label}, closing at `, fig(usd0(run[crossed]!.cents), balanceAt(run[crossed]!.end, run[crossed]!.cents)), "."],
      href: "/net-worth",
      score: 5_000_00,
    });
  return out;
}

export function buildFeed(x: FeedInputs, limit = 12): FeedItem[] {
  const items: FeedItem[] = [...records(x.netWorth)];
  if (x.change)
    x.change.highlights.slice(0, 1).forEach((h, i) =>
      items.push({
        id: `change:${x.change!.start}:${i}`,
        tone: x.change!.changeCents >= 0 ? "good" : "warn",
        area: "NW",
        segs: h.map((s): Seg => (typeof s === "string" ? s : { text: s.text, proof: { descriptor: s.descriptor, shownCents: s.cents ?? null, ...(s.ratio != null ? { shown: { ratio: s.ratio } } : {}) } })),
        href: "/net-worth?tab=changes",
        score: 8_000_00 + Math.min(4_000_00, Math.abs(x.change!.changeCents) / 100),
      }),
    );
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
