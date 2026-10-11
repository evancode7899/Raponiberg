"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Card } from "@/components/ui/kit";
import type { ScheduledBonus } from "@/lib/forecast/bonusSchedule";
import { formatUsd } from "@/lib/formatMoney";
import type { OutlookSeeds, ResolvedBasePay } from "@/lib/profile/basePay";
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
  const actual = provenActuals(r).slice(-2);
  const cols = [...actual.map((y) => String(y.year)), ...full.years.map(yearCol)];
  const projected = full.years.map((_, i) => actual.length + i);
  const row = (
    label: string,
    a: ((y: ProvenYear) => number | null) | null,
    p: (y: OutlookYear, i: number) => number | null,
    opts: Partial<Extract<TableRow, { cells: Cell[] }>> = {},
  ): TableRow => ({
    label,
    ...opts,
    cells: [...actual.map((y) => (a ? { text: usd(a(y)) } : { text: "", dim: true })), ...full.years.map((y, i) => ({ text: usd(p(y, i)) }))],
  });
  const text = (label: string, p: (y: OutlookYear, i: number) => string, opts: Partial<Extract<TableRow, { cells: Cell[] }>> = {}): TableRow => ({
    label,
    muted: true,
    ...opts,
    cells: [...actual.map(() => null), ...full.years.map((y, i) => ({ text: p(y, i) }))],
  });
  const bonusOf = (y: OutlookYear, kinds: ScheduledBonus["source"][]) =>
    schedule.filter((b) => b.counted && kinds.includes(b.source) && b.key.startsWith(`${y.year}-`)).reduce((t, b) => t + b.gross, 0);
  const retired = full.years.some((y) => !y.working);
  const rows: TableRow[] = [];
  if (full.years.some((y) => y.age != null)) {
    rows.push({ label: "Age", muted: true, cells: [...actual.map((y) => ({ text: plan.birthYear ? y.year - plan.birthYear : "" })), ...full.years.map((y) => ({ text: y.age ?? "" }))] });
  }
  rows.push(
    { kind: "heading", label: "Pay" },
    row("Base salary", (y) => y.cash.waterfall.salary, (y) => (y.working ? y.salary : null), { indent: true }),
    text("Raise", (y, i) => (y.working && i > 0 ? pct(plan.salaryGrowth) : ""), { indent: true }),
    row("Bonuses (gross)", (y) => y.cash.waterfall.bonus, (y) => (y.working ? y.bonusGross : null), { indent: true }),
  );
  if (hasBonus) {
    rows.push(
      row("paid or on a letter", null, (y) => (y.working ? bonusOf(y, ["PAID", "LETTER"]) || null : null), { indent: true, muted: true }),
      row("estimated", null, (y) => (y.working ? bonusOf(y, ["ESTIMATE"]) || null : null), { indent: true, muted: true }),
    );
  }
  rows.push(
    row("Taxes on pay (est.)", null, (y) => (y.working ? -payTaxes(y, pay) : null), {
      indent: true,
      help: `Income tax, FICA and CT paid leave: base pay at its ${s.taxYear} rate (${pct(pay.salary > 0 ? pay.tax.total / pay.salary : null)} of salary) plus ${pct(1 - pay.bonus.keepRate)} of each bonus.`,
    }),
    row("Employer 401(k) & HSA", (y) => y.cash.waterfall.employer, (y) => (y.working ? y.employerMatch : null), { indent: true }),
    { kind: "heading", label: "Spending" },
    row("Living cost", (y) => -y.cash.waterfall.living, (y) => -y.livingCost, { indent: true }),
    text("Living cost growth", (_y, i) => (i > 0 ? pct(plan.livingGrowth) : ""), { indent: true }),
    row("One-off expenses", (y) => -y.cash.waterfall.nonRecurring, (y) => -y.planned, { indent: true }),
  );
  if (retired) {
    rows.push(
      { kind: "heading", label: "Retired" },
      row("Pre-tax draw", null, (y) => (y.working ? null : -y.draw), { indent: true }),
      row("Taxes on draw", null, (y) => (y.working ? null : -(y.federalTax + y.stateTax)), { indent: true }),
      row("After-tax income", null, (y) => (y.working ? null : y.afterTaxIncome), { strong: true }),
      { label: "Covers living cost", muted: true, cells: [...actual.map(() => null), ...full.years.map((y) => (y.working ? null : { text: pct(y.coverage, 0) }))] },
    );
  }
  rows.push(
    { kind: "heading", label: "Net worth" },
    row("Total saved", (y) => y.cash.waterfall.saved, (y) => y.saved, { strong: true, help: "Actual years: the whole paycheck-to-savings waterfall. Plan: base pay saved + the saved share of bonuses kept." }),
    row("Investment growth & other changes", (y) => (y.change == null ? null : y.change.cents - y.cash.waterfall.saved), (y) => y.growth, {
      indent: true,
      help: "Actual years: everything besides cash saved (markets, outside money, gaps — see the annual statement). Plan: returns only.",
    }),
    text("Return", () => pct(plan.returnRate), { indent: true }),
    row("Net worth, Dec 31", (y) => y.netWorth.netWorth, (y) => y.netWorth, { total: true }),
    row("Liquid", (y) => y.netWorth.liquid, (y) => y.liquid, { muted: true, indent: true }),
    row("Illiquid", (y) => y.netWorth.illiquid, (y) => y.illiquid, { muted: true, indent: true }),
  );
  if (hasBonus) rows.push(row("Net worth with no bonuses", null, (_y, i) => base.years[i]!.netWorth, { muted: true, help: "The same plan with every bonus left out." }));
  rows.push({
    label: "Change in net worth",
    muted: true,
    cells: [...actual.map((y) => ({ text: pct(y.change?.pct, 0) })), ...full.years.map((y) => ({ text: pct(y.changePct, 0) }))],
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
      <Card title="Year by year" subtitle="The last two proven years, then the forecast (E). Each column shows the assumptions that year runs on, what flows in and out, and where balances end on Dec 31.">
        <YearTable columns={cols} rows={rows} projected={projected} />
      </Card>
    </div>
  );
}
