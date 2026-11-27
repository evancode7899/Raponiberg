"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Card, EmptyState, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { returnsKey, SP500_SOURCE_WORDS } from "@/lib/book/derived/returns";
import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { noFigure } from "@/lib/book/proof/clearance";
import type { InvestmentsReport } from "@/lib/book/reports/investments";
import { axisUsd, formatPercentRatio, NA, usd0 } from "@/lib/formatMoney";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

const pct = (r: number, d = 2) => formatPercentRatio(r, d);
const NAMES: Record<string, string> = { portfolio: "Your portfolio", sp500: "S&P 500", actual: "Your portfolio", hypo: "All in the S&P 500", moneyIn: "Money in" };

/**
 * Investments › Returns (reports/portfolioReturns.ts, derived/returns.ts): the whole
 * portfolio against the S&P 500, quarter by quarter, back to the first quarter on file, and
 * what the same money would have come to had it all been in the S&P 500. Descriptive, not advice.
 */
export function ReturnsTab({ r, d }: { r: InvestmentsReport; d: DerivedFigure[] }) {
  const p = useChartPalette();
  const ui = chartChrome(p);
  const [view, setView] = useState<"bars" | "line">("bars");
  const ret = r.returns;
  const w = ret.window;
  const fig = (figure: string, key?: string) => derivedTarget("investments", d, figure, key);
  const q = (quarter: string, col: string) => fig("ret-quarter", returnsKey(quarter, col));

  const bars = useMemo(() => ret.quarters.map((x) => ({ quarter: x.quarter, label: x.label, portfolio: x.portfolio == null ? null : x.portfolio * 100, sp500: x.sp500 ? x.sp500.ratio * 100 : null })), [ret.quarters]);
  // Each quarter-end's return, chained from the start of the comparison.
  const line = useMemo(() => (w ? w.points.map((x) => ({ quarter: x.quarter, label: x.label, portfolio: x.portfolioCum * 100, sp500: x.sp500Cum * 100 })) : []), [w]);
  const dollars = useMemo(() => (w ? w.points.map((x) => ({ quarter: x.quarter, label: x.label, actual: x.actualCents / 100, hypo: x.sp500Cents / 100, moneyIn: x.moneyInCents / 100 })) : []), [w]);

  if (!ret.quarters.length) return <EmptyState title="No investment accounts on file yet" />;
  const last = w?.points.at(-1);
  const gapOf = (a: ProofRef, b: ProofRef, x: number, y: number) => compositeOf("diff", x >= y ? [a, b] : [b, a], { ratio: Math.abs(x - y) });
  const missing = ret.quarters.filter((x) => !x.sp500 && !x.through).length;

  return (
    <>
      {w && last ? (
        <>
          <StatGrid cols={4}>
            <StatCell proof={fig("ret-since", "portfolio")} label="Your portfolio" value={pct(last.portfolioCum, 1)} sub={`${w.fromLabel} – ${w.toLabel}, net of fees`} tone={last.portfolioCum < 0 ? "neg" : "neutral"} />
            <StatCell proof={fig("ret-since", "sp500")} label="S&P 500" value={pct(last.sp500Cum, 1)} sub="same quarters, dividends in" />
            <StatCell
              proof={gapOf(fig("ret-since", "portfolio"), fig("ret-since", "sp500"), last.portfolioCum, last.sp500Cum)}
              label={last.portfolioCum >= last.sp500Cum ? "Ahead by" : "Behind by"}
              value={pct(Math.abs(last.portfolioCum - last.sp500Cum), 1)}
              sub="percentage points, chained"
              tone={last.portfolioCum >= last.sp500Cum ? "pos" : "neg"}
            />
            <StatCell proof={fig("ret-ahead")} label="Quarters ahead" value={String((d.find((x) => x.figure === "ret-ahead")?.value as { text: string } | undefined)?.text ?? NA)} drawn="words" sub="of those with both returns" />
          </StatGrid>
          {w.annualized && (
            <StatGrid cols={3}>
              <StatCell proof={fig("ret-annualized", "portfolio")} label="Yours, a year" value={pct(w.annualized.portfolio, 1)} sub={`over ${(w.days / 365.25).toFixed(1)} years`} />
              <StatCell proof={fig("ret-annualized", "sp500")} label="S&P 500, a year" value={pct(w.annualized.sp500, 1)} sub="the same days" />
              <StatCell
                proof={gapOf(fig("ret-annualized", "portfolio"), fig("ret-annualized", "sp500"), w.annualized.portfolio, w.annualized.sp500)}
                label={w.annualized.portfolio >= w.annualized.sp500 ? "Ahead by, a year" : "Behind by, a year"}
                value={pct(Math.abs(w.annualized.portfolio - w.annualized.sp500), 1)}
                sub="percentage points a year"
                tone={w.annualized.portfolio >= w.annualized.sp500 ? "pos" : "neg"}
              />
            </StatGrid>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">No stretch of quarters has both returns yet, so there&apos;s nothing to chain.</p>
      )}

      <Card
        title={view === "bars" ? "Quarter by quarter" : `Since ${w?.fromLabel ?? "the start"}, chained`}
        subtitle={
          view === "bars"
            ? "Each quarter's return: yours time-weighted across every investment account, net of fees, with money in and out left out; the S&P 500's with dividends in, read off your own statements."
            : `Each quarter's return chained from the start of ${w?.fromLabel ?? "the comparison"}: where a dollar invested then stood at each quarter's end.`
        }
        actions={
          <Segmented
            view
            size="xs"
            ariaLabel="Chart"
            options={[
              { value: "bars", label: "Each quarter" },
              { value: "line", label: "Over time" },
            ]}
            value={view}
            onChange={setView}
          />
        }
      >
        <div className="h-[320px] w-full min-w-0">
          {view === "bars" ? (
            <RechartsResponsive
              tableTitle="Your portfolio vs the S&P 500, each quarter"
              cellProof={(row, key) => (row[key] == null ? noFigure(key === "sp500" ? "no S&P 500 figure on your statements for this quarter" : "this quarter's return depends on missing or failing data") : q(row.quarter as string, key))}
            >
              <BarChart data={bars} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barGap={1}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={8} />
                <YAxis {...ui.yAxis} tickFormatter={(v: number) => `${v}%`} />
                <ReferenceLine y={0} stroke={p.axisLine} />
                <Tooltip {...ui.tooltip} formatter={(v, n) => [v == null ? NA : pct(Number(v) / 100), NAMES[String(n)] ?? String(n)]} />
                <Legend {...ui.legend} formatter={(v) => NAMES[String(v)] ?? String(v)} />
                <Bar dataKey="portfolio" fill={p.series[0]} isAnimationActive={false} />
                <Bar dataKey="sp500" fill={p.series[1]} isAnimationActive={false} />
              </BarChart>
            </RechartsResponsive>
          ) : (
            <RechartsResponsive tableTitle={`Your portfolio vs the S&P 500, chained since ${w?.fromLabel ?? ""}`} cellProof={(row, key) => fig("ret-cum", returnsKey(row.quarter as string, key))}>
              <LineChart data={line} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={16} />
                <YAxis {...ui.yAxis} tickFormatter={(v: number) => `${v}%`} />
                <ReferenceLine y={0} stroke={p.axisLine} />
                <Tooltip {...ui.tooltip} formatter={(v, n) => [pct(Number(v) / 100), NAMES[String(n)] ?? String(n)]} />
                <Legend {...ui.legend} formatter={(v) => NAMES[String(v)] ?? String(v)} />
                <Line type="linear" dataKey="portfolio" stroke={p.series[0]} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                <Line type="linear" dataKey="sp500" stroke={p.series[1]} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
              </LineChart>
            </RechartsResponsive>
          )}
        </div>
        {view === "bars" && missing > 0 && <p className="mt-2 text-xs text-muted">{missing === 1 ? "One quarter has" : `${missing} quarters have`} no S&amp;P 500 fund or index figure on your statements, so it draws your bar alone.</p>}
      </Card>

      {w && last && (
        <Card
          title="Your portfolio vs the same money in the S&P 500"
          subtitle={`What every investment account held at each quarter's end, against what it would have come to had it all been in the S&P 500 since ${w.fromLabel}: the same starting balance and the same money in and out each month, grown by the S&P 500 (evenly through each quarter, from the middle of the month money went in).`}
        >
          <StatGrid cols={4}>
            <StatCell proof={fig("ret-value", returnsKey(last.quarter, "actual"))} label="Your portfolio" value={usd0(last.actualCents)} sub={`end of ${last.label}`} />
            <StatCell proof={fig("ret-value", returnsKey(last.quarter, "sp500"))} label="All in the S&P 500" value={usd0(last.sp500Cents)} sub="the same money, same days" />
            <StatCell
              proof={compositeOf("diff", last.actualCents >= last.sp500Cents ? [fig("ret-value", returnsKey(last.quarter, "actual")), fig("ret-value", returnsKey(last.quarter, "sp500"))] : [fig("ret-value", returnsKey(last.quarter, "sp500")), fig("ret-value", returnsKey(last.quarter, "actual"))], { cents: Math.abs(last.actualCents - last.sp500Cents) })}
              label={last.actualCents >= last.sp500Cents ? "You're ahead by" : "You're behind by"}
              value={usd0(Math.abs(last.actualCents - last.sp500Cents))}
              tone={last.actualCents >= last.sp500Cents ? "pos" : "neg"}
              sub="your portfolio less the S&P 500 one"
            />
            <StatCell proof={fig("ret-value", returnsKey(last.quarter, "money-in"))} label="Money in" value={usd0(last.moneyInCents)} sub={`on hand when ${w.fromLabel} began, plus net deposits`} />
          </StatGrid>
          <div className="mt-4 h-[300px] w-full min-w-0">
            <RechartsResponsive
              tableTitle={`Your portfolio vs all in the S&P 500 since ${w.fromLabel}`}
              cellProof={(row, key) => fig("ret-value", returnsKey(row.quarter as string, key === "actual" ? "actual" : key === "hypo" ? "sp500" : "money-in"))}
            >
              <LineChart data={dollars} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={16} />
                <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
                <Tooltip {...ui.tooltip} formatter={(v, n) => [usd0(Math.round(Number(v) * 100)), NAMES[String(n)] ?? String(n)]} />
                <Legend {...ui.legend} formatter={(v) => NAMES[String(v)] ?? String(v)} />
                <Line type="linear" dataKey="actual" stroke={p.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="hypo" stroke={p.series[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="moneyIn" stroke={p.neutral} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </RechartsResponsive>
          </div>
        </Card>
      )}

      <Card title="Every quarter" subtitle="Hover an S&P 500 figure for where it was read; click any figure for its proof.">
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[58rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Quarter</th>
                <th className={table.thR}>Yours</th>
                <th className={table.thR}>S&amp;P 500</th>
                <th className={table.thR}>Difference</th>
                <th className={table.thR} title={w ? `Chained from the start of ${w.fromLabel}` : undefined}>Yours, since start</th>
                <th className={table.thR} title={w ? `Chained from the start of ${w.fromLabel}` : undefined}>S&amp;P 500, since start</th>
                <th className={table.thR}>Your portfolio</th>
                <th className={table.thR}>All in the S&amp;P 500</th>
              </tr>
            </thead>
            <tbody>
              {[...ret.quarters].reverse().map((x) => {
                const pt = w?.points.find((y) => y.quarter === x.quarter);
                const both = x.portfolio != null && x.sp500;
                return (
                  <tr key={x.quarter} className={table.trHover}>
                    <td className={`${table.td} whitespace-nowrap`}>
                      {x.label}
                      {x.through && <span className="ml-1 text-xs text-muted">through {x.through}</span>}
                    </td>
                    <td className={table.tdR}>{x.portfolio == null ? <ProofValue proof={noFigure(x.blocked ? "this quarter's figures depend on missing or failing data" : "no investment account was measured")}>{NA}</ProofValue> : <ProofValue proof={q(x.quarter, "portfolio")}>{pct(x.portfolio)}</ProofValue>}</td>
                    <td className={table.tdR} title={x.sp500 ? `Read from ${SP500_SOURCE_WORDS[x.sp500.source.kind]}` : undefined}>
                      {x.sp500 ? <ProofValue proof={q(x.quarter, "sp500")}>{pct(x.sp500.ratio)}</ProofValue> : <ProofValue proof={noFigure(x.through ? "the quarter isn't over" : "no S&P 500 figure on your statements for this quarter")}>{NA}</ProofValue>}
                    </td>
                    <td className={`${table.tdR} ${both ? (x.portfolio! >= x.sp500!.ratio ? "text-pos" : "text-neg") : ""}`}>
                      {both ? <ProofValue proof={compositeOf("diff", [q(x.quarter, "portfolio"), q(x.quarter, "sp500")], { ratio: x.portfolio! - x.sp500!.ratio })}>{`${x.portfolio! > x.sp500!.ratio ? "+" : ""}${pct(x.portfolio! - x.sp500!.ratio)}`}</ProofValue> : NA}
                    </td>
                    <td className={table.tdR}>{pt ? <ProofValue proof={fig("ret-cum", returnsKey(x.quarter, "portfolio"))}>{pct(pt.portfolioCum)}</ProofValue> : NA}</td>
                    <td className={table.tdR}>{pt ? <ProofValue proof={fig("ret-cum", returnsKey(x.quarter, "sp500"))}>{pct(pt.sp500Cum)}</ProofValue> : NA}</td>
                    <td className={table.tdR}>{pt ? <ProofValue proof={fig("ret-value", returnsKey(x.quarter, "actual"))}>{usd0(pt.actualCents)}</ProofValue> : NA}</td>
                    <td className={table.tdR}>{pt ? <ProofValue proof={fig("ret-value", returnsKey(x.quarter, "sp500"))}>{usd0(pt.sp500Cents)}</ProofValue> : NA}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

