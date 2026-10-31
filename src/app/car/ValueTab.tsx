"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { btn, Card, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import { newId } from "@/lib/car/settings";
import { usd0, usdDelta } from "@/lib/formatMoney";
import { useState } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { CarCtx } from "./CarClient";
import { CentsInput, fmtDate, perMile } from "./parts";
import { unswept } from "@/lib/book/proof/clearance";

export function ValueTab({ ctx }: { ctx: CarCtx }) {
  const { report: r, car: s, chart, saveCar, saving } = ctx;
  const ui = chartChrome(chart);
  const d = r.depreciation;
  const [date, setDate] = useState(r.today);
  const [priv, setPriv] = useState<number | null>(null);
  const [trade, setTrade] = useState<number | null>(null);
  const [source, setSource] = useState("KBB");

  const add = async () => {
    if (priv == null && trade == null) return;
    if (await saveCar({ ...s, values: [...s.values, { id: newId(), date, privateCents: priv, tradeInCents: trade, source }] })) {
      setPriv(null);
      setTrade(null);
    }
  };
  const data = r.values.series.map((x) => ({
    label: x.label,
    private: x.privateCents == null ? null : x.privateCents / 100,
    tradeIn: x.tradeInCents == null ? null : x.tradeInCents / 100,
    planned: x.planned == null ? null : x.planned / 100,
    trend: x.trend == null ? null : x.trend / 100,
  }));
  const valueNow = d.marketValueNow;

  return (
    <>
      <StatGrid cols={5}>
        <StatCell proof={unswept("All-in purchase")} label="All-in purchase" value={usd0(r.acquisition.cents)} sub={`vehicle ${usd0(s.purchase.priceCents)}`} />
        <StatCell proof={unswept("Lost to date (market)")} label={r.sold ? "Sold for" : "Worth now (market)"} value={usd0(valueNow)} sub={r.sold ? fmtDate(r.through) : r.values.latest ? `last checked ${fmtDate(r.values.latest.date)}` : "add a value check below"} />
        <StatCell proof={unswept("Lost to date (market)")} label="Lost to date (market)" value={usd0(d.marketToDate)} tone="neg" sub={d.marketPerYear != null ? `trend ${usdDelta(d.marketPerYear)} a year` : undefined} />
        <StatCell proof={unswept("Lost to date (planned)")} label="Lost to date (planned)" value={usd0(d.plannedToDate)} sub={`${perMile(d.plannedPerMile)} a mile to ${s.plan.sellAtMiles.toLocaleString("en-US")} mi`} />
        <StatCell proof={unswept("Planned value now")} label="Planned value now" value={usd0(d.plannedValueNow)} sub={valueNow != null && d.plannedValueNow != null ? `market is ${usdDelta(valueNow - d.plannedValueNow)} vs plan` : undefined} />
      </StatGrid>

      <Card
        title="What the car is worth"
        subtitle="Your value checks (private party and trade-in), against the planned straight line from the all-in price to the resale value you expect at the selling odometer. Dashed: the trend in your checks, carried forward."
        actions={
          <Segmented
            size="xs"
            ariaLabel="Headline depreciation"
            value={s.plan.depreciation}
            onChange={(v) => void saveCar({ ...s, plan: { ...s.plan, depreciation: v } })}
            options={[
              { value: "PLANNED", label: "Use planned", title: "Depreciation per mile, straight line to the selling odometer" },
              { value: "MARKET", label: "Use market", title: "All-in price less what the car is worth now" },
            ]}
          />
        }
      >
        <div className="h-72">
          <RechartsResponsive>
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={20} />
              <YAxis {...ui.yAxis} domain={["auto", "auto"]} tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`} />
              <Tooltip {...ui.tooltip} formatter={(v, n) => [usd0(Number(v) * 100), String(n)]} />
              <Legend {...ui.legend} />
              <ReferenceLine y={r.acquisition.cents / 100} stroke={chart.axis} strokeDasharray="2 4" label={{ value: "all-in price", fill: chart.axis, fontSize: 11, position: "insideTopLeft" }} />
              <Line type="linear" dataKey="planned" name="Planned" stroke={chart.neutral} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              <Line type="linear" dataKey="private" name="Private party" stroke={chart.series[0]} strokeWidth={2} dot={{ r: 4 }} connectNulls isAnimationActive={false} />
              <Line type="linear" dataKey="tradeIn" name="Trade-in" stroke={chart.series[1]} strokeWidth={2} dot={{ r: 4 }} connectNulls isAnimationActive={false} />
              <Line type="linear" dataKey="trend" name="Trend" stroke={chart.series[0]} strokeWidth={1.5} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </RechartsResponsive>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Add a value check" subtitle="Look the car up (Kelley Blue Book, Edmunds, a dealer offer) every few months; the trend uses every check.">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-fg-2">Date</span>
              <input type="date" className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-fg-2">Private party</span>
              <CentsInput cents={priv} onChange={setPriv} className="w-32" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-fg-2">Trade-in</span>
              <CentsInput cents={trade} onChange={setTrade} className="w-32" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-fg-2">Source</span>
              <input className="w-24 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg" value={source} onChange={(e) => setSource(e.target.value)} />
            </label>
            <button type="button" className={btn.primary} disabled={saving || (priv == null && trade == null) || !date} onClick={() => void add()}>
              Add
            </button>
          </div>
        </Card>
        <Card title="Value checks">
          {s.values.length === 0 ? (
            <p className="text-xs text-muted">None yet.</p>
          ) : (
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr className={table.head}>
                    <th className={table.th}>Date</th>
                    <th className={table.thR}>Private</th>
                    <th className={table.thR}>Trade-in</th>
                    <th className={table.thR}>Gap</th>
                    <th className={table.th}>Source</th>
                    <th className={table.th} />
                  </tr>
                </thead>
                <tbody>
                  {[...s.values].reverse().map((v) => (
                    <tr key={v.id} className={table.tr}>
                      <td className={table.td}>{fmtDate(v.date)}</td>
                      <td className={table.tdR}>{usd0(v.privateCents)}</td>
                      <td className={table.tdR}>{usd0(v.tradeInCents)}</td>
                      <td className={`${table.tdR} text-muted`} title="What selling it yourself is worth over trading it in">
                        {v.privateCents != null && v.tradeInCents != null ? usd0(v.privateCents - v.tradeInCents) : "—"}
                      </td>
                      <td className={`${table.td} text-muted`}>{v.source}</td>
                      <td className={`${table.td} text-right`}>
                        <button type="button" className={btn.link} disabled={saving} onClick={() => void saveCar({ ...s, values: s.values.filter((x) => x.id !== v.id) })}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
