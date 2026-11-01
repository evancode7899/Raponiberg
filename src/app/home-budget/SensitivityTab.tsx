"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Card, NotFigure, WhatIf } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { HomeProof } from "./HomeBudgetClient";
import { axisUsd, formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import { computeMaxApproval, computeSensitivityCell, sensitivityAxes, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

const RATES = Array.from({ length: 13 }, (_, i) => 0.04 + i * 0.005);
const k = (v: number) => (v >= 1_000_000 ? `$${+(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}k`);

export function SensitivityTab({ ins, proof, salaryLinked }: { ins: HomeBudgetInputs; proof: HomeProof; salaryLinked: boolean }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const { homePrices, incomes } = useMemo(() => sensitivityAxes(ins), [ins]);
  const grid = useMemo(() => homePrices.map((hp) => incomes.map((inc) => computeSensitivityCell(inc, hp, ins))), [homePrices, incomes, ins]);
  const scale = Math.max(1, ...grid.flat().map(Math.abs));
  const nearest = (xs: number[], v: number) => xs.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), xs[0]!);
  const curPrice = nearest(homePrices, ins.budgetHomePrice);
  const curIncome = nearest(incomes, ins.annualHouseholdSalary);

  const byPrice = useMemo(() => homePrices.map((hp) => ({ price: hp, left: Math.round(computeSensitivityCell(ins.annualHouseholdSalary, hp, ins)) })), [homePrices, ins]);
  const byRate = useMemo(() => RATES.map((r) => ({ rate: r, max: Math.round(computeMaxApproval({ ...ins, annualMortgageRate: r }).impliedMaxHomeValue) })), [ins]);
  const curMax = computeMaxApproval(ins).impliedMaxHomeValue;

  return (
    <>
      <Card
        title="Left to spend each month"
        subtitle={<NotFigure why="how the grid is laid out">By home price and household salary, with 25% down and every other input as on the other tabs. Your row and column are outlined.</NotFigure>}
      >
        <WhatIf why="left to spend at each price and salary" className="app-scroll overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-0.5 text-xs">
            <thead>
              <tr>
                <th className="px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted">Price \ salary</th>
                {incomes.map((inc) => (
                  <th key={inc} className={`num px-2 py-1.5 text-right font-semibold ${inc === curIncome ? "text-accent" : "text-fg"}`}>
                    {k(inc)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {homePrices.map((hp, i) => (
                <tr key={hp}>
                  <th className={`num px-2 py-1.5 text-left font-semibold ${hp === curPrice ? "text-accent" : "text-fg"}`}>{k(hp)}</th>
                  {incomes.map((inc, j) => {
                    const v = grid[i]![j]!;
                    const strength = Math.round(8 + (Math.abs(v) / scale) * 32);
                    const mine = hp === curPrice || inc === curIncome;
                    return (
                      <td
                        key={inc}
                        className={`num rounded px-2 py-1.5 text-right ${v < 0 ? "text-neg" : "text-fg"} ${hp === curPrice && inc === curIncome ? "font-bold ring-2 ring-accent" : mine ? "font-medium ring-1 ring-line-strong" : ""}`}
                        style={{ background: `color-mix(in srgb, var(${v < 0 ? "--neg" : "--pos"}) ${strength}%, transparent)` }}
                      >
                        {formatUsd(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </WhatIf>
      </Card>

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Card
          title="Left to spend vs home price"
          subtitle={
            <>
              At your salary of{" "}
              {salaryLinked ? <ProofValue proof={proof("salary", ins.annualHouseholdSalary)}>{formatUsd(ins.annualHouseholdSalary)}</ProofValue> : <NotFigure why="your input">{formatUsd(ins.annualHouseholdSalary)}</NotFigure>},{" "}
              <NotFigure why="the chart's assumption">25%</NotFigure> down.
            </>
          }
        >
          <div className="h-[260px] w-full min-w-0">
            <RechartsResponsive>
              <LineChart data={byPrice} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="price" {...ui.xAxis} tickFormatter={k} />
                <YAxis {...ui.yAxis} tickFormatter={axisUsd} width={64} />
                <Tooltip {...ui.tooltip} labelFormatter={(l) => `Home ${formatUsd(Number(l))}`} formatter={(v) => [formatUsd(Number(v)), "Left / month"]} />
                <ReferenceLine y={0} stroke={chart.axisLine} />
                <Line type="monotone" dataKey="left" stroke={chart.series[0]} strokeWidth={2} dot={{ r: 3, fill: chart.series[0] }} isAnimationActive={false} />
              </LineChart>
            </RechartsResponsive>
          </div>
        </Card>

        <Card title="Most you can afford vs mortgage rate" subtitle={<NotFigure why="your inputs">{`Same cap (${formatPercentRatio(ins.housingCostMaxOfGross, 1)} of gross) and cash. Dot: today's ${formatPercentRatio(ins.annualMortgageRate, 3)}.`}</NotFigure>}>
          <div className="h-[260px] w-full min-w-0">
            <RechartsResponsive>
              <LineChart data={byRate} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="rate" type="number" domain={[RATES[0]!, RATES.at(-1)!]} ticks={RATES.filter((_, i) => i % 2 === 0)} {...ui.xAxis} tickFormatter={(v: number) => `${+(v * 100).toFixed(1)}%`} />
                <YAxis {...ui.yAxis} tickFormatter={axisUsd} width={64} domain={["auto", "auto"]} />
                <Tooltip {...ui.tooltip} labelFormatter={(l) => `Rate ${(Number(l) * 100).toFixed(2)}%`} formatter={(v) => [formatUsd(Number(v)), "Max price"]} />
                <Line type="monotone" dataKey="max" stroke={chart.series[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
                <ReferenceDot x={ins.annualMortgageRate} y={curMax} r={5} fill={chart.series[1]} stroke={chart.tooltipBg} />
              </LineChart>
            </RechartsResponsive>
          </div>
        </Card>
      </div>
    </>
  );
}
