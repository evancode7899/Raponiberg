import { addDays, inclusiveDays, periodsBetween, type Granularity } from "../../dates/isoDate.ts";
import { formatPercentRatio, usd0 } from "../../formatMoney.ts";
import type { HouseholdPeriod, NetWorthPeriod } from "../../ledger/netWorthReport.ts";
import { chainReturns, type Quality } from "../../ledger/timeline.ts";
import type { Book } from "../load.ts";
import type { ProofDescriptor } from "../proof/index.ts";
import { buildCashFlowReport, type CashFlowPeriod, type CategoryAmount } from "./cashFlow.ts";
import { buildNetWorth, netWorthSpanQuality } from "./netWorth.ts";

/**
 * What changed net worth in each proven period, and how that compares with the periods
 * before it: the Net worth › What changed tab. Income and spending are Cash flow's own
 * figures (rent in the month it pays for, paid-back pairs netted), the rest is net worth's
 * roll-forward, and a timing step carries the difference, so the steps add up to the
 * change on both pages to the cent. A period shows only when both net worth and cash flow
 * can prove it.
 */

export type ChangeStepKey = "income" | "spending" | "retirement" | "other" | "timing" | "markets" | "transit";

export type ChangeStep = {
  key: ChangeStepKey;
  label: string;
  /** What the step did to net worth: spending is negative. */
  cents: number;
  /** The running change before and after this step (the waterfall's bar ends). */
  fromCents: number;
  toCents: number;
  /** The average of the same step over the comparison periods (null without any). */
  typicalCents: number | null;
  /** Its own proof; steps without one are parts of the change's proof. */
  proof: ProofDescriptor | null;
  /** What the step holds, for its tooltip. */
  note: string;
};

/** One category against its average over the comparison periods. */
export type ChangeMover = { category: string; cents: number; typicalCents: number; deltaCents: number; proof: ProofDescriptor };

export type NetWorthChange = {
  label: string;
  start: string;
  end: string;
  /** Set when the period is cut short at the proven-through date. */
  through: string | null;
  openingCents: number;
  closingCents: number;
  changeCents: number;
  /** Everything saved or contributed (Home's "from saving"). */
  savedCents: number;
  /** Market growth net of fees (Home's "from markets"). */
  marketsCents: number;
  incomeCents: number;
  /** Positive: Cash flow's spending. */
  spendingCents: number;
  portfolioReturn: number | null;
  steps: ChangeStep[];
  /** Averages over the comparison periods: the whole periods just before this one that are proven. Null for a period cut short or with none before it. */
  typical: { periods: number; changeCents: number; savedCents: number; marketsCents: number; incomeCents: number; spendingCents: number } | null;
  /** Spending categories that moved most against their average (up first, then down). */
  spendingMovers: ChangeMover[];
  /** Income categories that moved most against their average. */
  incomeMovers: ChangeMover[];
  /** The period in plain sentences, from the figures above. */
  highlights: string[];
  proofs: { opening: ProofDescriptor; closing: ProofDescriptor; change: ProofDescriptor; saved: ProofDescriptor; markets: ProofDescriptor; income: ProofDescriptor; spending: ProofDescriptor };
};

export type NetWorthChangesReport = {
  granularity: Granularity;
  provenThrough: string;
  /** How many periods before each one it is compared with, at most. */
  compareWith: number;
  /** Proven periods, oldest first. */
  periods: NetWorthChange[];
};

/** How many periods before each one count toward its "typical". */
export const COMPARE_WITH: Record<Granularity, number> = { month: 12, quarter: 4, year: 3 };

/** Movers listed per direction, and the smallest move listed, as a share of typical spending (or income). */
const MOVERS = 3;
const MOVER_MIN_SHARE = 0.02;

const UNIT: Record<Granularity, string> = { month: "month", quarter: "quarter", year: "year" };

/** A period of net worth as the household sees it (one month, or months added up). */
type NetWorthSpan = Pick<NetWorthPeriod, "label" | "start" | "end" | "through" | "household">;
type Joined = { nw: NetWorthSpan; cf: CashFlowPeriod };

const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((t, x) => t + x, 0) / xs.length) : 0);
const savedOf = (p: NetWorthSpan) => p.household.principalCents + p.household.newlyTrackedCents;

/** Each category this period against its average over `before` (a category missing from a period counts as zero there). */
function movers(now: CategoryAmount[], before: CategoryAmount[][], typicalTotal: number, proof: (category: string) => ProofDescriptor, sign: 1 | -1): ChangeMover[] {
  const names = new Set([...now, ...before.flat()].map((c) => c.category));
  const all = [...names].map((category) => {
    const cents = now.find((c) => c.category === category)?.cents ?? 0;
    const typicalCents = mean(before.map((cs) => cs.find((c) => c.category === category)?.cents ?? 0));
    return { category, cents, typicalCents, deltaCents: cents - typicalCents, proof: proof(category) };
  });
  const floor = Math.abs(typicalTotal) * MOVER_MIN_SHARE;
  const big = all.filter((m) => Math.abs(m.deltaCents) >= floor && m.deltaCents !== 0);
  const up = big.filter((m) => m.deltaCents * sign > 0).sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents)).slice(0, MOVERS);
  const down = big.filter((m) => m.deltaCents * sign < 0).sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents)).slice(0, MOVERS);
  return [...up, ...down];
}

/** +$1,234 / −$1,234, the sign joined to the amount (U+2060) so a line never breaks between them. */
const signed = (cents: number) => `${cents > 0 ? "+" : "−"}⁠${usd0(Math.abs(cents))}`;
const verb = (cents: number, up: string, down: string) => (cents >= 0 ? up : down);
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function highlightsOf(c: Omit<NetWorthChange, "highlights">, g: Granularity): string[] {
  const unit = UNIT[g];
  const t = c.typical;
  const out: string[] = [];
  // Cents left over at the edges aren't worth a mention.
  const transit = Math.round((c.steps.find((s) => s.key === "transit")?.cents ?? 0) / 100) * 100;
  out.push(
    `Net worth ${verb(c.changeCents, "rose", "fell")} ${usd0(Math.abs(c.changeCents))}: saving ${verb(c.savedCents, "added", "took away")} ${usd0(Math.abs(c.savedCents))} and markets ${verb(c.marketsCents, "added", "took away")} ${usd0(Math.abs(c.marketsCents))}${transit ? `, with ${usd0(Math.abs(transit))} mid-move between your accounts` : ""}.`,
  );
  if (t) {
    const d = c.changeCents - t.changeCents;
    out.push(`That's ${usd0(Math.abs(d))} ${verb(d, "more", "less")} than your average ${unit} over the ${t.periods === 1 ? `${unit} before` : `${t.periods} ${unit}s before`} (${usd0(t.changeCents)}).`);
    const ds = c.spendingCents - t.spendingCents;
    const ups = c.spendingMovers.filter((m) => m.deltaCents > 0).map((m) => `${m.category} (${signed(m.deltaCents)})`);
    const downs = c.spendingMovers.filter((m) => m.deltaCents < 0).map((m) => `${m.category} (${signed(m.deltaCents)})`);
    const why = ds >= 0 ? ups : downs;
    out.push(`Spending was ${usd0(c.spendingCents)}, ${usd0(Math.abs(ds))} ${verb(ds, "above", "below")} average${why.length ? `, mostly ${list(why)}` : ""}.`);
    const di = c.incomeCents - t.incomeCents;
    const incomeWhy = c.incomeMovers.filter((m) => Math.sign(m.deltaCents) === Math.sign(di)).map((m) => `${m.category} (${signed(m.deltaCents)})`);
    out.push(`Income was ${usd0(c.incomeCents)}, ${usd0(Math.abs(di))} ${verb(di, "above", "below")} average${incomeWhy.length ? `, mostly ${list(incomeWhy)}` : ""}.`);
  } else {
    out.push(`Income was ${usd0(c.incomeCents)} and spending ${usd0(c.spendingCents)}.`);
  }
  if (c.portfolioReturn != null) out.push(`Your investments returned ${formatPercentRatio(c.portfolioReturn, 1)} (time-weighted, net of fees).`);
  return out;
}

type Part = [key: ChangeStepKey, label: string, cents: number, proof: ProofDescriptor | null, note: string];

/** The steps from opening to closing, in order: Cash flow's income and spending, net worth's everything else, and timing for what Cash flow counts in another period. */
function partsOf({ nw, cf }: Joined, g: Granularity): Part[] {
  const h = nw.household;
  const span = { start: nw.start, end: nw.end };
  return [
    ["income", "Income", cf.incomeCents, { report: "cash-flow", metric: "income", granularity: g, ...span }, "Cash flow's income: pay, interest, dividends and refunds of income."],
    ["spending", "Spending", -cf.spendingCents, { report: "cash-flow", metric: "spending", granularity: g, ...span }, "Cash flow's spending, net of refunds and paid-back charges."],
    ["retirement", "Retirement from pay", h.retirementEmployeeCents + h.retirementEmployerCents, null, `Payroll deferrals ${usd0(h.retirementEmployeeCents)} and employer money ${usd0(h.retirementEmployerCents)} that went straight to retirement accounts.`],
    ["other", "Other money in/out", h.externalCents + h.newlyTrackedCents, null, "Partner and untracked-account money, and balances already in accounts when they first appear."],
    ["timing", "Counted in another period", h.incomeCents - cf.incomeCents + (h.spendingCents + cf.spendingCents), null, "Cash flow books rent in the month it pays for and nets paid-back pairs; net worth counts money the day it moves. This is the difference."],
    ["markets", "Markets", h.growthNetOfFeesCents, { report: "dashboard", figure: "markets", ...span }, `Market change net of fees (fees ${usd0(h.feesCents)}).`],
    ["transit", "In transit", h.transferResidualCents + h.unexplainedCents, null, "Money mid-move between your own accounts at the period's edges, or a confirmed transfer cost."],
  ];
}

function changeOf(j: Joined, before: Joined[], g: Granularity): NetWorthChange {
  const { nw, cf } = j;
  const h = nw.household;
  const span = { start: nw.start, end: nw.end };
  const saved = savedOf(nw);
  const parts = partsOf(j, g);
  const whole = before.length > 0 && !nw.through;
  const beforeParts = before.map((b) => partsOf(b, g));
  const typicalOf = (key: ChangeStepKey): number | null => (whole ? mean(beforeParts.map((ps) => ps.find((p) => p[0] === key)![2])) : null);
  let run = 0;
  const steps = parts
    // Income, spending and markets always show; the rest when they moved now or usually do.
    .filter(([key, , cents]) => cents !== 0 || (typicalOf(key) ?? 0) !== 0 || key === "income" || key === "spending" || key === "markets")
    .map(([key, label, cents, proof, note]): ChangeStep => {
      const fromCents = run;
      run += cents;
      return { key, label, cents, fromCents, toCents: run, typicalCents: typicalOf(key), proof, note };
    });

  const typical = whole
    ? {
        periods: before.length,
        changeCents: mean(before.map((b) => b.nw.household.closingCents - b.nw.household.openingCents)),
        savedCents: mean(before.map((b) => savedOf(b.nw))),
        marketsCents: mean(before.map((b) => b.nw.household.growthNetOfFeesCents)),
        incomeCents: mean(before.map((b) => b.cf.incomeCents)),
        spendingCents: mean(before.map((b) => b.cf.spendingCents)),
      }
    : null;
  const category = (metric: "income" | "spending") => (c: string): ProofDescriptor => ({ report: "cash-flow", metric, granularity: g, ...span, category: c });
  const c: Omit<NetWorthChange, "highlights"> = {
    label: nw.label,
    ...span,
    through: nw.through,
    openingCents: h.openingCents,
    closingCents: h.closingCents,
    changeCents: h.closingCents - h.openingCents,
    savedCents: saved,
    marketsCents: h.growthNetOfFeesCents,
    incomeCents: cf.incomeCents,
    spendingCents: cf.spendingCents,
    portfolioReturn: h.portfolioReturn,
    steps,
    typical,
    spendingMovers: typical ? movers(cf.spendingByCategory, before.map((b) => b.cf.spendingByCategory), typical.spendingCents, category("spending"), 1) : [],
    incomeMovers: typical ? movers(cf.incomeByCategory, before.map((b) => b.cf.incomeByCategory), typical.incomeCents, category("income"), 1) : [],
    proofs: {
      opening: { report: "net-worth", metric: "balance", date: addDays(nw.start, -1) },
      closing: { report: "net-worth", metric: "balance", date: nw.end },
      change: { report: "net-worth", metric: "change", granularity: g, ...span },
      saved: { report: "dashboard", figure: "saving", ...span },
      markets: { report: "dashboard", figure: "markets", ...span },
      income: parts[0]![3]!,
      spending: parts[1]![3]!,
    },
  };
  return { ...c, highlights: highlightsOf(c, g) };
}

const SUMMED = [
  "newlyTrackedCents",
  "principalCents",
  "incomeCents",
  "spendingCents",
  "externalCents",
  "retirementEmployeeCents",
  "retirementEmployerCents",
  "transferResidualCents",
  "growthNetOfFeesCents",
  "feesCents",
  "unexplainedCents",
] as const satisfies readonly (keyof HouseholdPeriod)[];

/** A span's quality judged as one period (netWorthSpanQuality), not by the worst of its months. */
type SpanQuality = (start: string, end: string) => Quality;

/**
 * A quarter or year of net worth as its months add up: Home's "from saving" and "from
 * markets" (and their proofs) add months, so the steps here do too. Opening is the first
 * month's, closing the last's; the return chains the months' returns, as Investment
 * returns does. Its quality is the span's own, not the worst of its months.
 */
function monthsAdded(label: string, months: NetWorthPeriod[], quality: Quality): NetWorthSpan {
  const first = months[0]!;
  const last = months.at(-1)!;
  const household = { ...first.household, closingCents: last.household.closingCents, quality };
  for (const k of SUMMED) household[k] = months.reduce((t, m) => t + m.household[k], 0);
  const rs = months.map((m) => m.household.portfolioReturn);
  household.portfolioReturn = rs.every((r) => r != null) ? chainReturns(months.map((m) => ({ r: m.household.portfolioReturn!, days: inclusiveDays(m.start, m.end) }))).total : null;
  return { label, start: first.start, end: last.end, through: last.through, household };
}

/**
 * Pairs net worth's months with cash flow's periods (same calendar periods, same
 * proven-through cut) and keeps those both can prove, every month of it; each is compared
 * with up to COMPARE_WITH whole, proven periods just before it.
 */
export function netWorthChangesOf(nwMonths: NetWorthPeriod[], cf: CashFlowPeriod[], g: Granularity, spanQuality: SpanQuality): NetWorthChange[] {
  const joined = cf.flatMap((c): Joined[] => {
    if (c.blockers.length) return [];
    const months = nwMonths.filter((m) => m.start >= c.start && m.end <= c.end);
    const want = periodsBetween(c.start, c.end, "month").length;
    if (months.length !== want || months[0]?.start !== c.start || months.at(-1)!.end !== c.end) return [];
    // Cut short as cash flow cuts it: a year through June is part of a year, though June is a whole month.
    return [{ nw: { ...monthsAdded(c.label, months, spanQuality(c.start, months.at(-1)!.end)), through: c.through }, cf: c }];
  });
  return joined.map((j, i) => {
    const before = joined.slice(0, i).filter((b) => !b.nw.through).slice(-COMPARE_WITH[g]);
    return changeOf(j, before, g);
  });
}

export function buildNetWorthChanges(book: Book, opts: { granularity: Granularity }): NetWorthChangesReport {
  const g = opts.granularity;
  const nw = buildNetWorth(book, { granularity: "month" });
  const cf = buildCashFlowReport(book, { granularity: g });
  return {
    granularity: g,
    provenThrough: nw.provenThrough,
    compareWith: COMPARE_WITH[g],
    periods: netWorthChangesOf(
      nw.periods.filter((p) => !p.blockers.length),
      cf.periods,
      g,
      (start, end) => netWorthSpanQuality(book, start, end).household,
    ),
  };
}
