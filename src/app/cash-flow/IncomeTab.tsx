"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { Card, StatCell, StatGrid, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { axisUsd, formatPercentRatio, formatUsd, usd0 } from "@/lib/formatMoney";
import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import type { Ctx } from "./CashFlowClient";
import { mergeCategories, mergeMerchants, totals } from "./model";
import { CATEGORIES } from "@/lib/classifier/taxonomy";

/** Income types keep one color each, in the taxonomy's order (never by size). */
const INCOME_CATEGORIES = CATEGORIES.filter((c) => c.group === "Income").map((c) => c.name);
const incomeSlot = (c: string) => Math.max(0, INCOME_CATEGORIES.indexOf(c));
import { Sparkline } from "./parts";

export function IncomeTab({ ctx }: { ctx: Ctx }) {
  const { slice, chart } = ctx;
  const ui = chartChrome(chart);
  const t = totals(slice.months);
  const incomeCats = useMemo(() => mergeCategories(slice.months, (m) => m.incomeByCategory), [slice]);
  const external = useMemo(() => mergeCategories(slice.months, (m) => m.externalByCategory), [slice]);
  const payers = useMemo(() => mergeMerchants(slice.months, (m) => m.payers), [slice]);
  const catNames = INCOME_CATEGORIES.filter((c) => incomeCats.some((x) => x.category === c && x.cents > 0));
  const stack = slice.months.map((m) => Object.fromEntries([["label", m.label], ...catNames.map((c) => [c, (m.incomeByCategory.find((x) => x.category === c)?.cents ?? 0) / 100])]));
  const cumulative: { label: string; saved: number }[] = [];
  let run = 0;
  for (const m of slice.months) {
    run += m.netCents;
    cumulative.push({ label: m.label, saved: run / 100 });
  }
  const bonus = t.income - t.typicalIncome * t.n;

  return (
    <>
      <StatGrid cols={5}>
        <StatCell label="Income" value={usd0(t.income)} proof={ctx.proof("income", slice.months, { shownCents: t.income })} sub={`${usd0(t.avgIncome)}/mo average`} />
        <StatCell label="Typical month" value={usd0(t.typicalIncome)} sub="median — what to budget against" />
        <StatCell label="Above typical" value={usd0(Math.max(0, bonus))} sub="bonuses and one-time deposits" />
        <StatCell label="Saved from take-home" value={usd0(t.net)} proof={ctx.proof("net", slice.months, { shownCents: t.net })} tone={t.net >= 0 ? "pos" : "neg"} sub={t.savingsRate == null ? undefined : `${formatPercentRatio(t.savingsRate, 1)} of income`} />
        <StatCell label="Retirement via payroll" value={usd0(t.employee + t.employer)} sub={`you ${usd0(t.employee)} · employers ${usd0(t.employer)}`} />
      </StatGrid>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Income by type" subtitle="What reached your bank accounts each month. Payroll 401(k) deferrals never touch checking, so they aren't here.">
          <div className="h-[280px] w-full min-w-0">
            <RechartsResponsive>
              <BarChart data={stack} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
                <Tooltip {...ui.tooltip} formatter={(v, n) => [formatUsd(Math.round(Number(v))), String(n)]} />
                <Legend {...ui.legend} />
                {catNames.map((c) => (
                  <Bar key={c} dataKey={c} stackId="i" fill={chart.series[[0, 2, 3, 4, 6][incomeSlot(c)] ?? 0]!} stroke={chart.tooltipBg} strokeWidth={1} maxBarSize={36} isAnimationActive={false} />
                ))}
              </BarChart>
            </RechartsResponsive>
          </div>
        </Card>
        <Card title="Cumulative savings" subtitle={`Income minus spending, added up month by month since ${slice.months[0]!.label}.`}>
          <div className="h-[280px] w-full min-w-0">
            <RechartsResponsive>
              <AreaChart data={cumulative} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
                <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
                <Tooltip {...ui.tooltip} formatter={(v) => [formatUsd(Math.round(Number(v))), "Saved so far"]} />
                <Area type="linear" dataKey="saved" stroke={chart.growth} fill={chart.growth} fillOpacity={0.18} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </RechartsResponsive>
          </div>
        </Card>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Who paid you" subtitle="Deposits grouped by payer. Click one for its deposits.">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Payer</th>
                  <th className={table.th}>Trend</th>
                  <th className={table.thR}>Deposits</th>
                  <th className={table.thR}>Total</th>
                  <th className={table.thR}>Share</th>
                </tr>
              </thead>
              <tbody>
                {payers.slice(0, 15).map((p) => (
                  <tr key={p.key} className={`${table.trHover} cursor-pointer`} onClick={() => ctx.open({ kind: "merchant", key: p.key, name: p.name, lane: "INCOME" })}>
                    <td className={`${table.td} max-w-[14rem] truncate font-medium`} title={p.key}>
                      {p.name}
                      <div className="text-[11px] font-normal text-muted">{p.category}</div>
                    </td>
                    <td className={table.td}>
                      <Sparkline values={p.series} color={chart.income} width={72} height={18} />
                    </td>
                    <td className={`${table.tdR} text-muted`}>{p.count}</td>
                    <td className={`${table.tdR} font-medium`}>{usd0(p.cents)}</td>
                    <td className={`${table.tdR} text-muted`}>{t.income > 0 ? formatPercentRatio(p.cents / t.income, 0) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card
          title="Money in and out of untracked accounts"
          subtitle="Not income or spending: partner contributions before finances merged, partner accounts after, Wise/Venmo balances, other brokerages. Positive = came in."
        >
          {external.length === 0 ? (
            <p className="text-sm text-muted">None in this range.</p>
          ) : (
            <ul className="flex flex-col">
              {external.map((c) => (
                <li key={c.category} className="flex items-center justify-between gap-3 rounded px-1 py-1.5 text-[13px] hover:bg-surface-2">
                  <button type="button" onClick={() => ctx.open({ kind: "category", category: c.category })} className="min-w-0 flex-1 text-left text-fg-2 hover:underline">
                    {c.category}
                  </button>
                  <span className={`num font-medium ${c.cents < 0 ? "text-neg" : "text-pos"}`}>
                    <ProofValue proof={ctx.proof("external", slice.months, { category: c.category, shownCents: c.cents })}>{usd0(c.cents)}</ProofValue>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
