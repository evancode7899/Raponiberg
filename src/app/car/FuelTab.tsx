"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { Card, EmptyState, StatCell, StatGrid, table } from "@/components/ui/kit";
import { sortRows, SortTh, useSort } from "@/components/ui/sort";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { CarCtx } from "./CarClient";
import { fmtDate, miles, perMile, usd2 } from "./parts";

export function FuelTab({ ctx }: { ctx: CarCtx }) {
  const { report: r, chart } = ctx;
  const f = r.fuel;
  const fillSort = useSort();
  const ui = chartChrome(chart);
  const fills = useMemo(
    () => f.fills.map((x) => ({ label: fmtDate(x.date), mpg: +x.mpg.toFixed(1), price: x.pricePerGallon == null ? null : +(x.pricePerGallon / 100).toFixed(3), cpm: x.costPerMile == null ? null : +(x.costPerMile / 100).toFixed(3) })),
    [f.fills],
  );
  const driving = r.months.map((m) => ({ label: m.label, miles: m.miles }));
  const avgMonth = driving.length > 1 ? driving.slice(0, -1).reduce((s, m) => s + m.miles, 0) / (driving.length - 1) : null;

  return (
    <>
      <StatGrid cols={6}>
        <StatCell proof={ctx.dp("mpg")} label="Lifetime MPG" value={f.mpg ? f.mpg.toFixed(1) : "—"} sub={`${f.fills.length} full fills measured`} />
        <StatCell proof={ctx.dp("recent-mpg")} label="Last 5 fills" value={f.recentMpg ? f.recentMpg.toFixed(1) : "—"} tone={f.recentMpg && f.mpg ? (f.recentMpg >= f.mpg ? "pos" : "warn") : "neutral"} sub={f.bestMpg ? `best ${f.bestMpg.toFixed(1)} · worst ${f.worstMpg!.toFixed(1)}` : undefined} />
        <StatCell proof={ctx.dp("price-per-gallon")} label="Avg price paid" value={f.pricePerGallon ? `${usd2(Math.round(f.pricePerGallon))}/gal` : "—"} sub={`${miles(f.gallons, 1)} gallons`} />
        <StatCell proof={ctx.dp("fuel-per-mile")} drawn={{ per: 100 }} label="Fuel per mile" value={perMile(f.fuelPerMile, 3)} sub={`${usd2(r.accrued.FUEL)} on ${f.fillsCount} fill-ups`} />
        <StatCell proof={ctx.dp("range")} label="Range on a tank" value={f.avgRange ? `${miles(f.avgRange)} mi` : "—"} sub={ctx.car.vehicle.tankGallons ? `${ctx.car.vehicle.tankGallons} gal tank` : "set the tank size"} />
        <StatCell proof={ctx.dp("recent-per-day")} label="Driving" value={r.odometer.recentPerDay ? `${r.odometer.recentPerDay.toFixed(1)} mi/day` : "—"} sub={r.odometer.perDay ? `${r.odometer.perDay.toFixed(1)} mi/day since purchase` : undefined} />
      </StatGrid>

      {f.fills.length === 0 ? (
        <EmptyState title="No fill-ups with gallons and odometer yet">
          Log a fill-up with its gallons and the odometer (+ Fill-up, above) to see MPG and price per gallon. Gas station charges on your statements already count toward cost; click one in the Log to add its gallons.
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Fuel economy by fill-up" subtitle="Miles since the last full fill over gallons bought (partial fills roll into the next full one).">
            <div className="h-64">
              <RechartsResponsive>
                <ComposedChart data={fills} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...ui.grid} />
                  <XAxis dataKey="label" {...ui.xAxis} minTickGap={24} />
                  <YAxis {...ui.yAxis} width={40} domain={["dataMin - 3", "dataMax + 3"]} tickFormatter={(v: number) => `${Math.round(v)}`} />
                  <Tooltip {...ui.tooltip} formatter={(v) => [`${v} mpg`, "MPG"]} />
                  {f.mpg && <ReferenceLine y={+f.mpg.toFixed(1)} stroke={chart.axis} strokeDasharray="4 4" label={{ value: `avg ${f.mpg.toFixed(1)}`, fill: chart.axis, fontSize: 11, position: "insideTopRight" }} />}
                  <Line type="monotone" dataKey="mpg" name="MPG" stroke={chart.series[2]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                </ComposedChart>
              </RechartsResponsive>
            </div>
          </Card>
          <Card title="Price per gallon and fuel cost per mile" subtitle="What you paid at each fill, and what that fill's miles cost.">
            <div className="h-64">
              <RechartsResponsive>
                <ComposedChart data={fills} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...ui.grid} />
                  <XAxis dataKey="label" {...ui.xAxis} minTickGap={24} />
                  <YAxis yAxisId="gal" {...ui.yAxis} width={48} tickFormatter={(v: number) => `$${v.toFixed(2)}`} domain={["auto", "auto"]} />
                  <YAxis yAxisId="mi" orientation="right" {...ui.yAxis} width={48} tickFormatter={(v: number) => `$${v.toFixed(2)}`} domain={[0, "auto"]} />
                  <Tooltip {...ui.tooltip} formatter={(v, n) => [`$${Number(v).toFixed(3)}`, String(n)]} />
                  <Legend {...ui.legend} />
                  <Line yAxisId="gal" type="monotone" dataKey="price" name="$ / gallon" stroke={chart.series[1]} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                  <Line yAxisId="mi" type="monotone" dataKey="cpm" name="$ / mile" stroke={chart.series[0]} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                </ComposedChart>
              </RechartsResponsive>
            </div>
          </Card>
        </div>
      )}

      <Card title="Miles driven by month" subtitle={avgMonth ? `About ${miles(avgMonth)} miles in a full month. Read between odometer readings (the current month is partial).` : "Read between odometer readings."}>
        <div className="h-56">
          <RechartsResponsive>
            <BarChart data={driving} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={16} />
              <YAxis {...ui.yAxis} width={44} />
              <Tooltip {...ui.tooltip} formatter={(v) => [`${miles(Number(v))} mi`, "Miles"]} />
              {avgMonth && <ReferenceLine y={avgMonth} stroke={chart.axis} strokeDasharray="4 4" />}
              <Bar dataKey="miles" name="Miles" fill={chart.series[0]} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </RechartsResponsive>
        </div>
      </Card>

      {f.fills.length > 0 && (
        <Card title="Fill-ups">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <SortTh k="date" label="Date" sort={fillSort.sort} toggle={fillSort.toggle} />
                  <th className={table.thR}>Odometer</th>
                  <th className={table.thR}>Miles</th>
                  <th className={table.thR}>Gallons</th>
                  <SortTh k="amount" label="Cost" sort={fillSort.sort} toggle={fillSort.toggle} right />
                  <th className={table.thR}>$/gal</th>
                  <th className={table.thR}>MPG</th>
                  <th className={table.thR}>$/mile</th>
                  <th className={table.thR}>Range</th>
                </tr>
              </thead>
              <tbody>
                {sortRows(f.fills, fillSort.sort, { date: (x) => x.date, amount: (x) => x.cents ?? 0 }).map((x) => (
                  <tr key={`${x.date}-${x.odometer}`} className={table.tr}>
                    <td className={table.td}>
                      {fmtDate(x.date)}
                      {x.folded > 0 && <span className="ml-1 text-[11px] text-muted">(+{x.folded} partial)</span>}
                    </td>
                    <td className={table.tdR}>{miles(x.odometer)}</td>
                    <td className={table.tdR}>{miles(x.miles)}</td>
                    <td className={table.tdR}>{x.gallons.toFixed(3)}</td>
                    <td className={table.tdR}>{x.cents == null ? "—" : usd2(x.cents)}</td>
                    <td className={table.tdR} title={x.pricePerGallon == null ? "A fill-up in this span has no statement charge yet" : undefined}>{x.pricePerGallon == null ? "—" : usd2(Math.round(x.pricePerGallon))}</td>
                    <td className={`${table.tdR} ${f.mpg && x.mpg < f.mpg * 0.85 ? "text-warn" : ""}`}>{x.mpg.toFixed(1)}</td>
                    <td className={table.tdR}>{perMile(x.costPerMile, 3)}</td>
                    <td className={table.tdR}>{x.range ? miles(x.range) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
