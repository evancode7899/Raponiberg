import { calendarDerived } from "../book/derived/planning.ts";
import { builtDerived, changeStepKey, changeStepsDerived, changeTypicalDerived, netWorthDerived, typicalKey } from "../book/derived/netWorth.ts";
import { investmentsDerived, positionKey } from "../book/derived/investments.ts";
import { cellKey, derivedTarget } from "../book/derived/types.ts";
import type { Book } from "../book/load.ts";
import { unswept } from "../book/proof/clearance.ts";
import { compositeOf, sumOf, type ProofRef } from "../book/proof/compose.ts";
import type { ProofDescriptor } from "../book/proof/index.ts";
import type { BonusesReport } from "../book/reports/bonuses.ts";
import type { GoalsReport } from "../book/reports/goals.ts";
import type { InvestmentsReport } from "../book/reports/investments.ts";
import type { MoneyCalendarReport } from "../book/reports/moneyCalendar.ts";
import type { NetWorthReport } from "../book/reports/netWorth.ts";
import type { NetWorthChangesReport } from "../book/reports/netWorthChanges.ts";
import type { SpendingReport } from "../book/reports/spending.ts";
import type { FireSettings } from "../book/proof/planningProof.ts";
import { analyzeFire, fiLevers, firePlans, type FiLever } from "../fire/fire.ts";
import type { Forecast } from "../forecast/forecast.ts";
import { buildFeed, highlightSegs, type FeedItem, type FeedSeg } from "../insights/feed.ts";
import { classLabel } from "../investments/securities.ts";
import type { AnomaliesReport } from "../book/reports/anomalies.ts";
import type { AnnualProfileReport } from "../profile/buildAnnualProfile.ts";

/**
 * What the Dashboard's panels draw beyond its net worth and cash flow (homeSummary.ts): the
 * latest month's bridge, what's due, plans, the portfolio and the ranked feed. It composes
 * reports other pages are built from and works nothing out itself: every figure carries the
 * proof its own page uses, so the sweep that clears that page clears this one.
 */
export type BriefingInputs = {
  book: Pick<Book, "today">;
  changes: NetWorthChangesReport;
  netWorth: NetWorthReport;
  spending: SpendingReport;
  calendar: MoneyCalendarReport;
  bonuses: BonusesReport;
  goals: GoalsReport;
  investments: InvestmentsReport;
  returnRate: number;
  forecast: Forecast | null;
  profile: AnnualProfileReport;
  anomalies?: AnomaliesReport;
};

export type BriefingStep = { key: string; label: string; cents: number; fromCents: number; toCents: number; typicalCents: number | null; note: string; proof: ProofRef; typicalProof: ProofRef };
/** `dateOnly`: a date with no amount of its own (a policy's renewal): the amount stays blank. */
export type BriefingDue = { id: string; date: string; title: string; cents: number | null; kind: "save" | "tax" | "file" | "vest" | "credit" | "policy"; href: string; done: boolean; perPaycheck: boolean; dateOnly?: boolean; detail: string; proof: ProofRef };
export type BriefingGoal = { id: string; name: string; status: string; currentCents: number; targetCents: number | null; lands: string | null; blockers: GoalsReport["goals"][number]["blockers"]; currentProof: ProofRef; targetProof: ProofRef; landsProof: ProofRef };
export type BriefingHolding = { key: string; name: string; cents: number; accounts: string[]; gainCents: number | null; proof: ProofRef; gainProof: ProofRef };
/** The portfolio's time-weighted return: the latest month, a year, and since the proven stretch begins. */
export type BriefingReturns = { from: string; total: number; totalProof: ProofRef; annualized: number | null; annualizedProof: ProofRef; month: { label: string; ratio: number; proof: ProofRef } | null } | null;
export type Briefing = {
  today: string;
  change: {
    label: string;
    start: string;
    openingCents: number;
    closingCents: number;
    changeCents: number;
    proofs: { opening: ProofRef; closing: ProofRef; change: ProofRef };
    steps: BriefingStep[];
    /** Net worth › What changed's own sentences on the month, past the first (the feed's). */
    notes: FeedSeg[][];
  } | null;
  due: BriefingDue[];
  goals: BriefingGoal[];
  /** `levers`: the FIRE page's what-ifs (Levers), the FI year with one thing changed. */
  fire: { fiYear: number | null; fiProof: ProofRef; progress: number; progressProof: ProofRef; numberCents: number; numberProof: ProofRef; levers: FiLever[] } | null;
  portfolio: { asOf: string; totalCents: number; totalProof: ProofRef; blocked: boolean; classes: { cls: string; label: string; cents: number; share: number; proof: ProofRef; shareProof: ProofRef; driftCents: number | null; driftProof: ProofRef }[]; holdings: BriefingHolding[]; /** Whether a target allocation is set, so drift means something. */ hasTarget: boolean; returns: BriefingReturns };
  /** What happened in a month, flagged on the net worth chart: in words, never an amount. */
  events: { label: string; text: string }[];
  /** Each spending category's last twelve proven months, oldest first: a trend line's shape, never drawn as numbers. */
  trends: Record<string, number[]>;
  feed: FeedItem[];
};

const HOLDINGS = 8;
/** Feed items the briefing lists: more than the panel shows, so ones the owner dismissed leave room for the next. */
const FEED_LISTED = 40;

export function buildBriefing(x: BriefingInputs): Briefing {
  const derivedChange = [...changeStepsDerived(x.changes), ...changeTypicalDerived(x.changes)];
  const g = x.changes.granularity;
  const last = x.changes.periods.at(-1) ?? null;
  const ref = (descriptor: ProofDescriptor, shownCents: number | null): ProofRef => ({ descriptor, shownCents });

  const calDerived = calendarDerived(x.calendar);
  const due: BriefingDue[] = x.calendar.items.map((i) => ({
    id: i.id,
    date: i.date,
    title: i.title,
    cents: i.cents,
    kind: i.kind,
    href: i.href,
    done: i.done,
    perPaycheck: i.perPaycheck ?? false,
    detail: i.detail,
    proof: i.cents == null ? unswept("no amount") : i.proof ? ref(i.proof, i.cents) : derivedTarget("calendar", calDerived, "item", i.id),
  }));
  for (const w of x.bonuses.windows) {
    if (w.to < x.book.today || w.blockers.length || w.scheduledCents <= w.paidCents) continue;
    due.push({
      id: `vest:${w.key}`,
      date: w.to,
      title: `Vests: ${w.label}`,
      cents: w.scheduledCents,
      kind: "vest",
      href: "/bonuses?tab=schedule",
      done: false,
      perPaycheck: false,
      detail: w.detail,
      proof: ref({ report: "bonuses", figure: "window", window: w.key, measure: "scheduled" }, w.scheduledCents),
    });
  }
  due.sort((a, b) => Number(a.done) - Number(b.done) || a.date.localeCompare(b.date));

  const inv = x.investments;
  const invDerived = investmentsDerived(inv, x.returnRate);
  // The same security across accounts is one line (the Investments page's concentration list), largest first.
  // Its gain adds its positions' gains, and shows only where every one of them prints a cost.
  const holdings: BriefingHolding[] = inv.concentration.slice(0, HOLDINGS).map((k) => {
    const lots = inv.positions.filter((p) => p.key === k.key);
    const gain = lots.length && lots.every((p) => p.unrealizedCents != null) ? lots.reduce((s, p) => s + p.unrealizedCents!, 0) : null;
    return {
      key: k.key,
      name: k.symbol ?? k.name,
      cents: k.cents,
      accounts: k.accounts,
      gainCents: gain,
      proof: derivedTarget("investments", invDerived, "concentration", k.key),
      gainProof: gain == null ? unswept("a position's cost isn't printed") : sumOf(lots.map((p) => derivedTarget("investments", invDerived, "position", positionKey(p, "gain"))), gain),
    };
  });
  const driftOf = new Map((inv.drift ?? []).map((d) => [d.cls as string, d.deltaCents]));

  const classProof = (cls: string) => derivedTarget("investments", invDerived, "class", cls);
  const everyClass = sumOf(inv.allocation.map((a) => classProof(a.cls)), inv.allocation.reduce((s, a) => s + a.cents, 0));

  const months = x.spending.months.slice(-12);
  const trends: Briefing["trends"] = {};
  for (const c of new Set(months.flatMap((m) => m.spendingByCategory.map((y) => y.category)))) trends[c] = months.map((m) => m.spendingByCategory.find((y) => y.category === c)?.cents ?? 0);

  return {
    today: x.book.today,
    change: last && {
      label: last.label,
      start: last.start,
      openingCents: last.openingCents,
      closingCents: last.closingCents,
      changeCents: last.changeCents,
      proofs: { opening: ref(last.proofs.opening, last.openingCents), closing: ref(last.proofs.closing, last.closingCents), change: ref(last.proofs.change, last.changeCents) },
      notes: last.highlights.slice(1).map(highlightSegs),
      steps: last.steps.map((s) => {
        // Spending's own proof states what was spent; the bridge draws what it did to net worth.
        const spending = s.key === "spending";
        return {
          key: s.key,
          label: s.label,
          cents: spending ? last.spendingCents : s.cents,
          fromCents: s.fromCents,
          toCents: s.toCents,
          typicalCents: s.typicalCents == null ? null : spending ? -s.typicalCents : s.typicalCents,
          note: s.note,
          proof: s.proof ? ref(s.proof, spending ? last.spendingCents : s.cents) : derivedTarget("net-worth", derivedChange, "change-step", changeStepKey(g, last.start, s.key)),
          typicalProof: s.typicalCents == null ? unswept("nothing before it to average") : derivedTarget("net-worth", derivedChange, "change-typical", typicalKey(g, last.start, spending ? "spending" : `step:${s.key}`)),
        };
      }),
    },
    due,
    goals: x.goals.goals.map((p) => {
      const goal = (figure: "current" | "target" | "lands", shownCents: number | null): ProofRef => ref({ report: "planning", page: "goals", figure, goalId: p.goal.id }, shownCents);
      return {
        id: p.goal.id,
        name: p.goal.name,
        status: p.status,
        currentCents: p.currentCents,
        targetCents: p.targetCents,
        lands: p.projectedDate,
        blockers: p.blockers,
        currentProof: goal("current", p.currentCents),
        targetProof: p.targetCents == null ? unswept("no target set") : goal("target", p.targetCents),
        landsProof: goal("lands", null),
      };
    }),
    fire: fireOf(x),
    portfolio: {
      asOf: inv.asOf,
      totalCents: inv.totalCents,
      totalProof: ref({ report: "investments" }, inv.totalCents),
      blocked: inv.blockers.length > 0,
      classes: inv.allocation.map((a) => ({ cls: a.cls, label: classLabel(a.cls), cents: a.cents, share: a.share, proof: classProof(a.cls), shareProof: compositeOf("share", [classProof(a.cls), everyClass], { ratio: a.share }), driftCents: driftOf.get(a.cls) ?? null, driftProof: derivedTarget("investments", invDerived, "drift", a.cls) })),
      holdings,
      hasTarget: inv.drift != null,
      returns: returnsOf(x.netWorth),
    },
    events: eventsOf(x.netWorth, x.changes),
    trends,
    feed: buildFeed({ today: x.book.today, spending: x.spending, netWorth: x.netWorth, changes: x.changes.periods, anomalies: x.anomalies?.items, change: last, calendar: x.calendar.items, goals: x.goals.goals }, FEED_LISTED),
  };
}

/** The portfolio's return as Net worth › Investment returns and How it was built state it. */
function returnsOf(nw: NetWorthReport): BriefingReturns {
  const p = nw.proven.returns.portfolio;
  if (!p) return null;
  const derived = netWorthDerived(nw);
  const last = nw.periods.at(-1);
  return {
    from: p.from,
    total: p.total,
    totalProof: derivedTarget("net-worth", derived, "return-total"),
    annualized: p.annualized,
    annualizedProof: derivedTarget("net-worth", derived, "return-annualized"),
    month:
      last && !last.blockers.length && last.household.portfolioReturn != null
        ? { label: last.label, ratio: last.household.portfolioReturn, proof: derivedTarget("net-worth", builtDerived(nw), "built", cellKey(nw.granularity, `${last.start}:return`, "household")) }
        : null,
  };
}

/** Months worth a flag on the net worth chart, from the reports' own figures: when finances merged, an account first on file, and the months that stand out. */
export function eventsOf(nw: Pick<NetWorthReport, "periods" | "accounts" | "mergeDate">, changes: Pick<NetWorthChangesReport, "periods">): Briefing["events"] {
  const out: Briefing["events"] = [];
  const run = nw.periods.filter((p) => !p.blockers.length);
  const merged = nw.mergeDate ? run.find((p) => p.start <= nw.mergeDate! && nw.mergeDate! <= p.end) : undefined;
  if (merged) out.push({ label: merged.label, text: "finances merged" });
  const names = new Map(nw.accounts.map((a) => [a.id, a.name]));
  for (const p of run.slice(1)) {
    const fresh = p.byAccount.filter((a) => a.newlyTrackedCents !== 0);
    if (fresh.length) out.push({ label: p.label, text: fresh.length === 1 ? `${names.get(fresh[0]!.accountId) ?? "an account"} first on file` : `${fresh.length} accounts first on file` });
  }
  // A month can only stand out against a year of others.
  if (changes.periods.length >= 12) {
    const top = (pick: (c: NetWorthChangesReport["periods"][number]) => number) => changes.periods.reduce((m, c) => (pick(c) > pick(m) ? c : m), changes.periods[0]!);
    out.push({ label: top((c) => c.marketsCents).label, text: "best month for markets" });
    const worst = top((c) => -c.marketsCents);
    if (worst.marketsCents < 0) out.push({ label: worst.label, text: "worst month for markets" });
    out.push({ label: top((c) => c.savedCents).label, text: "most saved in a month" }, { label: top((c) => c.spendingCents).label, text: "most spent in a month" });
  }
  return out;
}

/** Where the FIRE page says the plan stands, on the saved settings (the recipe the sweep holds). */
function fireOf(x: BriefingInputs): Briefing["fire"] {
  const seeds = x.profile.seeds;
  if (!x.forecast || !seeds) return null;
  const a = x.profile.settings.outlook;
  const fire: FireSettings = { walkAwayYear: a.walkAwayYear, withdrawalRate: a.withdrawalRate, stateTaxRate: a.stateTaxRate, retirementAge: a.retirementAge };
  const plans = firePlans(x.forecast);
  const f = analyzeFire(plans.full, plans.base, { asOf: seeds.start.asOf, retirementAge: a.retirementAge });
  const pf = (figure: "fi-year" | "progress" | "fire-number", shownCents: number | null): ProofRef => ({ descriptor: { report: "planning", page: "fire", figure, fire }, shownCents });
  return { fiYear: f.fi?.year ?? null, fiProof: pf("fi-year", null), progress: f.now.progress, progressProof: pf("progress", null), numberCents: f.now.fireNumber, numberProof: pf("fire-number", f.now.fireNumber), levers: fiLevers(f.plan) };
}
