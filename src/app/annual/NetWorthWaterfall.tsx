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
type Flow = { label: string; full: string; cents: number };
/** A column's statement lines: pay down to what was saved, then everything else that moved net worth. */
type Lines = { flows: Flow[]; saved: number; moved: Flow[]; total: number; open: number | null; close: number | null };

const LTD = "ltd";

const compact = (dollars: number, signed: boolean) => `${signed ? (dollars < 0 ? "−" : "+") : dollars < 0 ? "−" : ""}${axisUsd(Math.abs(dollars))}`;

/** A column's lines, or (no column) life to date's, which the report sums. */
function lines(c: Col | null, r: AnnualProfileReport, partner: string | null): Lines | null {
  const ltd = c ? null : r.lifeToDate;
  const w = ltd ? ltd.waterfall : c?.y?.cash?.waterfall;
  const b = ltd ? ltd.bridge : c?.y ? c.y.bridge : c?.est?.bridge;
  if (!b) return null;
  let flows: Flow[];
  if (w) {
    flows = [
      { label: "Income", full: "Gross income", cents: w.grossCash },
      { label: "Taxes", full: "Taxes & deductions", cents: -(w.withholding + w.additionalTaxes - w.refunds + w.otherDeductions) },
      { label: "Employer", full: "Employer retirement & HSA", cents: w.employer },
      { label: `${partner ?? "Partner"} kept`, full: `${partner ?? "Partner"}'s pay kept in own accounts`, cents: -w.partnerKept },
      { label: "Living", full: "Living expenses", cents: -w.living },
      { label: "One-offs", full: "One-off expenses", cents: -w.nonRecurring },
    ];
  } else if (c?.est) {
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
  const close = ltd ? ltd.close : c?.y ? (c.y.netWorth?.netWorth ?? null) : (c?.est?.flows.close?.netWorth ?? null);
  return { flows, saved: b.cashSaved, moved, total: b.total, open: ltd ? ltd.open : close != null ? close - b.total : null, close };
}

/** Statement lines as waterfall steps. */
function steps(l: Lines): Step[] {
  const out: Step[] = [];
  let run = 0;
  const add = (s: Flow) => {
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
  l.flows.forEach(add);
  total("Saved", "Saved incl. retirement", l.saved);
  l.moved.forEach(add);
  total("Change", "Change in net worth", l.total);
  return out;
}

/**
 * One year's (or life to date's) change in net worth as a waterfall: gross income stepped down
 * through taxes, employer money and spending to what was saved, then growth, outside money and
 * timing up to the change in net worth. Every bar is a line of the statement above, or its sum.
 */
export function NetWorthWaterfall({ r, cols }: { r: AnnualProfileReport; cols: Col[] }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const partner = r.persons.length > 1 ? r.persons.slice(1).map((p) => p.name).join(" & ") : null;
  const usable = cols.filter((c) => lines(c, r, partner));
  // Life to date's years, as the statement's columns (the year to date, never the estimate).
  const ltd = r.lifeToDate ? { cols: cols.filter((c) => c.y && r.lifeToDate!.years.includes(c.y.year)) } : null;
  const [pick, setPick] = useState<string | null>(null);
  const col = pick === LTD && ltd ? null : (usable.find((c) => c.key === pick) ?? usable.at(-1) ?? null);
  const l = lines(col, r, partner);
  if (!l) return null;
  const s = steps(l);
  const first = ltd?.cols[0];
  const last = ltd?.cols.at(-1);
  const head = col ? col.head : `Life to date · ${first!.head}–${last!.head}`;
  const endOf = (c: Col) => (c.est ? "estimated for Dec 31" : c.y?.isCurrent ? `on ${c.y.netWorthAsOf}` : col ? "on Dec 31" : `on Dec 31, ${c.y!.year}`);
  const color = (k: Step["kind"]) => (k === "up" ? chart.income : k === "down" ? chart.spending : chart.neutral);
  return (
    <Card
      title={`What moved net worth · ${head}`}
      subtitle={
        l.open != null && l.close != null ? (
          <>
            {usd(l.open)} on Jan 1{col ? "" : `, ${first!.y!.year}`} → {usd(l.close)} {endOf(col ?? last!)}.{" "}
            {col
              ? "Income steps down to what was saved, then growth and outside money step up to the change."
              : `Each line summed over ${ltd!.cols.length} years of statements${cols.some((c) => c.est) ? "; the estimate is left out" : ""}.`}
          </>
        ) : undefined
      }
      actions={
        <Segmented view
          ariaLabel="Year"
          size="xs"
          value={col?.key ?? LTD}
          onChange={setPick}
          options={[...usable.map((c) => ({ value: c.key, label: c.head })), ...(ltd ? [{ value: LTD, label: "Life to date", title: `${first!.head}–${last!.head}, each line summed` }] : [])]}
        />
      }
    >
      <div className="h-[340px] w-full min-w-0" role="img" aria-label={`Waterfall of ${head}: ${s.map((x) => `${x.full} ${x.label}`).join(", ")}`}>
        <RechartsResponsive>
          <BarChart data={s} margin={{ top: 20, right: 8, left: 8, bottom: 4 }} barCategoryGap="18%">
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
              {s.map((x, i) => (
                <Cell key={i} fill={color(x.kind)} fillOpacity={col?.est && x.kind !== "total" ? 0.8 : 1} />
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
