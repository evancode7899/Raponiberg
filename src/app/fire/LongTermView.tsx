"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Card } from "@/components/ui/kit";
import type { ScheduledBonus } from "@/lib/forecast/bonusSchedule";
import { formatUsd } from "@/lib/formatMoney";
import type { OutlookSeeds, ResolvedBasePay } from "@/lib/profile/basePay";
import type { CashWaterfall } from "@/lib/profile/annualMath";
import type { AnnualProfileReport, YearProfile } from "@/lib/profile/buildAnnualProfile";
import type { Outlook, OutlookPlan, OutlookYear } from "@/lib/profile/outlook";
import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { axisUsd, YearTable, type Cell, type TableRow } from "@/app/annual/profileUi";
import { monthName, pct, usd } from "@/app/forecast/forecastUi";

// ---------------------------------------------------------------- year by year

type ProvenYear = YearProfile & { cash: NonNullable<YearProfile["cash"]>; netWorth: NonNullable<YearProfile["netWorth"]> };
/** Complete years whose figures are all proven. */
const provenActuals = (r: AnnualProfileReport) => r.years.filter((y): y is ProvenYear => !y.isCurrent && !!y.cash && !!y.netWorth);

/** An actual column: a proven year, or the year in progress up to where the forecast starts. Null = not proven. */
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

/**
 * Proven years, then the plan year by year: the assumptions each year runs on (salary,
 * raise, bonuses by kind, taxes, living cost and its growth, return), the flows, and
 * year-end balances. The chart shows the same plan with proven balances as dots.
 */
export function LongTermView({
  r,
  s,
  full,
  base,
  plan,
  pay,
  schedule,
  fiYear,
}: {
  r: AnnualProfileReport;
  s: OutlookSeeds;
  /** The plan as run (bonuses included). */
  full: Outlook;
  /** The same plan without any bonus (the dashed line); same as `full` when there are none. */
  base: Outlook;
  plan: OutlookPlan;
  pay: ResolvedBasePay;
  schedule: ScheduledBonus[];
  fiYear: number | null;
}) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const hasBonus = full.years.some((y) => y.bonusGross > 0);
  const data = useMemo(() => {
    const rows: Record<string, number | string | null>[] = [];
    for (const y of provenActuals(r)) rows.push({ year: String(y.year), actual: y.netWorth.netWorth / 100 });
    // The proven starting point (mid-year when the statements run past Dec 31).
    const startLabel = s.start.month === 12 ? String(s.start.year) : `${monthName(s.start.month)} ${s.start.year}`;
    const startNw = (s.start.liquid + s.start.illiquid) / 100;
    const existing = rows.find((x) => x.year === startLabel);
    const startRow = existing ?? { year: startLabel, actual: startNw };
    Object.assign(startRow, { liquid: s.start.liquid / 100, illiquid: s.start.illiquid / 100, baseOnly: startNw });
    if (!existing) rows.push(startRow);
    // Each projected year at Dec 31.
    full.years.forEach((y, i) => rows.push({ year: String(y.year), liquid: y.liquid / 100, illiquid: y.illiquid / 100, baseOnly: base.years[i]!.netWorth / 100 }));
    return rows;
  }, [r, s, full, base]);

  // The last two proven years for context; the full history is on the annual statement.
  // A mid-year start adds this year so far (actual) before its forecast rest, then the whole year,
  // so the year in progress compares with full years on either side.
  const ytd = full.years[0]?.year === r.currentYear && full.years[0].months < 12 ? ytdColumn(r, s) : null;
  const actual = [...provenActuals(r).slice(-2).map(provenColumn), ...(ytd ? [ytd] : [])];
  const totalAt = ytd ? 1 : -1;
  const cols = [...actual.map((c) => c.label), ...full.years.map(yearCol)];
  if (ytd) cols.splice(actual.length + 1, 0, `${ytd.year} total`);
  const at = (i: number) => actual.length + i + (ytd && i >= totalAt ? 1 : 0);
  const projected = full.years.map((_, i) => at(i));
  const highlight = ytd ? [actual.length + totalAt] : [];
  /** Plan cells in order, with the whole-year total after the first (partial) year. */
  const planCells = (cell: (y: OutlookYear, i: number) => Cell, total: () => Cell): Cell[] =>
    full.years.flatMap((y, i) => (ytd && i === 0 ? [cell(y, i), total()] : [cell(y, i)]));
  type RowOpts = Partial<Extract<TableRow, { cells: Cell[] }>> & {
    /** The whole-year total: the Dec 31 figure (a balance), the forecast rest only, or actual + rest (default). */
    sum?: "balance" | "rest";
  };
  const row = (label: string, a: ((c: Actual) => number | null) | null, p: (y: OutlookYear, i: number) => number | null, { sum, ...opts }: RowOpts = {}): TableRow => {
    const total = (): Cell => {
      const rest = p(full.years[0]!, 0);
      if (sum === "balance" || sum === "rest") return { text: usd(rest) };
      // Blank when the row has no actual figure; a forecast with nothing in it (no bonus) counts as zero.
      if (!a) return { text: "", dim: true };
      const so = a(ytd!);
      return so == null ? { text: usd(null) } : { text: usd(so + (rest ?? 0)) };
    };
    return {
      label,
      ...opts,
      cells: [...actual.map((c) => (a ? { text: usd(a(c)) } : { text: "", dim: true })), ...planCells((y, i) => ({ text: usd(p(y, i)) }), total)],
    };
  };
  const text = (label: string, p: (y: OutlookYear, i: number) => string, opts: Partial<Extract<TableRow, { cells: Cell[] }>> = {}): TableRow => ({
    label,
    muted: true,
    ...opts,
    cells: [...actual.map(() => null), ...planCells((y, i) => ({ text: p(y, i) }), () => null)],
  });
  const bonusOf = (y: OutlookYear, kinds: ScheduledBonus["source"][]) =>
    schedule.filter((b) => b.counted && kinds.includes(b.source) && b.key.startsWith(`${y.year}-`)).reduce((t, b) => t + b.gross, 0);
  const retired = full.years.some((y) => !y.working);
  const rows: TableRow[] = [];
  if (full.years.some((y) => y.age != null)) {
    rows.push({ label: "Age", muted: true, cells: [...actual.map((c) => ({ text: plan.birthYear ? c.year - plan.birthYear : "" })), ...planCells((y) => ({ text: y.age ?? "" }), () => ({ text: full.years[0]!.age ?? "" }))] });
  }
  rows.push(
    { kind: "heading", label: "Pay" },
    row("Base salary", (c) => c.w?.salary ?? null, (y) => (y.working ? y.salary : null), { indent: true }),
    text("Raise", (y, i) => (y.working && i > 0 ? pct(plan.salaryGrowth) : ""), { indent: true }),
    row("Bonuses (gross)", (c) => c.w?.bonus ?? null, (y) => (y.working ? y.bonusGross : null), { indent: true }),
  );
  if (hasBonus) {
    rows.push(
      row("paid or on a letter", (c) => c.w?.bonus ?? null, (y) => (y.working ? bonusOf(y, ["PAID", "LETTER"]) || null : null), { indent: true, muted: true }),
      row("estimated", null, (y) => (y.working ? bonusOf(y, ["ESTIMATE"]) || null : null), { indent: true, muted: true, sum: "rest" }),
    );
  }
  rows.push(
    row("Taxes on pay (est.)", null, (y) => (y.working ? -payTaxes(y, pay) : null), {
      indent: true,
      help: `Income tax, FICA and CT paid leave: base pay at its ${s.taxYear} rate (${pct(pay.salary > 0 ? pay.tax.total / pay.salary : null)} of salary) plus ${pct(1 - pay.bonus.keepRate)} of each bonus.`,
    }),
    row("Employer 401(k) & HSA", (c) => c.w?.employer ?? null, (y) => (y.working ? y.employerMatch : null), { indent: true }),
    { kind: "heading", label: "Spending" },
    row("Living cost", (c) => (c.w ? -c.w.living : null), (y) => -y.livingCost, { indent: true }),
    text("Living cost growth", (_y, i) => (i > 0 ? pct(plan.livingGrowth) : ""), { indent: true }),
    row("One-off expenses", (c) => (c.w ? -c.w.nonRecurring : null), (y) => -y.planned, { indent: true }),
  );
  if (retired) {
    rows.push(
      { kind: "heading", label: "Retired" },
      row("Pre-tax draw", null, (y) => (y.working ? null : -y.draw), { indent: true }),
      row("Taxes on draw", null, (y) => (y.working ? null : -(y.federalTax + y.stateTax)), { indent: true }),
      row("After-tax income", null, (y) => (y.working ? null : y.afterTaxIncome), { strong: true }),
      { label: "Covers living cost", muted: true, cells: [...actual.map(() => null), ...planCells((y) => (y.working ? null : { text: pct(y.coverage, 0) }), () => null)] },
    );
  }
  rows.push(
    { kind: "heading", label: "Net worth" },
    row("Total saved", (c) => c.w?.saved ?? null, (y) => y.saved, { strong: true, help: "Actual years: the whole paycheck-to-savings waterfall. Plan: base pay saved + the saved share of bonuses kept." }),
    row("Investment growth & other changes", (c) => (c.change && c.w ? c.change.cents - c.w.saved : null), (y) => y.growth, {
      indent: true,
      help: "Actual years: everything besides cash saved (markets, outside money, gaps — see the annual statement). Plan: returns only.",
    }),
    text("Return", () => pct(plan.returnRate), { indent: true }),
    row("Net worth, Dec 31", (c) => c.nw.netWorth, (y) => y.netWorth, { total: true, sum: "balance" }),
    row("Liquid", (c) => c.nw.liquid, (y) => y.liquid, { muted: true, indent: true, sum: "balance" }),
    row("Illiquid", (c) => c.nw.illiquid, (y) => y.illiquid, { muted: true, indent: true, sum: "balance" }),
  );
  if (hasBonus) rows.push(row("Net worth with no bonuses", null, (_y, i) => base.years[i]!.netWorth, { muted: true, sum: "balance", help: "The same plan with every bonus left out." }));
  rows.push({
    label: "Change in net worth",
    muted: true,
    cells: [
      ...actual.map((c) => ({ text: pct(c.change?.pct, 0) })),
      ...planCells(
        (y) => ({ text: pct(y.changePct, 0) }),
        () => {
          // Dec 31 against last Dec 31, as for a full year.
          const open = ytd?.change ? ytd.nw.netWorth - ytd.change.cents : null;
          return { text: pct(open && open > 0 ? (full.years[0]!.netWorth - open) / open : null, 0) };
        },
      ),
    ],
  });

  const ntStart = data.findIndex((d) => d.baseOnly != null);
  const showNear = schedule.some((b) => !b.counted && b.why?.startsWith("near term"));
  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Net worth: proven and forecast"
        subtitle={
          hasBonus
            ? "Dots are proven balances. The shaded areas are the forecast; the dashed line is the same forecast with no bonuses at all."
            : "Dots are proven balances. The shaded areas are the forecast (base pay only: no bonus is paid, scheduled or estimated)."
        }
      >
        <div className="h-[340px] w-full min-w-0">
          <RechartsResponsive>
            <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="year" {...ui.xAxis} interval="preserveStartEnd" minTickGap={14} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
              <Tooltip {...ui.tooltip} formatter={(v, name) => [formatUsd(Math.round(Number(v))), String(name)]} />
              <Legend {...ui.legend} />
              {showNear && ntStart >= 0 && (
                <ReferenceArea
                  x1={String(data[ntStart]!.year)}
                  x2={String(plan.nearTermThrough)}
                  fill={chart.grid}
                  fillOpacity={0.5}
                  label={{ value: "Near term: no estimated bonus", fill: chart.legend, fontSize: 11, position: "insideTop" }}
                />
              )}
              <Area type="monotone" dataKey="illiquid" name="Illiquid" stackId="p" stroke={chart.series[2]} fill={chart.series[2]} fillOpacity={0.4} isAnimationActive={false} connectNulls />
              <Area type="monotone" dataKey="liquid" name="Liquid" stackId="p" stroke={chart.series[1]} fill={chart.series[1]} fillOpacity={0.4} isAnimationActive={false} connectNulls />
              {hasBonus && <Line type="monotone" dataKey="baseOnly" name="No bonuses" stroke={chart.lineBalance} strokeDasharray="5 4" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />}
              <Line type="monotone" dataKey="actual" name="Proven" stroke={chart.lineBalance} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} connectNulls />
              {plan.walkAwayYear && <ReferenceLine x={String(plan.walkAwayYear)} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: "Walk away", fill: chart.legend, fontSize: 11, position: "insideTopLeft" }} />}
              {fiYear && fiYear !== plan.walkAwayYear && (
                <ReferenceLine x={String(fiYear)} stroke={chart.series[0]} strokeDasharray="2 2" label={{ value: "FI", fill: chart.legend, fontSize: 11, position: "insideTopRight" }} />
              )}
            </ComposedChart>
          </RechartsResponsive>
        </div>
      </Card>
      <Card title="Year by year" subtitle="The last two proven years, this year so far (actual) with the rest of it forecast and the two added up, then the forecast (E). Each column shows the assumptions that year runs on, what flows in and out, and where balances end on Dec 31.">
        <YearTable columns={cols} rows={rows} projected={projected} highlight={highlight} />
      </Card>
    </div>
  );
}
