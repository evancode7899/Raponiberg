import { calendarDerived } from "../book/derived/planning.ts";
import { changeStepKey, changeStepsDerived, changeTypicalDerived, typicalKey } from "../book/derived/netWorth.ts";
import { investmentsDerived, positionKey } from "../book/derived/investments.ts";
import { derivedTarget } from "../book/derived/types.ts";
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
import { analyzeFire, firePlans } from "../fire/fire.ts";
import type { Forecast } from "../forecast/forecast.ts";
import { buildFeed, type FeedItem } from "../insights/feed.ts";
import { classLabel } from "../investments/securities.ts";
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
};

export type BriefingStep = { key: string; label: string; cents: number; fromCents: number; toCents: number; typicalCents: number | null; note: string; proof: ProofRef; typicalProof: ProofRef };
export type BriefingDue = { id: string; date: string; title: string; cents: number | null; kind: "save" | "tax" | "file" | "vest"; href: string; done: boolean; perPaycheck: boolean; detail: string; proof: ProofRef };
export type BriefingGoal = { id: string; name: string; status: string; currentCents: number; targetCents: number | null; lands: string | null; blockers: GoalsReport["goals"][number]["blockers"]; currentProof: ProofRef; targetProof: ProofRef; landsProof: ProofRef };
export type BriefingHolding = { key: string; name: string; cents: number; gainCents: number | null; proof: ProofRef; gainProof: ProofRef };
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
  } | null;
  due: BriefingDue[];
  goals: BriefingGoal[];
  fire: { fiYear: number | null; fiProof: ProofRef; progress: number; progressProof: ProofRef; numberCents: number; numberProof: ProofRef } | null;
  portfolio: { asOf: string; totalCents: number; totalProof: ProofRef; blocked: boolean; classes: { cls: string; label: string; cents: number; share: number; proof: ProofRef; shareProof: ProofRef }[]; holdings: BriefingHolding[] };
  /** Each spending category's last twelve proven months, oldest first: a trend line's shape, never drawn as numbers. */
  trends: Record<string, number[]>;
  feed: FeedItem[];
};

const HOLDINGS = 8;

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
  // The same security across accounts is one line (the concentration list's), largest first.
  const holdings: BriefingHolding[] = inv.positions
    .filter((p) => p.kind !== "ACCOUNT")
    .sort((a, b) => b.valueCents - a.valueCents)
    .slice(0, HOLDINGS)
    .map((p) => ({
      key: positionKey(p, "value"),
      name: p.symbol ?? p.name,
      cents: p.valueCents,
      gainCents: p.unrealizedCents,
      proof: ref({ report: "investments", accountId: p.accountId, position: p.key, ...(p.lot ? { lot: p.lot } : {}) }, p.valueCents),
      gainProof: derivedTarget("investments", invDerived, "position", positionKey(p, "gain")),
    }));

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
      classes: inv.allocation.map((a) => ({ cls: a.cls, label: classLabel(a.cls), cents: a.cents, share: a.share, proof: classProof(a.cls), shareProof: compositeOf("share", [classProof(a.cls), everyClass], { ratio: a.share }) })),
      holdings,
    },
    trends,
    feed: buildFeed({ today: x.book.today, spending: x.spending, netWorth: x.netWorth, change: last, calendar: x.calendar.items, goals: x.goals.goals }),
  };
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
  return { fiYear: f.fi?.year ?? null, fiProof: pf("fi-year", null), progress: f.now.progress, progressProof: pf("progress", null), numberCents: f.now.fireNumber, numberProof: pf("fire-number", f.now.fireNumber) };
}
