"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { last12At, momentumWindows } from "@/lib/book/reports/cashFlowWindows";
import { chartChrome } from "@/components/shell/chartPalette";
import { Card, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { SpendingMonth } from "@/lib/book/reports/spending";
import { axisUsd, formatPercentRatio, formatUsd, usd0, usdDelta } from "@/lib/formatMoney";
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { Ctx } from "./CashFlowClient";
import { categoryCents, categoryGroup, KINDS, sliceStart, SPEND_CATEGORIES, sum, trailing } from "./model";
import { categoryColor, Delta, DivergingBar, Dot, openMonthOnClick } from "./parts";
import { noFigure } from "@/lib/book/proof/clearance";

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
    label: m.label,
    month: pick(m) / 100,
    avg3: t3[lo + i] == null ? null : t3[lo + i]! / 300,
    avg12: t12[lo + i] == null ? null : t12[lo + i]! / 1200,
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

  const kinds = slice.months.map((m) => {
    const total = Math.max(1, m.spendingCents);
    const v = (c: number) => (kindView === "usd" ? c / 100 : c / total);
    return { label: m.label, billCents: v(m.kinds.billCents), everydayCents: v(m.kinds.everydayCents), bigCents: v(m.kinds.bigCents) };
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
          return { label: m.label, income: (inc12[i]! / inc12[lo + base]!) * 100, spending: (spend12[i]! / spend12[lo + base]!) * 100, rate: rate(inc12[i]!, spend12[i]!) };
        });

  // Group mix over three-month runs, so one big month doesn't swing the share.
  const groupMix = slice.months.map((m, i) => {
    const run = all.slice(Math.max(0, lo + i - 2), lo + i + 1);
    const by = Object.fromEntries(GROUPS.map((g) => [g, sum(run, (x) => sum(x.spendingByCategory.filter((c) => categoryGroup(c.category) === g), (c) => c.cents))]));
    const total = Math.max(1, sum([...GROUPS], (g) => Math.max(0, by[g]!)));
    return { label: m.label, ...Object.fromEntries(GROUPS.map((g) => [g, Math.max(0, by[g]!) / total])) };
  });

  return (
    <>
      <StatGrid cols={4}>
        <StatCell
          label="Spending, last 12 months"
          value={spend12[hi] == null ? "—" : usd0(spend12[hi])}
          proof={spend12[hi] == null ? noFigure("not twelve proven months yet") : ctx.proof("spending", last12, { shownCents: spend12[hi]! })}
          sub={<><Delta now={spend12[hi] ?? 0} before={prevAt(spend12)} goodWhenDown /> vs the 12 before{prevAt(spend12) != null ? ` (${usd0(prevAt(spend12))})` : ""}</>}
        />
        <StatCell
          label="Income, last 12 months"
          value={inc12[hi] == null ? "—" : usd0(inc12[hi])}
          proof={inc12[hi] == null ? noFigure("not twelve proven months yet") : ctx.proof("income", last12, { shownCents: inc12[hi]! })}
          sub={<><Delta now={inc12[hi] ?? 0} before={prevAt(inc12)} /> vs the 12 before{prevAt(inc12) != null ? ` (${usd0(prevAt(inc12))})` : ""}</>}
        />
        <StatCell
          label="Savings rate, last 12 months"
          proof={rateNow == null ? noFigure("not twelve proven months yet") : ctx.proof("net", last12, { shownCents: inc12[hi]! - spend12[hi]! })}
          value={rateNow == null ? "—" : formatPercentRatio(rateNow, 0)}
          tone={rateNow == null ? "neutral" : rateNow >= 0.2 ? "pos" : rateNow < 0 ? "neg" : "neutral"}
          sub={rateBefore == null ? `through ${endLabel}` : `${formatPercentRatio(rateBefore, 0)} the 12 months before`}
        />
        <StatCell
          label="Everyday spending, last 3 months"
          value={every3[hi] == null ? "—" : `${usd0(every3[hi]! / 3)}/mo`}
          proof={every3[hi] == null ? noFigure("not twelve proven months yet") : ctx.proof("spending", all.slice(hi - 2, hi + 1), { spendingKind: "everyday", perMonth: true, shownCents: every3[hi]! })}
          sub={
            every12[hi] == null ? (
              "bills and big one-offs left out"
            ) : (
              <>
                <Delta now={every3[hi]! / 3} before={every12[hi]! / 12} goodWhenDown /> vs the 12-month pace ({usd0(every12[hi]! / 12)}/mo)
              </>
            )
          }
        />
      </StatGrid>

      <Card
        title="Spending, smoothed"
        subtitle={`Bars are single months; the lines are trailing 3- and 12-month averages, which show the direction once lumpy months (tax payments, a big purchase) wash out. ${
          metric === "everyday" ? "Everyday leaves out rent and recurring bills, charges of $1,500+, taxes, and big merchant refunds." : ""
        } Click a month to audit it.`}
        actions={
          <Segmented
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
          <RechartsResponsive>
            <ComposedChart data={smooth} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} className="cursor-pointer" onClick={openMonthOnClick(ctx, slice.months)}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
              <Tooltip {...ui.tooltip} formatter={(v, n) => [v == null ? "—" : formatUsd(Math.round(Number(v))), String(n)]} />
              <Legend {...ui.legend} />
              <Bar dataKey="month" name="Month" fill={chart.neutral} fillOpacity={0.55} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
              <Line dataKey="avg3" name="3-month average" stroke={chart.spending} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              <Line dataKey="avg12" name="12-month average" stroke={chart.lineBalance} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
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
                {spent > 0 ? ` (${formatPercentRatio(k.cents / spent, 0)})` : ""}
              </span>
            ))}
            . Bills are rent and the merchants on the Recurring tab. A refund counts in the band of what it pays back, so a big refund shows below zero in big & one-off,
            never in everyday. Tax refunds are income, never taken off spending. Click a month to audit it.
          </>
        }
        actions={
          <Segmented
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
          <RechartsResponsive>
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
            <RechartsResponsive>
              <LineChart data={growth} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} width={40} domain={["auto", "auto"]} />
                <Tooltip {...ui.tooltip} formatter={(v, n) => [Math.round(Number(v)).toString(), String(n)]} />
                <Legend {...ui.legend} />
                <ReferenceLine y={100} stroke={chart.axisLine} strokeDasharray="4 4" />
                <Line dataKey="income" name="Income (12 mo)" stroke={chart.income} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="spending" name="Spending (12 mo)" stroke={chart.spending} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </RechartsResponsive>
          </div>
        </Card>
        <Card title="Savings rate, trailing 12 months" subtitle="Income minus spending over the twelve months ending each month — steadier than any single month, which a bonus or a tax payment can swing.">
          <div className="h-[260px] w-full min-w-0">
            <RechartsResponsive>
              <AreaChart data={growth} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} width={44} tickFormatter={pctAxis} />
                <Tooltip {...ui.tooltip} formatter={(v) => [v == null ? "—" : formatPercentRatio(Number(v), 1), "Savings rate"]} />
                <ReferenceLine y={0} stroke={chart.axisLine} />
                <ReferenceLine y={0.2} stroke={chart.axis} strokeDasharray="4 4" label={{ value: "20%", fill: chart.axis, fontSize: 10, position: "insideTopLeft" }} />
                <Area type="linear" dataKey="rate" stroke={chart.growth} fill={chart.growth} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </RechartsResponsive>
          </div>
        </Card>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Essentials, lifestyle and financial" subtitle="Each group's share of spending over the three months ending each month. Financial = taxes & fees, untracked card payments and other.">
          <div className="h-[260px] w-full min-w-0">
            <RechartsResponsive>
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
  const rows = SPEND_CATEGORIES.map((c) => {
    const nowCents = sum(recent, (m) => categoryCents(m, c));
    const thenCents = sum(before, (m) => categoryCents(m, c));
    const now = nowCents / Math.max(1, recent.length);
    const then = thenCents / Math.max(1, before.length);
    return { c, now, then, nowCents, thenCents, d: now - then };
  })
    .filter((r) => r.now > 0 || r.then > 0)
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
                  <td className={`${table.tdR} ${r.d > 0 ? "text-neg" : r.d < 0 ? "text-pos" : ""}`}>{usdDelta(r.d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
