"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Callout, Card, NotFigure, StatCell, StatGrid, WhatIf } from "@/components/ui/kit";
import { stressTest } from "@/lib/fire/fire";
import { axisUsd } from "@/lib/formatMoney";
import { useDeferredValue, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { deflator, DollarsToggle, pct, tipUsd, yearAge, type FirePlanProof, type FireProps } from "./ui";
import { STRESS_PATHS, stressFigures, type StressFigure } from "@/lib/fire/longTerm";

const PATHS = STRESS_PATHS;

/**
 * The plan assumes the same return every year; markets don't. This reruns it 1,000 times
 * with random yearly returns that average the plan's return, to show how far the dates
 * can move — and why the first years of retirement matter most (sequence risk).
 */
export function StressTab({ f, dollars, setDollars, volatility, proof }: FireProps & { volatility: number; proof: FirePlanProof }) {
  const plan = useDeferredValue(f.plan);
  const s = useMemo(() => stressTest(plan, { volatility, paths: PATHS }), [plan, volatility]);
  // The tiles are the shared model (lib/fire/longTerm.ts) the sweep proves on the saved settings.
  const tiles = stressFigures(s, f.fi?.year ?? null);
  const tile = (metric: StressFigure) => proof({ figure: "stress", metric, volatility }, tiles[metric]);
  const byPlanFi = "ratio" in tiles["by-fi"] ? tiles["by-fi"].ratio : null;
  return (
    <>
      <StatGrid cols={4}>
        <StatCell proof={tile("p50")} label="Typical market" value={s.fiYears.p50 ? String(s.fiYears.p50) : "Not in 60 yrs"} sub={`median of ${PATHS.toLocaleString()} market paths`} />
        <StatCell proof={tile("p10")} label="Good markets" value={s.fiYears.p10 ? String(s.fiYears.p10) : "—"} tone="pos" sub={<NotFigure why="what the percentile means">best 10%: 1 path in 10 is FI by then</NotFigure>} />
        <StatCell proof={tile("p90")} label="Bad markets" value={s.fiYears.p90 ? String(s.fiYears.p90) : "Not in 60 yrs"} tone="warn" sub={<NotFigure why="what the percentile means">{s.fiYears.p90 ? "worst 10%: 9 paths in 10 are FI by then" : "worst 10% of paths aren't FI within 60 years"}</NotFigure>} />
        <StatCell proof={tile("by-fi")} label={f.fi ? `FI by ` : "Chance of FI"} value={byPlanFi != null ? pct(byPlanFi, 0) : "—"} sub="chance by the steady-return plan's FI year" />
      </StatGrid>
      {s.coveredThroughout != null && (
        <Callout
          tone={s.coveredThroughout >= 0.8 ? "good" : "warn"}
          title={<WhatIf inline why="the stress test's simulated markets">{`Walking away in ${plan.walkAwayYear}: income covers living cost every retired year in ${pct(s.coveredThroughout, 0)} of paths`}</WhatIf>}
        >
          Drawing a fixed share of net worth never runs the money out, but the income moves with markets. A crash early in retirement cuts the income for years — that&apos;s
          sequence-of-returns risk. A cash buffer, a lower withdrawal rate or flexible spending in bad years all help.
        </Callout>
      )}
      <Fan f={f} s={s} dollars={dollars} setDollars={setDollars} />
      <Odds s={s} f={f} />
      <p className="text-[11px] text-muted">
        <NotFigure why="your settings and how the model works">
          Returns are drawn at random each year (lognormal, average {pct(plan.returnRate)}, standard deviation {pct(volatility, 0)} — set under Markets); a stock-heavy portfolio has
          historically swung about 15–20% a year. Same seed every time, so the figures only change when an assumption does. A model, not a forecast.
        </NotFigure>
      </p>
    </>
  );
}

function Fan({ f, s, dollars, setDollars }: Omit<FireProps, "d"> & { s: ReturnType<typeof stressTest> }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const { plan } = f;
  const data = useMemo(
    () =>
      s.bands.map((b) => {
        const k = 100 * deflator(plan, dollars, b.year);
        return { year: String(b.year), outer: [b.p10 / k, b.p90 / k], inner: [b.p25 / k, b.p75 / k], median: b.p50 / k, plan: b.plan / k };
      }),
    [s, plan, dollars],
  );
  return (
    <Card
      title="Net worth across 1,000 market paths"
      subtitle={<NotFigure why="what the chart bands mean">Jan 1 of each year, the plan as set (walk-away year included). The wide band holds 80% of paths, the narrow band the middle half; the line is the steady-return plan.</NotFigure>}
      actions={<DollarsToggle value={dollars} onChange={setDollars} />}
    >
      <div className="h-[340px] w-full min-w-0">
        <RechartsResponsive>
          <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="year" {...ui.xAxis} minTickGap={16} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip
              {...ui.tooltip}
              labelFormatter={(v) => `Jan 1, ${v}`}
              formatter={(v, name) => [Array.isArray(v) ? `${tipUsd(v[0])} – ${tipUsd(v[1])}` : tipUsd(v), String(name)]}
            />
            <Legend {...ui.legend} />
            <Area type="monotone" dataKey="outer" name="10th–90th percentile" stroke="none" fill={chart.series[0]} fillOpacity={0.15} isAnimationActive={false} />
            <Area type="monotone" dataKey="inner" name="25th–75th percentile" stroke="none" fill={chart.series[0]} fillOpacity={0.3} isAnimationActive={false} />
            <Line type="monotone" dataKey="median" name="Median path" stroke={chart.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="plan" name="Steady-return plan" stroke={chart.lineBalance} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {plan.walkAwayYear && <ReferenceLine x={String(plan.walkAwayYear)} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: "Walk away", fill: chart.legend, fontSize: 11, position: "insideTopLeft" }} />}
          </ComposedChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

function Odds({ s, f }: { s: ReturnType<typeof stressTest>; f: FireProps["f"] }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const last = s.fiByYear.findIndex((x) => x.share >= 0.99);
  const data = s.fiByYear.slice(0, last >= 0 ? Math.min(s.fiByYear.length, last + 3) : s.fiByYear.length).map((x) => ({ year: String(x.year), share: Math.round(x.share * 1000) / 10 }));
  return (
    <Card title="Chance you're financially independent by each year" subtitle="Share of market paths whose walk-away income covers living cost by Jan 1 of that year (keep working until then).">
      <div className="h-[260px] w-full min-w-0">
        <RechartsResponsive>
          <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="year" {...ui.xAxis} minTickGap={16} />
            <YAxis {...ui.yAxis} width={44} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip {...ui.tooltip} labelFormatter={(v) => `By Jan 1, ${v}`} formatter={(v) => [`${v}%`, "Chance of FI"]} />
            <ReferenceLine y={50} stroke={chart.axisLine} strokeDasharray="3 3" />
            <Area type="monotone" dataKey="share" name="Chance of FI" stroke={chart.series[2]} fill={chart.series[2]} fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
            {f.fi && <ReferenceLine x={String(f.fi.year)} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: `plan FI ${yearAge(f.fi.year, f.plan)}`, fill: chart.legend, fontSize: 11, position: "insideBottomRight" }} />}
          </AreaChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}
