import type { ProofValue } from "../book/proof/types.ts";
import { bonusesInYear } from "../forecast/forecast.ts";
import type { ScheduledBonus } from "../forecast/bonusSchedule.ts";
import { formatPercentRatio } from "../formatMoney.ts";
import type { CashWaterfall } from "../profile/annualMath.ts";
import type { OutlookSeeds, ResolvedBasePay } from "../profile/basePay.ts";
import type { AnnualProfileReport, YearProfile } from "../profile/buildAnnualProfile.ts";
import type { Outlook, OutlookPlan, OutlookYear } from "../profile/outlook.ts";
import { accessBridge, type AccessBridge, type StressTest } from "./fire.ts";

/**
 * FIRE › Plan's long-term table, as one pure model the page renders and the proof sweep
 * enumerates (proof/planningProof.ts, figure "plan-cell"): the last two proven years, the
 * year in progress so far, then the plan year by year. Every cell the page shows is a
 * cell here, so the server works out exactly the table the page shows (SSOT F4).
 *
 * A cell is money (cents), a rate (ratio) or words; `null` money or rate is a dash (no
 * figure that year), and a missing cell is blank.
 */

export type PlanCellValue = { cents: number | null } | { ratio: number | null } | { text: string };
export type PlanCell = PlanCellValue | null;

/** A cell's value as a proof figure; null for a dash (nothing that year). */
export const planValue = (v: PlanCellValue): ProofValue | null => ("cents" in v ? (v.cents == null ? null : { cents: v.cents }) : "ratio" in v ? (v.ratio == null ? null : { ratio: v.ratio }) : v);

export type PlanRow =
  | { kind: "heading"; label: string }
  | { kind: "row"; id: string; label: string; help?: string; strong?: boolean; total?: boolean; indent?: boolean; muted?: boolean; cells: PlanCell[] };

export type PlanColumn = { id: string; label: string };

export type LongTermTable = {
  columns: PlanColumn[];
  rows: PlanRow[];
  /** Columns that are forecast (italic). */
  projected: number[];
  /** The year in progress, actual + rest (tinted). */
  highlight: number[];
};

export type LongTermInput = {
  r: AnnualProfileReport;
  s: OutlookSeeds;
  /** The plan as run (bonuses included). */
  full: Outlook;
  /** The same plan without any bonus; same as `full` when there are none. */
  base: Outlook;
  plan: OutlookPlan;
  pay: ResolvedBasePay;
  schedule: ScheduledBonus[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: number) => MONTHS[(m - 1 + 12) % 12]!;
const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : formatPercentRatio(r, digits));

type ProvenYear = YearProfile & { cash: NonNullable<YearProfile["cash"]>; netWorth: NonNullable<YearProfile["netWorth"]> };
/** Complete years whose figures are all proven. */
export const provenActuals = (r: AnnualProfileReport) => r.years.filter((y): y is ProvenYear => !y.isCurrent && !!y.cash && !!y.netWorth);

/** An actual column: a proven year, or the year in progress up to where the forecast starts. */
type Actual = {
  label: string;
  year: number;
  w: CashWaterfall | null;
  nw: { netWorth: number; liquid: number; illiquid: number };
  change: { cents: number; pct: number | null } | null;
};
const provenColumn = (y: ProvenYear): Actual => ({ label: String(y.year), year: y.year, w: y.cash.waterfall, nw: y.netWorth, change: y.change });

/**
 * The year in progress from Jan 1 to the forecast's start, so actual + the forecast's rest of
 * the year = the whole year (as on /forecast). It closes on the forecast's starting balances;
 * its cash flows are blank when they aren't proven as far as net worth.
 */
function ytdColumn(r: AnnualProfileReport, s: OutlookSeeds): Actual | null {
  const y = r.ytd;
  if (!y || s.start.year !== r.currentYear || s.start.month === 12) return null;
  const prev = r.years.find((v) => v.year === y.year - 1 && !v.isCurrent)?.netWorth?.netWorth ?? null;
  const nw = { netWorth: s.start.liquid + s.start.illiquid, liquid: s.start.liquid, illiquid: s.start.illiquid };
  const cents = prev == null ? null : nw.netWorth - prev;
  return {
    label: `Jan–${monthName(s.start.month)} ${y.year}`,
    year: y.year,
    w: y.cash && y.asOf >= y.netWorthAsOf ? y.cash.waterfall : null,
    nw,
    change: cents == null ? null : { cents, pct: prev! > 0 ? cents / prev! : null },
  };
}

const yearCol = (y: OutlookYear) => (y.months < 12 ? `${monthName(13 - y.months)}–Dec ${y.year}E` : `${y.year}E`);

/** Taxes on a year's pay: base pay's tax share of salary, plus what bonuses add on top. */
export const payTaxes = (y: OutlookYear, pay: ResolvedBasePay) => Math.round(pay.salary > 0 ? (y.salary * pay.tax.total) / pay.salary : 0) + (y.bonusGross - y.bonusKept);

const money = (cents: number | null): PlanCellValue => ({ cents });
const rate = (ratio: number | null): PlanCellValue => ({ ratio });

/** The long-term table as FIRE › Plan shows it. */
export function longTermTable({ r, s, full, base, plan, pay, schedule }: LongTermInput): LongTermTable {
  const hasBonus = full.years.some((y) => y.bonusGross > 0);
  // The last two proven years for context; a mid-year start adds this year so far (actual)
  // before its forecast rest, then the whole year.
  const ytd = full.years[0]?.year === r.currentYear && full.years[0].months < 12 ? ytdColumn(r, s) : null;
  const actual = [...provenActuals(r).slice(-2).map(provenColumn), ...(ytd ? [ytd] : [])];
  const labels = [...actual.map((c) => c.label), ...full.years.map(yearCol)];
  if (ytd) labels.splice(actual.length + 1, 0, `${ytd.year} total`);
  const at = (i: number) => actual.length + i + (ytd && i >= 1 ? 1 : 0);
  const projected = full.years.map((_, i) => at(i));
  const highlight = ytd ? [actual.length + 1] : [];

  /** Plan cells in order, with the whole-year total after the first (partial) year. */
  const planCells = (cell: (y: OutlookYear, i: number) => PlanCell, total: () => PlanCell): PlanCell[] => full.years.flatMap((y, i) => (ytd && i === 0 ? [cell(y, i), total()] : [cell(y, i)]));
  type Opts = Omit<Extract<PlanRow, { kind: "row" }>, "kind" | "id" | "label" | "cells"> & {
    /** The whole-year total: the Dec 31 figure (a balance), the forecast rest only, or actual + rest (default). */
    sum?: "balance" | "rest";
  };
  const row = (id: string, label: string, a: ((c: Actual) => number | null) | null, p: (y: OutlookYear, i: number) => number | null, { sum, ...opts }: Opts = {}): PlanRow => {
    const total = (): PlanCell => {
      const rest = p(full.years[0]!, 0);
      if (sum === "balance" || sum === "rest") return money(rest);
      // Blank when the row has no actual figure; a forecast with nothing in it (no bonus) counts as zero.
      if (!a) return null;
      const so = a(ytd!);
      return money(so == null ? null : so + (rest ?? 0));
    };
    return { kind: "row", id, label, ...opts, cells: [...actual.map((c) => (a ? money(a(c)) : null)), ...planCells((y, i) => money(p(y, i)), total)] };
  };
  /** A rate per plan year: undefined is blank, null a dash. */
  const ratioRow = (id: string, label: string, p: (y: OutlookYear, i: number) => number | null | undefined, opts: Opts = {}): PlanRow => ({
    kind: "row",
    id,
    label,
    muted: true,
    ...opts,
    cells: [...actual.map(() => null), ...planCells((y, i) => {
      const v = p(y, i);
      return v === undefined ? null : rate(v);
    }, () => null)],
  });
  const bonusOf = (y: OutlookYear, kinds: ScheduledBonus["source"][]) => bonusesInYear(schedule, y.year, kinds);
  const retired = full.years.some((y) => !y.working);
  const rows: PlanRow[] = [];
  if (full.years.some((y) => y.age != null)) {
    const age = (n: number | null | undefined): PlanCell => (n == null ? null : { text: String(n) });
    rows.push({ kind: "row", id: "age", label: "Age", muted: true, cells: [...actual.map((c) => age(plan.birthYear ? c.year - plan.birthYear : null)), ...planCells((y) => age(y.age), () => age(full.years[0]!.age))] });
  }
  rows.push(
    { kind: "heading", label: "Pay" },
    row("salary", "Base salary", (c) => c.w?.salary ?? null, (y) => (y.working ? y.salary : null), { indent: true }),
    ratioRow("raise", "Raise", (y, i) => (y.working && i > 0 ? plan.salaryGrowth : undefined), { indent: true }),
    row("bonus", "Bonuses (gross)", (c) => c.w?.bonus ?? null, (y) => (y.working ? y.bonusGross : null), { indent: true }),
  );
  if (hasBonus) {
    rows.push(
      row("bonus-known", "paid or on a letter", (c) => c.w?.bonus ?? null, (y) => (y.working ? bonusOf(y, ["PAID", "LETTER"]) || null : null), { indent: true, muted: true }),
      row("bonus-estimated", "estimated", null, (y) => (y.working ? bonusOf(y, ["ESTIMATE"]) || null : null), { indent: true, muted: true, sum: "rest" }),
    );
  }
  rows.push(
    row("pay-taxes", "Taxes on pay (est.)", null, (y) => (y.working ? -payTaxes(y, pay) : null), {
      indent: true,
      help: `Income tax, FICA and CT paid leave: base pay at its ${s.taxYear} rate (${pct(pay.salary > 0 ? pay.tax.total / pay.salary : null)} of salary) plus ${pct(1 - pay.bonus.keepRate)} of each bonus.`,
    }),
    row("employer", "Employer 401(k) & HSA", (c) => c.w?.employer ?? null, (y) => (y.working ? y.employerMatch : null), { indent: true }),
    { kind: "heading", label: "Spending" },
    row("living", "Living cost", (c) => (c.w ? -c.w.living : null), (y) => -y.livingCost, { indent: true }),
    ratioRow("living-growth", "Living cost growth", (_y, i) => (i > 0 ? plan.livingGrowth : undefined), { indent: true }),
    row("one-offs", "One-off expenses", (c) => (c.w ? -c.w.nonRecurring : null), (y) => -y.planned, { indent: true }),
  );
  if (retired) {
    rows.push(
      { kind: "heading", label: "Retired" },
      row("draw", "Pre-tax draw", null, (y) => (y.working ? null : -y.draw), { indent: true }),
      row("draw-taxes", "Taxes on draw", null, (y) => (y.working ? null : -(y.federalTax + y.stateTax)), { indent: true }),
      row("after-tax", "After-tax income", null, (y) => (y.working ? null : y.afterTaxIncome), { strong: true }),
      ratioRow("coverage", "Covers living cost", (y) => (y.working ? undefined : y.coverage)),
    );
  }
  rows.push(
    { kind: "heading", label: "Net worth" },
    row("saved", "Total saved", (c) => c.w?.saved ?? null, (y) => y.saved, { strong: true, help: "Actual years: the whole paycheck-to-savings waterfall. Plan: base pay saved + the saved share of bonuses kept." }),
    row("growth", "Investment growth & other changes", (c) => (c.change && c.w ? c.change.cents - c.w.saved : null), (y) => y.growth, {
      indent: true,
      help: "Actual years: everything besides what was saved incl. retirement (markets, outside money, gaps — see the annual statement). Plan: returns only.",
    }),
    ratioRow("return", "Return", () => plan.returnRate, { indent: true }),
    row("net-worth", "Net worth, Dec 31", (c) => c.nw.netWorth, (y) => y.netWorth, { total: true, sum: "balance" }),
    row("liquid", "Liquid", (c) => c.nw.liquid, (y) => y.liquid, { muted: true, indent: true, sum: "balance" }),
    row("illiquid", "Illiquid", (c) => c.nw.illiquid, (y) => y.illiquid, { muted: true, indent: true, sum: "balance" }),
  );
  if (hasBonus) rows.push(row("net-worth-base", "Net worth with no bonuses", null, (_y, i) => base.years[i]!.netWorth, { muted: true, sum: "balance", help: "The same plan with every bonus left out." }));
  // Dec 31 against last Dec 31, as for a full year.
  const open = ytd?.change ? ytd.nw.netWorth - ytd.change.cents : null;
  rows.push({
    kind: "row",
    id: "change",
    label: "Change in net worth",
    muted: true,
    cells: [...actual.map((c) => rate(c.change?.pct ?? null)), ...planCells((y) => rate(y.changePct), () => rate(open && open > 0 ? (full.years[0]!.netWorth - open) / open : null))],
  });

  return { columns: labels.map((label) => ({ id: label, label })), rows, projected, highlight };
}

/** Every figure the table shows (each non-blank cell that holds a value), with its row and column. */
export function longTermCells(t: LongTermTable): { row: string; col: string; label: string; value: PlanCellValue }[] {
  const out: { row: string; col: string; label: string; value: PlanCellValue }[] = [];
  for (const r of t.rows) {
    if (r.kind !== "row") continue;
    r.cells.forEach((c, j) => {
      if (c && !isEmptyCell(c)) out.push({ row: r.id, col: t.columns[j]!.id, label: `${r.label}, ${t.columns[j]!.label}`, value: c });
    });
  }
  return out;
}

/** A cell with no value that year: a dash, never a figure. */
export const isEmptyCell = (c: PlanCellValue) => ("cents" in c && c.cents == null) || ("ratio" in c && c.ratio == null);

/** The walk-away year the access card uses: as set, or FI's year when none is set. */
export const accessWalkAway = (plan: OutlookPlan, fiYear: number | null) => plan.walkAwayYear ?? fiYear;

export type AccessFigure = "liquid" | "illiquid" | "liquid-out" | "access-year";

/** FIRE › Plan's "Bridging to 59½" tiles, as the page shows them. */
export function accessFigures(plan: OutlookPlan, fiYear: number | null): { bridge: AccessBridge; walkAway: number; figures: Record<AccessFigure, PlanCellValue> } | null {
  const walkAway = accessWalkAway(plan, fiYear);
  if (!walkAway) return null;
  const bridge = accessBridge(plan, walkAway);
  if (!bridge) return null;
  return {
    bridge,
    walkAway,
    figures: {
      liquid: money(bridge.liquidAtWalkAway),
      illiquid: money(bridge.illiquidAtWalkAway),
      "liquid-out": { text: bridge.liquidOutYear ? String(bridge.liquidOutYear) : "never runs out" },
      "access-year": { text: String(bridge.accessYear) },
    },
  };
}

export type StressFigure = "p50" | "p10" | "p90" | "by-fi";
/** Market paths the stress test runs (FIRE › Stress test). */
export const STRESS_PATHS = 1000;

/** The stress test's four tiles, as the page shows them: FI years at three percentiles, and the chance of FI by the steady plan's FI year. */
export function stressFigures(s: StressTest, fiYear: number | null): Record<StressFigure, PlanCellValue> {
  const byPlanFi = fiYear ? (s.fiByYear.find((x) => x.year === fiYear)?.share ?? null) : null;
  return {
    p50: { text: s.fiYears.p50 ? String(s.fiYears.p50) : "Not in 60 yrs" },
    p10: s.fiYears.p10 ? { text: String(s.fiYears.p10) } : { cents: null },
    p90: { text: s.fiYears.p90 ? String(s.fiYears.p90) : "Not in 60 yrs" },
    "by-fi": rate(byPlanFi),
  };
}
