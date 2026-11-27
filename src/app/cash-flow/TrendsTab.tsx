"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { crosshair, endLabel as lineEnd, useLegendHighlight, useZoom, ZoomReset } from "@/components/charts/interact";
import { last12At, momentumCategories, momentumWindows } from "@/lib/book/reports/cashFlowWindows";
import { windowKey } from "@/lib/book/derived/cashFlow";
import { chartChrome } from "@/components/shell/chartPalette";
import { Card, NotFigure, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { SpendingMonth } from "@/lib/book/reports/spending";
import { axisUsd, formatPercentRatio, formatUsd, NA, usd0, usdDelta } from "@/lib/formatMoney";
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, Brush, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { Ctx } from "./CashFlowClient";
import { categoryGroup, KINDS, sliceStart, sum, trailing } from "./model";
import { categoryColor, Delta, DivergingBar, Dot, openMonthOnClick } from "./parts";
import { noFigure } from "@/lib/book/proof/clearance";
import { monthProof, runAverage, runsSum, runSum, savingsRateOf, shareOf, type MonthPick } from "./cells";

type Metric = "all" | "everyday";
const GROUPS = ["Essentials", "Lifestyle", "Financial"] as const;
const pctAxis = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Where spending is heading rather than what any one month did: trailing averages that
 * smooth out lumpy months, the mix of bills, everyday and one-off spending, and whether
 * spending grows faster than income. Trailing figures reach back before the selected
 * range, so its first months are smoothed too.
 */
export function TrendsTab({ ctx }: { ctx: Ctx }) {
  const { report, slice, chart } = ctx;
  const ui = chartChrome(chart);
  const [metric, setMetric] = useState<Metric>("all");
  const [kindView, setKindView] = useState<"usd" | "share">("usd");
  const all = report.months;
  const lo = sliceStart(report, slice);
  const hi = lo + slice.months.length - 1;

  const pick = (m: SpendingMonth) => (metric === "all" ? m.spendingCents : m.kinds.everydayCents);
  const t3 = trailing(all, 3, pick);
  const t12 = trailing(all, 12, pick);
  const smooth = slice.months.map((m, i) => ({
    at: lo + i,
    label: m.label,
    month: pick(m) / 100,
    avg3: t3[lo + i] == null ? null : t3[lo + i]! / 300,
    avg12: t12[lo + i] == null ? null : t12[lo + i]! / 1200,
    // The same 12-month average a year before, drawn dashed under it to compare.
    avg12Before: t12[lo + i - 12] == null ? null : t12[lo + i - 12]! / 1200,
  }));

  // Headline: the last twelve months against the twelve before.
  const spend12 = trailing(all, 12, (m) => m.spendingCents);
  const inc12 = trailing(all, 12, (m) => m.incomeCents);
  const every12 = trailing(all, 12, (m) => m.kinds.everydayCents);
  const every3 = trailing(all, 3, (m) => m.kinds.everydayCents);
  const prevAt = (xs: (number | null)[]) => (hi >= 12 ? xs[hi - 12] ?? null : null);
  const rate = (inc: number | null, sp: number | null) => (inc && sp != null && inc > 0 ? (inc - sp) / inc : null);
  const rateNow = rate(inc12[hi] ?? null, spend12[hi] ?? null);
  const rateBefore = rate(prevAt(inc12), prevAt(spend12));
  const endLabel = slice.months.at(-1)!.label;
  // The twelve months the trailing totals at the end of the range sum (none until twelve exist).
  const last12 = last12At(all, hi);
  // The twelve before them, and the last three: the runs the tiles compare with.
  const prev12 = hi >= 12 ? last12At(all, hi - 12) : [];
  const last3 = all.slice(Math.max(0, hi - 2), hi + 1);
  const vs12 = (metric: "income" | "spending", xs: (number | null)[]) =>
    prevAt(xs) != null && xs[hi] != null ? { of: [ctx.proof(metric, last12, { shownCents: xs[hi]! }), ctx.proof(metric, prev12, { shownCents: prevAt(xs)! })] as [ProofRef, ProofRef] } : {};

  const kinds = slice.months.map((m) => {
    const total = Math.max(1, m.spendingCents);
    const v = (c: number) => (kindView === "usd" ? c / 100 : c / total);
    return { m, label: m.label, billCents: v(m.kinds.billCents), everydayCents: v(m.kinds.everydayCents), bigCents: v(m.kinds.bigCents) };
  });
  const kindTotals = KINDS.map((k) => ({ ...k, cents: sum(slice.months, (m) => m.kinds[k.id]) }));
  const spent = sum(slice.months, (m) => m.spendingCents);

  // Income and spending over the trailing twelve months, indexed to the first month both exist.
  const base = slice.months.findIndex((_, i) => spend12[lo + i] != null && inc12[lo + i]);
  const growth =
    base < 0
      ? []
      : slice.months.slice(base).map((m, j) => {
          const i = lo + base + j;
          return { at: i, label: m.label, income: (inc12[i]! / inc12[lo + base]!) * 100, spending: (spend12[i]! / spend12[lo + base]!) * 100, rate: rate(inc12[i]!, spend12[i]!) };
        });

  // Group mix over three-month runs, so one big month doesn't swing the share.
  const groupMix = slice.months.map((m, i) => {
    const run = all.slice(Math.max(0, lo + i - 2), lo + i + 1);
    const by = Object.fromEntries(GROUPS.map((g) => [g, sum(run, (x) => sum(x.spendingByCategory.filter((c) => categoryGroup(c.category) === g), (c) => c.cents))]));
    const total = Math.max(1, sum([...GROUPS], (g) => Math.max(0, by[g]!)));
    return { run, by, label: m.label, ...Object.fromEntries(GROUPS.map((g) => [g, Math.max(0, by[g]!) / total])) };
  });

  // Each chart point's proof (cells.ts): the months the sweep proves, added up, averaged or divided.
  const pickOf: MonthPick = metric === "all" ? { metric: "spending" } : { metric: "spending", spendingKind: "everyday" };
  const runTo = (i: number, n: number) => (i - n + 1 >= 0 ? all.slice(i - n + 1, i + 1) : []);
  const smoothProof = (r: Record<string, unknown>, key: string): ProofRef => {
    const at = r.at as number;
    if (key === "month") return monthProof(ctx.proof, all[at]!, pickOf);
    const run = key === "avg3" ? runTo(at, 3) : key === "avg12" ? runTo(at, 12) : runTo(at - 12, 12);
    return runAverage(ctx.proof, run, pickOf);
  };
  const KIND_OF = Object.fromEntries(KINDS.map((k) => [k.id, k.kind])) as Record<string, MonthPick["spendingKind"]>;
  const kindProof = (r: Record<string, unknown>, key: string): ProofRef => {
    const m = r.m as SpendingMonth;
    const part = monthProof(ctx.proof, m, { metric: "spending", spendingKind: KIND_OF[key] });
    if (kindView === "usd") return part;
    return shareOf(part, monthProof(ctx.proof, m, { metric: "spending" }), m.kinds[key as keyof SpendingMonth["kinds"]], m.spendingCents);
  };
  // An index of 100 at the first month: each trailing twelve months' total as a share of that first one.
  const growthProof = (r: Record<string, unknown>, key: string): ProofRef => {
    const at = r.at as number;
    if (key === "rate") return savingsRateOf(ctx.proof, runTo(at, 12));
    const p: MonthPick = { metric: key === "income" ? "income" : "spending" };
    const xs = key === "income" ? inc12 : spend12;
    return shareOf(runSum(ctx.proof, runTo(at, 12), p), runSum(ctx.proof, runTo(lo + base, 12), p), xs[at]!, xs[lo + base]!);
  };
  const groupProof = (r: Record<string, unknown>, key: string): ProofRef => {
    const run = r.run as SpendingMonth[];
    const by = r.by as Record<string, number>;
    if (by[key]! <= 0) return noFigure("the group took in as much as it spent", true);
    const picks = (g: string) => [...new Set(run.flatMap((x) => x.spendingByCategory.filter((c) => categoryGroup(c.category) === g).map((c) => c.category)))].map((c): MonthPick => ({ metric: "spending", category: c }));
    const whole = runsSum(ctx.proof, run, GROUPS.filter((g) => by[g]! > 0).flatMap(picks));
    return shareOf(runsSum(ctx.proof, run, picks(key)), whole, by[key]!, GROUPS.reduce((t, g) => t + Math.max(0, by[g]!), 0));
  };

  const smoothLit = useLegendHighlight();
  const growthZoom = useZoom(growth.length, chart);
  const growthLit = useLegendHighlight();

  return (
    <>
      <StatGrid cols={4}>
        <StatCell
          label="Spending, last 12 months"
          value={spend12[hi] == null ? NA : usd0(spend12[hi])}
          proof={spend12[hi] == null ? noFigure("not twelve proven months yet") : ctx.proof("spending", last12, { shownCents: spend12[hi]! })}
          sub={
            <>
              <Delta now={spend12[hi] ?? 0} before={prevAt(spend12)} goodWhenDown {...vs12("spending", spend12)} /> vs the 12 before
              {prevAt(spend12) != null ? (
                <>
                  {" "}(<ProofValue proof={ctx.proof("spending", prev12, { shownCents: prevAt(spend12)! })}>{usd0(prevAt(spend12))}</ProofValue>)
                </>
              ) : null}
            </>
          }
        />
        <StatCell
          label="Income, last 12 months"
          value={inc12[hi] == null ? NA : usd0(inc12[hi])}
          proof={inc12[hi] == null ? noFigure("not twelve proven months yet") : ctx.proof("income", last12, { shownCents: inc12[hi]! })}
          sub={
            <>
              <Delta now={inc12[hi] ?? 0} before={prevAt(inc12)} {...vs12("income", inc12)} /> vs the 12 before
              {prevAt(inc12) != null ? (
                <>
                  {" "}(<ProofValue proof={ctx.proof("income", prev12, { shownCents: prevAt(inc12)! })}>{usd0(prevAt(inc12))}</ProofValue>)
                </>
              ) : null}
            </>
          }
        />
        <StatCell
          label="Savings rate, last 12 months"
          proof={rateNow == null ? noFigure("not twelve proven months yet") : ctx.dp("savings-rate", windowKey(last12))}
          value={rateNow == null ? NA : formatPercentRatio(rateNow, 0)}
          tone={rateNow == null ? "neutral" : rateNow >= 0.2 ? "pos" : rateNow < 0 ? "neg" : "neutral"}
          sub={
            rateBefore == null ? (
              `through ${endLabel}`
            ) : (
              <>
                <ProofValue proof={ctx.dp("savings-rate", windowKey(prev12))}>{formatPercentRatio(rateBefore, 0)}</ProofValue> the 12 months before
              </>
            )
          }
        />
        <StatCell
          label="Everyday spending, last 3 months"
          value={every3[hi] == null ? NA : `${usd0(every3[hi]! / 3)}/mo`}
          proof={every3[hi] == null ? noFigure("not twelve proven months yet") : ctx.proof("spending", all.slice(hi - 2, hi + 1), { spendingKind: "everyday", perMonth: true, shownCents: every3[hi]! })}
          sub={
            every12[hi] == null ? (
              "bills and big one-offs left out"
            ) : (
              <>
                <Delta
                  now={every3[hi]! / 3}
                  before={every12[hi]! / 12}
                  goodWhenDown
                  of={[ctx.proof("spending", last3, { spendingKind: "everyday", shownCents: every3[hi]! }), ctx.proof("spending", last12, { spendingKind: "everyday", shownCents: every12[hi]! })]}
                  per={[3, 12]}
                />{" "}
                vs the 12-month pace (<ProofValue proof={ctx.proof("spending", last12, { spendingKind: "everyday", perMonth: true, shownCents: every12[hi]! })}>{usd0(every12[hi]! / 12)}</ProofValue>/mo)
              </>
            )
          }
        />
      </StatGrid>

      <Card
        title="Spending, smoothed"
        subtitle={`Bars are single months; the lines are trailing 3- and 12-month averages, which show the direction once lumpy months (tax payments, a big purchase) wash out. ${
          metric === "everyday" ? <NotFigure why="what everyday counts: the app's one-off rule">Everyday leaves out rent and recurring bills, charges of $1,500+, taxes, and big merchant refunds.</NotFigure> : ""
        } Click a month to audit it.`}
        actions={
          <Segmented view
            size="xs"
            ariaLabel="Which spending"
            options={[
              { value: "all", label: "All spending" },
              { value: "everyday", label: "Everyday only" },
            ]}
            value={metric}
            onChange={setMetric}
          />
        }
      >
        <div className="h-[300px] w-full min-w-0">
          <RechartsResponsive tableTitle="Spending, smoothed, month by month" cellProof={smoothProof}>
            <ComposedChart data={smooth} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} className="cursor-pointer" onClick={openMonthOnClick(ctx, slice.months)}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
              <Tooltip {...ui.tooltip} formatter={(v, n) => [v == null ? NA : formatUsd(Math.round(Number(v))), String(n)]} />
              <Legend {...ui.legend} {...smoothLit.legend} />
              <Bar dataKey="month" name="Month" fill={chart.neutral} fillOpacity={0.55} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} {...smoothLit.fade("month")} />
              <Line dataKey="avg12Before" name="12-month average, a year before" stroke={chart.lineBalance} strokeWidth={1.25} strokeDasharray="4 3" dot={false} connectNulls={false} isAnimationActive={false} {...smoothLit.fade("avg12Before")} />
              <Line dataKey="avg3" name="3-month average" stroke={chart.spending} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} {...smoothLit.fade("avg3")} />
              <Line dataKey="avg12" name="12-month average" stroke={chart.lineBalance} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} {...smoothLit.fade("avg12")} />
            </ComposedChart>
          </RechartsResponsive>
        </div>

      </Card>

      <Card
        title="Bills, everyday and one-off spending"
        subtitle={
          <>
            Over {slice.label}:{" "}
            {kindTotals.map((k, i) => (
              <span key={k.id}>
                {i ? " · " : ""}
                <span className="font-medium text-fg-2" title={k.hint}>
                  {k.label}
                </span>{" "}
                <ProofValue proof={ctx.proof("spending", slice.months, { spendingKind: k.kind, perMonth: true, shownCents: k.cents })}>{usd0(k.cents / Math.max(1, slice.months.length))}</ProofValue>/mo
                {spent > 0 ? (
                  <>
                    {" "}(<ProofValue proof={compositeOf("share", [ctx.proof("spending", slice.months, { spendingKind: k.kind, shownCents: k.cents }), ctx.proof("spending", slice.months, { shownCents: spent })], { ratio: k.cents / spent })}>{formatPercentRatio(k.cents / spent, 0)}</ProofValue>)
                  </>
                ) : (
                  ""
                )}
              </span>
            ))}
            . Bills are rent and the merchants on the Recurring tab. A refund counts in the band of what it pays back, so a big refund shows below zero in big & one-off,
            never in everyday. Tax refunds are income, never taken off spending. Click a month to audit it.
          </>
        }
        actions={
          <Segmented view
            size="xs"
            ariaLabel="Scale"
            options={[
              { value: "usd", label: "Dollars" },
              { value: "share", label: "Share" },
            ]}
            value={kindView}
            onChange={setKindView}
          />
        }
      >
        <div className="h-[280px] w-full min-w-0">
          <RechartsResponsive tableTitle="Bills, everyday and one-off spending, month by month" cellProof={kindProof}>
            <BarChart data={kinds} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} stackOffset="sign" className="cursor-pointer" onClick={openMonthOnClick(ctx, slice.months)}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
              <YAxis {...ui.yAxis} tickFormatter={kindView === "usd" ? axisUsd : pctAxis} domain={kindView === "share" ? [0, 1] : undefined} allowDataOverflow={kindView === "share"} />
              <Tooltip {...ui.tooltip} formatter={(v, n) => [kindView === "usd" ? formatUsd(Math.round(Number(v))) : formatPercentRatio(Number(v), 0), String(n)]} />
              <Legend {...ui.legend} />
              {KINDS.map((k, i) => (
                <Bar
                  key={k.id}
                  dataKey={k.id}
                  name={k.label}
                  stackId="k"
                  fill={[chart.series[6], chart.spending, chart.neutral][i]}
                  stroke={chart.tooltipBg}
                  strokeWidth={1}
                  radius={i === KINDS.length - 1 ? [4, 4, 0, 0] : undefined}
                  maxBarSize={30}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </RechartsResponsive>
        </div>
      </Card>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Income vs spending growth"
          subtitle={
            growth.length > 1
              ? `Trailing 12-month totals, indexed to 100 at ${growth[0]!.label}. Spending climbing faster than income is lifestyle creep; the gap between the lines is the savings rate moving.`
              : "Needs twelve proven months before the range starts."
          }
        >
          <div className="h-[260px] w-full min-w-0">
            <RechartsResponsive tableTitle="Income vs spending growth, indexed to 100" cellProof={growthProof} cellDrawn={{ income: { per: 0.01 }, spending: { per: 0.01 } }}>
              <LineChart data={growth} margin={{ top: 8, right: 64, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} width={40} domain={["auto", "auto"]} />
                <Tooltip {...ui.tooltip} cursor={crosshair(chart)} formatter={(v, n) => [Math.round(Number(v)).toString(), String(n)]} />
                <Legend {...ui.legend} {...growthLit.legend} />
                <ReferenceLine y={100} stroke={chart.axisLine} strokeDasharray="4 4" />
                <Line dataKey="income" name="Income (12 mo)" stroke={chart.income} strokeWidth={2} dot={false} isAnimationActive={false} label={lineEnd("Income", chart.income, growth, "income")} {...growthLit.fade("income")} />
                <Line dataKey="spending" name="Spending (12 mo)" stroke={chart.spending} strokeWidth={2} dot={false} isAnimationActive={false} label={lineEnd("Spending", chart.spending, growth, "spending")} {...growthLit.fade("spending")} />
                {growth.length > 6 && <Brush dataKey="label" {...growthZoom.brush} />}
              </LineChart>
            </RechartsResponsive>
          </div>
          <ZoomReset zoom={growthZoom} />
        </Card>
        <Card title="Savings rate, trailing 12 months" subtitle="Income minus spending over the twelve months ending each month — steadier than any single month, which a bonus or a tax payment can swing.">
          <div className="h-[260px] w-full min-w-0">
            <RechartsResponsive tableTitle="Savings rate, trailing 12 months" cellProof={growthProof}>
              <AreaChart data={growth} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} width={44} tickFormatter={pctAxis} />
                <Tooltip {...ui.tooltip} formatter={(v) => [v == null ? NA : formatPercentRatio(Number(v), 1), "Savings rate"]} />
                <ReferenceLine y={0} stroke={chart.axisLine} />
                <ReferenceLine y={0.2} stroke={chart.axis} strokeDasharray="4 4" label={(p: { viewBox?: { x?: number; y?: number } }) => (
                    // A guide, not a figure: the savings rate many plans aim for.
                    <text x={(p.viewBox?.x ?? 0) + 4} y={(p.viewBox?.y ?? 0) + 12} fill={chart.axis} fontSize={10} data-not-figure="a guide line: a 20% savings rate">
                      20%
                    </text>
                  )} />
                <Area type="linear" dataKey="rate" stroke={chart.growth} fill={chart.growth} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </RechartsResponsive>
          </div>
        </Card>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Essentials, lifestyle and financial" subtitle="Each group's share of spending over the three months ending each month. Financial = taxes & fees, untracked card payments and other.">
          <div className="h-[260px] w-full min-w-0">
            <RechartsResponsive tableTitle="Essentials, lifestyle and financial, share by month" cellProof={groupProof}>
              <AreaChart data={groupMix} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} width={44} tickFormatter={pctAxis} domain={[0, 1]} />
                <Tooltip {...ui.tooltip} formatter={(v, n) => [formatPercentRatio(Number(v), 0), String(n)]} />
                <Legend {...ui.legend} />
                {GROUPS.map((g, i) => (
                  <Area
                    key={g}
                    type="linear"
                    dataKey={g}
                    stackId="g"
                    stroke={[chart.series[0], chart.series[4], chart.neutral][i]}
                    strokeWidth={1.5}
                    fill={[chart.series[0], chart.series[4], chart.neutral][i]}
                    fillOpacity={0.85}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </RechartsResponsive>
          </div>
        </Card>
        <Momentum ctx={ctx} hi={hi} />
      </div>
    </>
  );
}

/** Which categories are heating up: the last three months against the twelve before them. */
function Momentum({ ctx, hi }: { ctx: Ctx; hi: number }) {
  const { report, chart } = ctx;
  const { recent, before } = momentumWindows(report.months, hi);
  // The categories the proof sweep holds over both runs (momentumCategories).
  const rows = momentumCategories(recent, before)
    .map((r) => {
      const now = r.nowCents / Math.max(1, recent.length);
      const then = r.thenCents / Math.max(1, before.length);
      return { ...r, now, then, d: now - then };
    })
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.d)));
  return (
    <Card
      title="Heating up, cooling down"
      subtitle={
        before.length >= 6
          ? `Per month, ${recent[0]!.label} – ${recent.at(-1)!.label} against the ${before.length} months before. Right = spending more lately.`
          : "Needs at least nine proven months up to the end of the range."
      }
    >
      {before.length >= 6 && (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Category</th>
                <th className={table.thR}>Before</th>
                <th className={table.thR}>Lately</th>
                <th className={`${table.th} w-[30%]`} />
                <th className={table.thR}>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.c} className={`${table.trHover} cursor-pointer`} onClick={() => ctx.open({ kind: "category", category: r.c })}>
                  <td className={table.td}>
                    <span className="flex items-center gap-2">
                      <Dot color={categoryColor(chart, r.c)} />
                      {r.c}
                    </span>
                  </td>
                  <td className={`${table.tdR} text-muted`}>
                    <ProofValue proof={ctx.proof("spending", before, { category: r.c, perMonth: true, shownCents: r.thenCents })}>{usd0(r.then)}</ProofValue>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={ctx.proof("spending", recent, { category: r.c, perMonth: true, shownCents: r.nowCents })}>{usd0(r.now)}</ProofValue>
                  </td>
                  <td className={table.td}>
                    <DivergingBar value={r.d} max={max} />
                  </td>
                  <td className={`${table.tdR} ${r.d > 0 ? "text-neg" : r.d < 0 ? "text-pos" : ""}`}>
                    <ProofValue
                      proof={
                        !r.thenCents
                          ? ctx.proof("spending", recent, { category: r.c, perMonth: true, shownCents: r.nowCents })
                          : !r.nowCents
                            ? ctx.proof("spending", before, { category: r.c, perMonth: true, shownCents: r.thenCents })
                            : compositeOf("diff", [ctx.proof("spending", recent, { category: r.c, shownCents: r.nowCents }), ctx.proof("spending", before, { category: r.c, shownCents: r.thenCents })], { cents: r.d }, [recent.length, before.length])
                      }
                    >
                      {usdDelta(r.d)}
                    </ProofValue>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
