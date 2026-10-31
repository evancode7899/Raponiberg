"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Card } from "@/components/ui/kit";
import type { ScheduledBonus } from "@/lib/forecast/bonusSchedule";
import { longTermTable, provenActuals, type PlanCellValue } from "@/lib/fire/longTerm";
import { formatUsd } from "@/lib/formatMoney";
import type { OutlookSeeds, ResolvedBasePay } from "@/lib/profile/basePay";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import type { Outlook, OutlookPlan } from "@/lib/profile/outlook";
import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { axisUsd, YearTable, type TableRow } from "@/app/annual/profileUi";
import { monthName, pct, usd } from "@/app/forecast/forecastUi";
import type { FirePlanProof } from "./ui";

// ---------------------------------------------------------------- year by year

/** A long-term table cell as text: dollars, a rate (whole percent for coverage and change), or words. */
const cellText = (row: string, v: PlanCellValue) => ("cents" in v ? usd(v.cents) : "ratio" in v ? pct(v.ratio, row === "coverage" || row === "change" ? 0 : 1) : v.text);

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
  proof,
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
  proof: FirePlanProof;
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

  // The table is one pure model (lib/fire/longTerm.ts): the sweep proves every cell of it on the saved settings.
  const t = useMemo(() => longTermTable({ r, s, full, base, plan, pay, schedule }), [r, s, full, base, plan, pay, schedule]);
  const rows: TableRow[] = t.rows.map((x) =>
    x.kind === "heading"
      ? x
      : {
          label: x.label,
          help: x.help,
          strong: x.strong,
          total: x.total,
          indent: x.indent,
          muted: x.muted,
          cells: x.cells.map((c, j) => (c ? { text: cellText(x.id, c), proof: proof({ figure: "plan-cell", row: x.id, col: t.columns[j]!.id }, c) } : null)),
        },
  );

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
        <YearTable columns={t.columns.map((c) => c.label)} rows={rows} projected={t.projected} highlight={t.highlight} />
      </Card>
    </div>
  );
}
