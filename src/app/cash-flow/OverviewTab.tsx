"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { Card, StatCell, StatGrid, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { axisUsd, formatPercentRatio, formatUsd, usd0 } from "@/lib/formatMoney";
import { useMemo } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { CashTab, Ctx } from "./CashFlowClient";
import { buildInsights, categoryCents, median, mergeCategories, totals, type Insight } from "./model";
import { categoryColor, Delta, Dot, openMonthOnClick } from "./parts";

const TONE: Record<Insight["tone"], { icon: string; cls: string }> = {
  good: { icon: "▲", cls: "bg-pos-soft text-pos" },
  bad: { icon: "!", cls: "bg-neg-soft text-neg" },
  warn: { icon: "!", cls: "bg-warn-soft text-warn" },
  info: { icon: "i", cls: "bg-info-soft text-info" },
};

export function OverviewTab({ ctx }: { ctx: Ctx }) {
  const { slice, chart, report } = ctx;
  const ui = chartChrome(chart);
  const t = useMemo(() => totals(slice.months), [slice]);
  const p = useMemo(() => (slice.prior.length ? totals(slice.prior) : null), [slice]);
  const insights = useMemo(() => buildInsights(slice, report, ctx.proof), [slice, report, ctx]);
  const rows = slice.months.map((m) => ({ label: m.label, income: m.incomeCents / 100, spending: m.spendingCents / 100, net: m.netCents / 100 }));
  const last = slice.months.at(-1)!;
  const cats = mergeCategories(slice.months, (m) => m.spendingByCategory).filter((c) => c.cents > 0);
  const rest = slice.months.length > 1 ? slice.months.slice(0, -1) : slice.months;

  return (
    <>
      <StatGrid cols={6}>
        <StatCell label="Income / month" value={usd0(t.avgIncome)} proof={ctx.proof("income", slice.months, { perMonth: true, shownCents: t.income })} sub={<>typical {usd0(t.typicalIncome)} · <Delta now={t.avgIncome} before={p?.avgIncome ?? null} /></>} />
        <StatCell label="Spending / month" value={usd0(t.avgSpending)} proof={ctx.proof("spending", slice.months, { perMonth: true, shownCents: t.spending })} sub={<>typical {usd0(t.typicalSpending)} · <Delta now={t.avgSpending} before={p?.avgSpending ?? null} goodWhenDown /></>} />
        <StatCell
          label="Excluding one-offs"
          value={usd0(t.avgCore)}
          proof={ctx.proof("spending", slice.months, { perMonth: true, shownCents: t.spending - t.oneOff, excludeOneOffs: true })}
          sub={t.oneOff ? `${usd0(t.oneOff)} marked one-off` : "none marked yet"}
        />
        <StatCell label="Net saved" value={usd0(t.net)} proof={ctx.proof("net", slice.months, { shownCents: t.net })} tone={t.net >= 0 ? "pos" : "neg"} sub={`over ${t.n} month${t.n === 1 ? "" : "s"}`} />
        <StatCell
          label="Savings rate (take-home)"
          value={t.savingsRate == null ? "—" : formatPercentRatio(t.savingsRate, 1)}
          tone={t.savingsRate == null ? "neutral" : t.savingsRate >= 0.2 ? "pos" : t.savingsRate < 0 ? "neg" : "neutral"}
          sub={p?.savingsRate != null ? `was ${formatPercentRatio(p.savingsRate, 0)} before` : "net ÷ income"}
        />
        <StatCell label="401(k) via payroll" value={usd0(t.employee + t.employer)} sub={`${usd0(t.employer)} from employers · not in income`} />
      </StatGrid>

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card
          title="Income vs spending"
          subtitle="Each month from bank and card statements. Transfers between your own accounts never count. The dashed line is your average month of spending. Click a month to audit it."
        >
          <div className="h-[320px] w-full min-w-0">
            <RechartsResponsive>
              <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} className="cursor-pointer" onClick={openMonthOnClick(ctx, slice.months)}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
                <Tooltip {...ui.tooltip} formatter={(v, n) => [formatUsd(Math.round(Number(v))), String(n)]} />
                <Legend {...ui.legend} />
                <ReferenceLine y={t.avgSpending / 100} stroke={chart.spending} strokeDasharray="4 4" strokeOpacity={0.8} />
                <Bar dataKey="income" name="Income" fill={chart.income} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                <Bar dataKey="spending" name="Spending" fill={chart.spending} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                <Line type="linear" dataKey="net" name="Net" stroke={chart.lineBalance} dot={{ r: 3 }} strokeWidth={2} isAnimationActive={false} />
              </ComposedChart>
            </RechartsResponsive>
          </div>
        </Card>
        <Card title="Insights" subtitle={`What stands out in ${slice.label}.`}>
          {insights.length === 0 ? (
            <p className="text-sm text-muted">Pick a longer range for comparisons.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {insights.map((i) => (
                <li key={i.title} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${TONE[i.tone].cls}`}>
                    {TONE[i.tone].icon}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-fg">{i.proof ? <ProofValue proof={i.proof}>{i.title}</ProofValue> : i.title}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-muted">{i.body}</div>
                    {i.action && (
                      <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => ctx.goTo((i.action!.tab ?? "spending") as CashTab, i.action!.category)}>
                        {i.action.label} →
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Where the money went" subtitle="Share of spending in the selected months. Click a category for its merchants and transactions.">
          <ul className="flex flex-col">
            {cats.map((c) => (
              <li key={c.category}>
                <button
                  type="button"
                  onClick={() => ctx.open({ kind: "category", category: c.category })}
                  className="grid w-full grid-cols-[minmax(0,10rem)_1fr_5rem_3rem] items-center gap-3 rounded px-1 py-1.5 text-left text-[13px] hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span className="flex min-w-0 items-center gap-2 truncate text-fg-2">
                    <Dot color={categoryColor(chart, c.category)} />
                    <span className="truncate">{c.category}</span>
                  </span>
                  <span className="h-2 rounded-sm bg-surface-3">
                    <span className="block h-full rounded-sm" style={{ width: `${(c.cents / cats[0]!.cents) * 100}%`, background: categoryColor(chart, c.category) }} />
                  </span>
                  <span className="num text-right font-medium">{usd0(c.cents / t.n)}<span className="text-[11px] font-normal text-muted">/mo</span></span>
                  <span className="num text-right text-xs text-muted">{formatPercentRatio(c.cents / t.spending, 0)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`${last.label} against a typical month`} subtitle={`Typical = the median of the other ${rest.length} month${rest.length === 1 ? "" : "s"} in range, so one unusual month doesn't set the bar.`}>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Category</th>
                  <th className={table.thR}>{last.label}</th>
                  <th className={table.thR}>Typical</th>
                  <th className={table.thR}>Change</th>
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => {
                  const now = categoryCents(last, c.category);
                  const typ = median(rest.map((m) => categoryCents(m, c.category)));
                  return (
                    <tr key={c.category} className={`${table.trHover} cursor-pointer`} onClick={() => ctx.open({ kind: "category", category: c.category })}>
                      <td className={table.td}>
                        <span className="flex items-center gap-2">
                          <Dot color={categoryColor(chart, c.category)} />
                          {c.category}
                        </span>
                      </td>
                      <td className={table.tdR}>
                        <ProofValue proof={ctx.proof("spending", [last], { category: c.category, shownCents: now })}>{usd0(now)}</ProofValue>
                      </td>
                      <td className={`${table.tdR} text-muted`}>{usd0(typ)}</td>
                      <td className={table.tdR}>
                        <Delta now={now} before={typ} goodWhenDown asPercent={false} />
                      </td>
                    </tr>
                  );
                })}
                <tr className={`${table.tr} font-semibold`}>
                  <td className={table.td}>Total</td>
                  <td className={table.tdR}>
                    <ProofValue proof={ctx.proof("spending", [last], { shownCents: last.spendingCents })}>{usd0(last.spendingCents)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} text-muted`}>{usd0(median(rest.map((m) => m.spendingCents)))}</td>
                  <td className={table.tdR}>
                    <Delta now={last.spendingCents} before={median(rest.map((m) => m.spendingCents))} goodWhenDown asPercent={false} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="Month by month" subtitle="Every month here is proven: each bank and card statement is on file and every transfer pairs.">
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[44rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Month</th>
                <th className={table.thR}>Income</th>
                <th className={table.thR}>Spending</th>
                <th className={table.thR}>One-offs</th>
                <th className={table.thR}>Net</th>
                <th className={table.thR}>Savings rate</th>
                <th className={table.thR}>401(k) payroll + employer</th>
              </tr>
            </thead>
            <tbody>
              {[...slice.months].reverse().map((m) => (
                <tr key={m.start} className={table.trHover}>
                  <td className={`${table.td} whitespace-nowrap font-medium`}>{m.label}</td>
                  <td className={table.tdR}>
                    <ProofValue proof={ctx.proof("income", [m], { shownCents: m.incomeCents })}>{usd0(m.incomeCents)}</ProofValue>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={ctx.proof("spending", [m], { shownCents: m.spendingCents })}>{usd0(m.spendingCents)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} text-muted`}>{usd0(m.oneOffCents)}</td>
                  <td className={`${table.tdR} font-medium ${m.netCents < 0 ? "text-neg" : "text-pos"}`}>
                    <ProofValue proof={ctx.proof("net", [m], { shownCents: m.netCents })}>{usd0(m.netCents)}</ProofValue>
                  </td>
                  <td className={table.tdR}>{m.savingsRate == null ? "—" : formatPercentRatio(m.savingsRate, 0)}</td>
                  <td className={table.tdR}>{usd0(m.retirementEmployeeCents + m.retirementEmployerCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
