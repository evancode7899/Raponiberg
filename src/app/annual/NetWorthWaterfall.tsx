"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { Card } from "@/components/ledger/LedgerBits";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Segmented } from "@/components/ui/kit";
import { formatUsd } from "@/lib/formatMoney";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { Col } from "./AnnualStatement";
import { axisUsd, usd } from "./profileUi";

type Step = { name: string; full: string; kind: "up" | "down" | "total"; delta: number; range: [number, number]; running: number; label: string };

const compact = (dollars: number, signed: boolean) => `${signed ? (dollars < 0 ? "−" : "+") : dollars < 0 ? "−" : ""}${axisUsd(Math.abs(dollars))}`;

/** A column's flows as waterfall steps: pay down to what was saved, then everything else that moved net worth. */
function steps(c: Col, partner: string | null): { steps: Step[]; open: number | null; close: number | null } | null {
  const w = c.y?.cash?.waterfall;
  const b = c.y ? c.y.bridge : c.est?.bridge;
  if (!b) return null;
  let flows: { label: string; full: string; cents: number }[];
  if (w) {
    flows = [
      { label: "Income", full: "Gross income", cents: w.grossCash },
      { label: "Taxes", full: "Taxes & deductions", cents: -(w.withholding + w.additionalTaxes - w.refunds + w.otherDeductions) },
      { label: "Employer", full: "Employer retirement & HSA", cents: w.employer },
      { label: `${partner ?? "Partner"} kept`, full: `${partner ?? "Partner"}'s pay kept in own accounts`, cents: -w.partnerKept },
      { label: "Living", full: "Living expenses", cents: -w.living },
      { label: "One-offs", full: "One-off expenses", cents: -w.nonRecurring },
    ];
  } else if (c.est) {
    const f = c.est.flows;
    flows = [
      { label: "Income", full: "Gross income", cents: (f.salary ?? 0) + (f.bonus ?? 0) + (f.otherIncome ?? 0) },
      { label: "Taxes", full: "Taxes & deductions", cents: -(f.taxes ?? 0) },
      { label: "Employer", full: "Employer retirement & HSA", cents: f.employer ?? 0 },
      { label: `${partner ?? "Partner"} kept`, full: `${partner ?? "Partner"}'s pay kept in own accounts`, cents: -c.est.partnerKept },
      { label: "Living", full: "Living expenses", cents: -((f.living ?? 0) + (f.bonusSpent ?? 0)) },
      { label: "One-offs", full: "One-off expenses", cents: -(f.oneOffs ?? 0) },
    ];
  } else return null;
  const moved = [
    { label: "Growth", full: "Investment growth, net of fees", cents: b.investmentGrowth },
    { label: "Outside", full: "Outside money", cents: b.outsideMoney },
    { label: "First on file", full: "Balances first on file", cents: b.newlyTracked },
    { label: "In transit", full: "Transfers in transit", cents: b.inTransit },
    { label: "Timing", full: "Timing: statements vs. paychecks", cents: b.unexplainedSavings },
  ];
  const out: Step[] = [];
  let run = 0;
  const add = (s: { label: string; full: string; cents: number }) => {
    // Leave out steps under $50 (a zero partner line, no one-offs): they'd be slivers.
    if (Math.abs(s.cents) < 50_00) return;
    const from = run;
    run += s.cents / 100;
    out.push({ name: s.label, full: s.full, kind: s.cents >= 0 ? "up" : "down", delta: s.cents / 100, range: [Math.min(from, run), Math.max(from, run)], running: run, label: compact(s.cents / 100, true) });
  };
  const total = (name: string, full: string, cents: number) => {
    run = cents / 100;
    out.push({ name, full, kind: "total", delta: run, range: [Math.min(0, run), Math.max(0, run)], running: run, label: compact(run, false) });
  };
  flows.forEach(add);
  total("Saved", "Saved incl. retirement", b.cashSaved);
  moved.forEach(add);
  total("Change", "Change in net worth", b.total);
  const close = c.y ? (c.y.netWorth?.netWorth ?? null) : (c.est?.flows.close?.netWorth ?? null);
  return { steps: out, open: close != null ? close - b.total : null, close };
}

/**
 * One year's change in net worth as a waterfall: gross income stepped down through taxes,
 * employer money and spending to what was saved, then growth, outside money and timing up
 * to the change in net worth. Every bar is a line of the statement above.
 */
export function NetWorthWaterfall({ r, cols }: { r: AnnualProfileReport; cols: Col[] }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const partner = r.persons.length > 1 ? r.persons.slice(1).map((p) => p.name).join(" & ") : null;
  const usable = cols.filter((c) => steps(c, partner));
  const [pick, setPick] = useState<string | null>(null);
  const col = usable.find((c) => c.key === pick) ?? usable.at(-1);
  if (!col) return null;
  const s = steps(col, partner)!;
  const color = (k: Step["kind"]) => (k === "up" ? chart.income : k === "down" ? chart.spending : chart.neutral);
  return (
    <Card
      title={`What moved net worth · ${col.head}`}
      subtitle={
        s.open != null && s.close != null ? (
          <>
            {usd(s.open)} on Jan 1 → {usd(s.close)} {col.est ? "estimated for Dec 31" : col.y?.isCurrent ? `on ${col.y.netWorthAsOf}` : "on Dec 31"}. Income steps down to what was saved, then growth and outside money
            step up to the change.
          </>
        ) : undefined
      }
      actions={<Segmented ariaLabel="Year" size="xs" value={col.key} onChange={setPick} options={usable.map((c) => ({ value: c.key, label: c.head }))} />}
    >
      <div className="h-[340px] w-full min-w-0" role="img" aria-label={`Waterfall of ${col.head}: ${s.steps.map((x) => `${x.full} ${x.label}`).join(", ")}`}>
        <RechartsResponsive>
          <BarChart data={s.steps} margin={{ top: 20, right: 8, left: 8, bottom: 4 }} barCategoryGap="18%">
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="name" {...ui.xAxis} interval={0} tick={{ ...ui.xAxis.tick, fontSize: 10.5 }} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <ReferenceLine y={0} stroke={chart.axisLine} />
            <Tooltip
              {...ui.tooltip}
              content={({ active, payload }) => {
                const d = active ? (payload?.[0]?.payload as Step | undefined) : undefined;
                if (!d) return null;
                return (
                  <div style={ui.tooltip.contentStyle}>
                    <div style={ui.tooltip.labelStyle}>{d.full}</div>
                    <div className="num">{d.kind === "total" ? formatUsd(Math.round(d.delta)) : `${d.delta < 0 ? "−" : "+"}${formatUsd(Math.round(Math.abs(d.delta)))}`}</div>
                    {d.kind !== "total" && <div className="num opacity-70">running total {formatUsd(Math.round(d.running))}</div>}
                  </div>
                );
              }}
            />
            <Bar dataKey="range" isAnimationActive={false} radius={3}>
              {s.steps.map((x, i) => (
                <Cell key={i} fill={color(x.kind)} fillOpacity={col.est && x.kind !== "total" ? 0.8 : 1} />
              ))}
              {/* Value labels collide on a phone: there the tooltip carries them. */}
              <LabelList dataKey="label" position="top" className="max-sm:hidden" style={{ fill: chart.axis, fontSize: 10.5 }} />
            </Bar>
          </BarChart>
        </RechartsResponsive>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {(
          [
            ["up", "Adds"],
            ["down", "Takes away"],
            ["total", "Saved / change in net worth"],
          ] as const
        ).map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color(k) }} />
            {label}
          </span>
        ))}
      </div>
    </Card>
  );
}
