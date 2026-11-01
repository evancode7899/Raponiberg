"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Callout, Card, NotFigure, table, WhatIf } from "@/components/ui/kit";
import { axisUsd } from "@/lib/formatMoney";
import type { WalkAwayRow } from "@/lib/profile/outlook";
import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { deflator, DollarsToggle, pct, tipUsd, usd, type FireProps } from "./ui";

/**
 * "If I stopped working on Jan 1 of year X": the first year's after-tax income from
 * drawing the withdrawal rate on the net worth the plan reaches by then, against that
 * year's living cost. The year the lines cross is financial independence.
 */
export function WalkAwayTab({ f, dollars, setDollars, walkBase }: FireProps & { walkBase: WalkAwayRow[] | null }) {
  const { plan } = f;
  const through = Math.max(plan.horizonYear, (f.fi?.year ?? 0) + 2);
  const rows = f.rows.filter((r) => r.year <= through);
  const base = new Map((walkBase ?? []).map((w) => [w.year, w]));
  return (
    <>
      <Crossover f={f} rows={rows} dollars={dollars} setDollars={setDollars} />
      <Card
        title="Walk-away income by year"
        subtitle={
          <NotFigure why="your settings">{`Stop working on Jan 1 of each year: draw ${pct(plan.withdrawalRate)} of net worth, pay federal tax (real brackets, standard deduction, indexed at ${pct(plan.inflation)}) and ${plan.stateTaxRate == null ? "Connecticut income tax (its real brackets)" : `${pct(plan.stateTaxRate)} state tax on the taxable part`}. Every dollar drawn is taxed as ordinary income, which is conservative for Roth and taxable money.`}</NotFigure>
        }
      >
        <WhatIf why="walking away on Jan 1 of each future year, on the plan's projection" className={table.wrap}>
          <table className={`${table.table} min-w-[52rem]`}>
            <thead className={table.head}>
              <tr>
                {["Stop on Jan 1", "Age", "Net worth", "FIRE number", "Progress", "After tax / yr", "Per month", "Today's $ / mo", "Living cost", "Covers", "Short / mo", ...(walkBase ? ["Base pay only"] : [])].map((h, i) => (
                  <th key={h} className={i === 0 ? table.th : table.thR}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const fi = w.year === f.fi?.year;
                return (
                  <tr key={w.year} className={`${table.trHover} ${fi ? "bg-pos-soft font-semibold" : w.year === plan.walkAwayYear ? "bg-info-soft" : ""}`}>
                    <td className={table.td}>
                      {w.year}
                      {fi && <span className="ml-1.5 text-[10px] uppercase text-pos">first FI year</span>}
                      {w.year === plan.walkAwayYear && !fi && <span className="ml-1.5 text-[10px] uppercase text-info">your walk-away</span>}
                    </td>
                    <td className={`${table.tdR} text-muted`}>{w.age ?? ""}</td>
                    <td className={table.tdR}>{usd(w.netWorth)}</td>
                    <td className={`${table.tdR} text-muted`}>{usd(w.fireNumber)}</td>
                    <td className={table.tdR}>{pct(w.progress, 0)}</td>
                    <td className={table.tdR}>{usd(w.afterTaxIncome)}</td>
                    <td className={`${table.tdR} font-medium`}>{usd(w.monthly)}</td>
                    <td className={`${table.tdR} text-muted`}>{usd(w.monthlyToday)}</td>
                    <td className={`${table.tdR} text-muted`}>{usd(w.livingCost)}</td>
                    <td className={`${table.tdR} ${w.coverage != null && w.coverage >= 1 ? "text-pos" : "text-warn"}`}>{pct(w.coverage, 0)}</td>
                    <td className={`${table.tdR} text-muted`}>{w.gapMonthly ? usd(w.gapMonthly) : "—"}</td>
                    {walkBase && (
                      <td
                        className={`${table.tdR} ${(base.get(w.year)?.coverage ?? 0) >= 1 ? "text-pos" : "text-muted"}`}
                        title={base.get(w.year) ? `${usd(base.get(w.year)!.netWorth)} net worth → ${usd(base.get(w.year)!.monthly)}/mo` : undefined}
                      >
                        {pct(base.get(w.year)?.coverage, 0)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </WhatIf>
        {!f.fi && (
          <div className="mt-3">
            <Callout tone="info">No year within 60 years reaches full coverage — see Levers for what moves the date (spending, savings rate, return, withdrawal rate).</Callout>
          </div>
        )}
      </Card>
    </>
  );
}

function Crossover({ f, rows, dollars, setDollars }: Omit<FireProps, "d"> & { rows: FireProps["f"]["rows"] }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const { plan } = f;
  const data = useMemo(
    () =>
      rows.map((w) => {
        const k = 100 * deflator(plan, dollars, w.year);
        return { year: String(w.year), income: w.monthly / k, living: w.livingCost / 12 / k };
      }),
    [rows, plan, dollars],
  );
  return (
    <Card
      title="The crossover point"
      subtitle="Monthly after-tax income your money could pay if you stopped on Jan 1 of each year, against monthly living cost. Where income crosses living cost you're financially independent."
      actions={<DollarsToggle value={dollars} onChange={setDollars} />}
    >
      <div className="h-[320px] w-full min-w-0">
        <RechartsResponsive>
          <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="year" {...ui.xAxis} minTickGap={16} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip {...ui.tooltip} labelFormatter={(v) => `Stop on Jan 1, ${v}`} formatter={(v, name) => [`${tipUsd(v)}/mo`, String(name)]} />
            <Legend {...ui.legend} />
            <Line type="monotone" dataKey="living" name="Living cost" stroke={chart.series[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="income" name="Walk-away income" stroke={chart.series[0]} strokeWidth={2.5} dot={false} isAnimationActive={false} />
            {f.fi && <ReferenceLine x={String(f.fi.year)} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: `FI ${f.fi.year}`, fill: chart.legend, fontSize: 11, position: "insideTopLeft" }} />}
          </ComposedChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}
