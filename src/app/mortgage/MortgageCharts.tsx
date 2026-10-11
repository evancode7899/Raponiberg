"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, type ChartPalette } from "@/components/shell/chartPalette";
import { axisUsd, formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

export const INVEST = "Invest the extra";
export const PREPAY = "Pay down the loan";

/** One point per year-end (and the horizon), already in display dollars. */
export type YearPoint = {
  year: number;
  investNW: number;
  prepayNW: number;
  gap: number;
  investBal: number;
  prepayBal: number;
  investInv: number;
  prepayInv: number;
  band90?: [number, number];
  band50?: [number, number];
  p50?: number;
};

const yearTick = (v: number) => `Y${+v.toFixed(1)}`;
const signed = (v: number) => (v > 0 ? `+${formatUsd(v)}` : formatUsd(v));

function Frame({ children, h = 280 }: { children: React.ReactElement; h?: number }) {
  return (
    <div className="w-full min-w-0" style={{ height: h }}>
      <RechartsResponsive>{children}</RechartsResponsive>
    </div>
  );
}

export function NetWorthChart({ rows, chart, payoffYear, label }: { rows: YearPoint[]; chart: ChartPalette; payoffYear: number | null; label: (y: number) => string }) {
  const ui = chartChrome(chart);
  return (
    <Frame>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid {...ui.grid} />
        <XAxis dataKey="year" type="number" domain={["dataMin", "dataMax"]} {...ui.xAxis} tickFormatter={yearTick} allowDecimals={false} />
        <YAxis {...ui.yAxis} tickFormatter={axisUsd} width={64} />
        <Tooltip {...ui.tooltip} labelFormatter={(l) => label(Number(l))} formatter={(v, n) => [formatUsd(Number(v)), n]} />
        <Legend {...ui.legend} />
        <ReferenceLine y={0} stroke={chart.axisLine} />
        {payoffYear !== null && (
          <ReferenceLine x={payoffYear} stroke={chart.series[1]} strokeDasharray="3 3" label={{ value: "Paid off early", position: "insideTopLeft", fontSize: 10, fill: chart.axis }} />
        )}
        <Line name={INVEST} type="monotone" dataKey="investNW" stroke={chart.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line name={PREPAY} type="monotone" dataKey="prepayNW" stroke={chart.series[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

/** Invest − prepay: the expected line, and the 50% / 80% ranges across simulated markets. */
export function GapChart({ rows, chart, label }: { rows: YearPoint[]; chart: ChartPalette; label: (y: number) => string }) {
  const ui = chartChrome(chart);
  return (
    <Frame>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid {...ui.grid} />
        <XAxis dataKey="year" type="number" domain={["dataMin", "dataMax"]} {...ui.xAxis} tickFormatter={yearTick} allowDecimals={false} />
        <YAxis {...ui.yAxis} tickFormatter={axisUsd} width={64} />
        <Tooltip
          {...ui.tooltip}
          labelFormatter={(l) => label(Number(l))}
          formatter={(v, n) => {
            if (Array.isArray(v)) return [`${signed(Number(v[0]))} to ${signed(Number(v[1]))}`, n];
            return [signed(Number(v)), n];
          }}
        />
        <Legend {...ui.legend} />
        <Area name="80% of markets" dataKey="band90" stroke="none" fill={chart.series[0]} fillOpacity={0.12} isAnimationActive={false} />
        <Area name="Middle 50%" dataKey="band50" stroke="none" fill={chart.series[0]} fillOpacity={0.22} isAnimationActive={false} />
        <ReferenceLine y={0} stroke={chart.lineBalance} strokeWidth={1} label={{ value: "Tie", position: "insideBottomLeft", fontSize: 10, fill: chart.axis }} />
        <Line name="Median market" dataKey="p50" stroke={chart.series[0]} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Line name="At the expected return" dataKey="gap" stroke={chart.lineBalance} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </Frame>
  );
}

/** Loan balance and investments for both paths: where the same dollars end up. */
export function BalancesChart({ rows, chart, label }: { rows: YearPoint[]; chart: ChartPalette; label: (y: number) => string }) {
  const ui = chartChrome(chart);
  return (
    <Frame>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid {...ui.grid} />
        <XAxis dataKey="year" type="number" domain={["dataMin", "dataMax"]} {...ui.xAxis} tickFormatter={yearTick} allowDecimals={false} />
        <YAxis {...ui.yAxis} tickFormatter={axisUsd} width={64} />
        <Tooltip {...ui.tooltip} labelFormatter={(l) => label(Number(l))} formatter={(v, n) => [formatUsd(Number(v)), n]} />
        <Legend {...ui.legend} />
        <Line name="Investments · invest" dataKey="investInv" stroke={chart.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line name="Loan · invest" dataKey="investBal" stroke={chart.series[0]} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        <Line name="Investments · pay down" dataKey="prepayInv" stroke={chart.series[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line name="Loan · pay down" dataKey="prepayBal" stroke={chart.series[1]} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

/** Advantage at the horizon across investment returns, with the tie point marked. */
export function SensitivityChart({
  rows,
  chart,
  assumed,
  breakEven,
  mortgageRate,
}: {
  rows: { rate: number; advantage: number }[];
  chart: ChartPalette;
  assumed: number;
  breakEven: number | null;
  mortgageRate: number;
}) {
  const ui = chartChrome(chart);
  return (
    <Frame h={240}>
      <ComposedChart data={rows} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid {...ui.grid} />
        <XAxis dataKey="rate" type="number" domain={[0, 0.12]} {...ui.xAxis} tickFormatter={(v: number) => `${+(v * 100).toFixed(1)}%`} ticks={[0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12]} />
        <YAxis {...ui.yAxis} tickFormatter={axisUsd} width={64} />
        <Tooltip {...ui.tooltip} labelFormatter={(l) => `Investments earn ${formatPercentRatio(Number(l), 1)} a year`} formatter={(v) => [signed(Number(v)), "Invest − pay down"]} />
        <ReferenceLine y={0} stroke={chart.lineBalance} />
        <ReferenceLine x={mortgageRate} stroke={chart.axisLine} strokeDasharray="2 3" label={{ value: "Loan rate", position: "insideBottomRight", fontSize: 10, fill: chart.axis }} />
        {breakEven !== null && breakEven >= 0 && breakEven <= 0.12 && (
          <ReferenceLine x={breakEven} stroke={chart.series[2]} strokeDasharray="4 3" label={{ value: "Break-even", position: "insideTopRight", fontSize: 10, fill: chart.axis }} />
        )}
        <ReferenceLine x={assumed} stroke={chart.series[0]} label={{ value: "Your assumption", position: "insideTopLeft", fontSize: 10, fill: chart.axis }} />
        <Line dataKey="advantage" stroke={chart.lineBalance} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </Frame>
  );
}

/** What sending each source of cash to the loan costs (or earns) by the horizon. */
export function OpportunityChart({ rows, chart }: { rows: { key: string; label: string; cost: number }[]; chart: ChartPalette }) {
  const ui = chartChrome(chart);
  // Two lumps can share a label, so the category is the row's key.
  const labelOf = new Map(rows.map((r) => [r.key, r.label]));
  return (
    <Frame h={Math.max(120, 44 * rows.length + 40)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }} barCategoryGap={8}>
        <CartesianGrid {...ui.grid} horizontal={false} vertical />
        <XAxis type="number" {...ui.xAxis} tickFormatter={axisUsd} />
        <YAxis type="category" dataKey="key" {...ui.yAxis} width={170} tick={{ ...ui.yAxis.tick, fontSize: 11 }} tickFormatter={(k: string) => labelOf.get(k) ?? k} />
        <Tooltip
          {...ui.tooltip}
          labelFormatter={(k) => labelOf.get(String(k)) ?? String(k)}
          formatter={(v) => {
            const n = Number(v);
            return [n >= 0 ? `${formatUsd(n)} less than investing it` : `${formatUsd(-n)} more than investing it`, "Sent to the loan"];
          }}
        />
        <ReferenceLine x={0} stroke={chart.lineBalance} />
        <Bar dataKey="cost" radius={4} isAnimationActive={false} maxBarSize={22}>
          {rows.map((r) => (
            <Cell key={r.key} fill={r.cost >= 0 ? chart.series[0] : chart.series[1]} />
          ))}
        </Bar>
      </BarChart>
    </Frame>
  );
}
