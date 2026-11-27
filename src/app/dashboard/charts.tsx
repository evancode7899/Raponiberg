"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { axisUsd, formatUsd, NA } from "@/lib/formatMoney";
import { averageOf, type ProofRef } from "@/components/ui/proof/context";
import { noFigure } from "@/lib/book/proof/clearance";

/** A month-end's net worth as Net worth proves it (its How it was built balances). */
const monthEnd = (end: string, cents: number): ProofRef => ({ descriptor: { report: "net-worth", metric: "balance", date: end }, shownCents: cents });
/** A month's income or spending as Cash flow proves it. */
const cashMonth = (metric: "income" | "spending", start: string, end: string, cents: number): ProofRef => ({ descriptor: { report: "cash-flow", metric, granularity: "month", start, end }, shownCents: cents });
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

/** The desk's charts share one crosshair: pointing at a month in one marks it in the others. */
const SYNC = { syncId: "desk", syncMethod: "value" as const };

export type Range = "6m" | "12m" | "all";
const SHOWN: Record<Range, number> = { "6m": 6, "12m": 12, all: Infinity };
const shortMonth = (l: string) => l.replace(/ 20(\d\d)$/, " ’$1");

/** Month-end net worth, straight between month-ends (nothing is known in between), with its high marked and a flag on months something happened in (its words in the tooltip). */
export function NetWorthLine({ series, events, range, average }: { series: { end: string; label: string; cents: number | null }[]; events: { label: string; text: string }[]; range: Range; average: boolean }) {
  const p = useChartPalette();
  const ui = chartChrome(p);
  const from = Number.isFinite(SHOWN[range]) ? Math.max(0, series.length - SHOWN[range]) : 0;
  const rows = series.slice(from).map((x, i) => {
    const last = series.slice(Math.max(0, from + i - 2), from + i + 1).map((y) => y.cents);
    const avg = last.length === 3 && last.every((v) => v != null) ? (last[0]! + last[1]! + last[2]!) / 300 : null;
    return { at: from + i, label: x.label, value: x.cents == null ? null : x.cents / 100, avg };
  });
  // A point's proof: its month-end, or the three month-ends averaged.
  const pointProof = (r: Record<string, unknown>, key: string): ProofRef => {
    const at = r.at as number;
    const ends = key === "avg" ? series.slice(at - 2, at + 1) : [series[at]!];
    if (ends.some((x) => x.cents == null)) return noFigure("a month-end that can't be proven");
    return averageOf(ends.map((x) => monthEnd(x.end, x.cents!)), ends.reduce((t, x) => t + x.cents!, 0));
  };
  const said = new Map<string, string[]>();
  for (const e of events) said.set(e.label, [...(said.get(e.label) ?? []), e.text]);
  const flags = rows.filter((r) => r.value != null && said.has(r.label));
  const high = rows.filter((r) => r.value != null).sort((a, b) => b.value! - a.value!)[0];
  return (
    <div className="absolute inset-0 p-1">
      <RechartsResponsive tableTitle="Net worth by month-end" cellProof={pointProof}>
        <ComposedChart data={rows} {...SYNC} margin={{ top: 14, right: 14, left: 0, bottom: 0 }}>
          <CartesianGrid {...ui.grid} />
          <XAxis dataKey="label" {...ui.xAxis} minTickGap={36} height={20} />
          <YAxis {...ui.yAxis} width={54} tickFormatter={axisUsd} domain={["auto", "auto"]} />
          <Tooltip {...ui.tooltip} cursor={{ stroke: p.axis, strokeDasharray: "3 3" }} labelFormatter={(l) => (said.has(String(l)) ? `${l} · ${said.get(String(l))!.join(" · ")}` : String(l))} formatter={(v, name) => [formatUsd(Math.round(Number(v))), name === "avg" ? "3-month average" : "Net worth"]} />
          <Area type="linear" dataKey="value" stroke={p.series[0]} strokeWidth={1.75} fill={p.series[0]} fillOpacity={0.12} isAnimationActive={false} activeDot={{ r: 3 }} />
          {average && <Line type="linear" dataKey="avg" stroke={p.series[1]} strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
          {flags.map((f) => (
            <ReferenceDot key={f.label} x={f.label} y={f.value!} shape={(d: { cx?: number; cy?: number }) => <path d={`M${(d.cx ?? 0) - 4},${(d.cy ?? 0) - 12}h8l-4,6z`} fill={p.series[1]} />} />
          ))}
          {high && <ReferenceDot x={high.label} y={high.value!} r={3.5} fill="none" stroke={p.lineBalance} label={{ value: "high", position: "left", fill: p.axis, fontSize: 11 }} />}
        </ComposedChart>
      </RechartsResponsive>
    </div>
  );
}

export type CashMonth = { label: string; start?: string; end?: string; income: number | null; spending: number | null };

/** Where the scale stops: past the third-largest bar, so a bonus month or two doesn't flatten the rest. Null when none stands out. */
export function cashCap(months: CashMonth[]): number | null {
  const all = months
    .flatMap((m) => [m.income, m.spending])
    .filter((v): v is number => v != null)
    .sort((a, b) => b - a);
  const ref = all[Math.min(2, all.length - 1)];
  return ref && all[0]! > ref * 1.6 ? Math.ceil((ref * 1.15) / 1000) * 1000 : null;
}

/** The hatch of a bar cut at the scale. */
export function OverPattern({ id, color, bg }: { id: string; color: string; bg: string }) {
  return (
    <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill={color} />
      <line x1="0" y1="0" x2="0" y2="5" stroke={bg} strokeWidth="2" />
    </pattern>
  );
}

/** The months past the scale, named: what each was, so a cut bar's amount is still on the page. */
export function pastScale<M extends { incomeCents: number | null; spendingCents: number | null }>(months: M[], cap: number | null): { m: M; what: "income" | "spending"; cents: number }[] {
  if (cap == null) return [];
  return months.flatMap((m) =>
    (["income", "spending"] as const).flatMap((what) => {
      const cents = what === "income" ? m.incomeCents : m.spendingCents;
      return cents != null && cents / 100 > cap ? [{ m, what, cents }] : [];
    }),
  );
}

/** Income and spending by month; a bar past the scale is cut there and hatched, and the panel lists it. */
export function CashBars({ months, cap }: { months: CashMonth[]; cap: number | null }) {
  const p = useChartPalette();
  const ui = chartChrome(p);
  const past = (v: number | null) => cap != null && v != null && v > cap;
  const rows = months.map((m) => ({ label: m.label, income: past(m.income) ? cap : m.income, spending: past(m.spending) ? cap : m.spending, raw: m }));
  return (
    <RechartsResponsive
      tableTitle="Income and spending by month"
      cellValue={(r, key) => (r as (typeof rows)[number]).raw[key === "income" ? "income" : "spending"]}
      cellProof={(r, key) => {
        const m = (r as (typeof rows)[number]).raw;
        const v = key === "income" ? m.income : m.spending;
        return v == null || !m.start || !m.end ? noFigure("a month that can't be proven") : cashMonth(key === "income" ? "income" : "spending", m.start, m.end, Math.round(v * 100));
      }}
    >
      <ComposedChart data={rows} {...SYNC} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={1}>
        <defs>
          <OverPattern id="deskOver" color={p.income} bg={p.tooltipBg} />
          <OverPattern id="deskOverSpent" color={p.spending} bg={p.tooltipBg} />
        </defs>
        <CartesianGrid {...ui.grid} />
        <XAxis dataKey="label" {...ui.xAxis} height={20} minTickGap={14} tickFormatter={shortMonth} />
        <YAxis {...ui.yAxis} width={50} tickFormatter={axisUsd} domain={[0, cap ?? "auto"]} />
        <Tooltip
          {...ui.tooltip}
          formatter={(_v, name, item) => {
            const raw = (item.payload as (typeof rows)[number]).raw;
            const v = name === "income" ? raw.income : raw.spending;
            return [v == null ? NA : formatUsd(Math.round(v)), name === "income" ? "Income" : "Spending"];
          }}
        />
        {cap != null && <ReferenceLine y={cap} stroke={p.axisLine} strokeDasharray="2 3" />}
        <Bar dataKey="income" maxBarSize={20} isAnimationActive={false} fill={p.income}>
          {rows.map((r) => (
            <Cell key={r.label} fill={past(r.raw.income) ? "url(#deskOver)" : p.income} />
          ))}
        </Bar>
        <Bar dataKey="spending" maxBarSize={20} isAnimationActive={false} fill={p.spending}>
          {rows.map((r) => (
            <Cell key={r.label} fill={past(r.raw.spending) ? "url(#deskOverSpent)" : p.spending} />
          ))}
        </Bar>
      </ComposedChart>
    </RechartsResponsive>
  );
}
