"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { btn, Callout, Card, NotFigure, Segmented, StatCell, StatGrid, table, WhatIf } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { axisUsd, formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import { defaultHomeBudgetInputs, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import { rentVsBuyFigures, SIM_YEARS, type RentVsBuyFigure } from "@/lib/home-budget/rentVsBuy";
import { useMemo } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { FundsState, Patch } from "./HomeBudgetClient";
import { GainsTaxControl } from "./InputsPanel";
import { Group, StackBar } from "./parts";
import { RangeSlider } from "./RangeSlider";
import { spec } from "./specs";

const DEF = defaultHomeBudgetInputs();

const LABELS: Partial<Record<keyof HomeBudgetInputs, string>> = {
  marketRentMonthly: "Rent / month",
  rentGrowthRate: "Rent increase / year",
  homeAppreciationRate: "Home appreciation / year",
  investmentReturnRate: "Investment return / year",
  sellingCostsPct: "Selling costs",
  horizonYears: "Years until you'd sell",
  capitalGainsTaxRate: "Capital gains tax",
  equityRiskPremium: "Equity risk premium",
};

export function RentVsBuyTab({ ins, patch, goToBudget, funds }: { ins: HomeBudgetInputs; patch: Patch; goToBudget: () => void; funds: FundsState }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  // One pure model (lib/home-budget/rentVsBuy.ts): the proof sweep re-runs it on the saved inputs.
  const r = useMemo(() => rentVsBuyFigures(ins), [ins]);
  const { b, snap, sim, horizon } = r;
  const ahead = r.values["rvb-ahead"];
  const tile = (figure: RentVsBuyFigure) => {
    const v = r.values[figure];
    return typeof v === "string" ? { ...funds.proof(figure, null), shown: { text: v } } : funds.proof(figure, v);
  };

  const S = (k: keyof HomeBudgetInputs, extra?: Partial<Parameters<typeof RangeSlider>[0]>) => {
    const sp = spec(k);
    return <RangeSlider key={k} label={LABELS[k] ?? k} hint={sp.hint} spec={sp} value={ins[k] as number} defaultValue={DEF[k] as number} onChange={(v) => patch(k, v as never)} {...extra} />;
  };
  // Rent band from a price-to-rent ratio of 15–25 (annual rent = 4–6.7% of price).
  const rentSpec = { ...spec("marketRentMonthly"), band: [Math.round(b.homePrice / 25 / 12 / 50) * 50, Math.round(b.homePrice / 15 / 12 / 50) * 50] as [number, number] };
  const priceToRent = ins.marketRentMonthly > 0 ? b.homePrice / (ins.marketRentMonthly * 12) : null;

  const rows = sim.years.map((y) => ({ year: y.year, Buy: Math.round(y.buyerWealth), Rent: Math.round(y.renterWealth) }));
  const snapSegments = snap.components.map((c, i) => ({ key: c.key, label: c.label, value: c.monthly, color: chart.series[i % chart.series.length]! }));
  const tableYears = sim.years.filter((y) => y.year <= 5 || y.year % 5 === 0 || y.year === horizon);

  return (
    <>
      <Callout
        tone={ahead >= 0 ? "good" : "info"}
        title={
          <>
            {ahead >= 0 ? "Buying" : "Renting"} comes out <ProofValue proof={tile("rvb-ahead")}>{formatUsd(Math.abs(ahead))}</ProofValue> ahead after {horizon} years
          </>
        }
      >
        <WhatIf inline why="both households, year by year">
        {sim.breakEvenYear
          ? `${sim.breakEvenYear === 1 ? "Buying is ahead from the first year" : `Buying overtakes renting in year ${sim.breakEvenYear}`}${sim.breakEvenYear > horizon ? ` — after you'd sell, so stay ${sim.breakEvenYear}+ years for it to pay` : ""}.`
          : `Buying never catches up within ${SIM_YEARS} years at these assumptions.`}{" "}
        Both households start with the same {formatUsd(sim.upfrontCash)} and spend the same each month; whoever&apos;s housing costs less invests the difference.
        {sim.renterSetup > 0 && ` The renter spends ${formatUsd(sim.renterSetup)} of it on moving and furniture — half the buyer's renovation / furnishing budget.`}
        </WhatIf>
      </Callout>

      <StatGrid cols={4}>
        <StatCell proof={tile("rvb-ahead")} label="Ahead by buying" value={formatUsd(ahead)} tone={ahead >= 0 ? "pos" : "neg"} sub={`net worth if you sell in year ${horizon}`} />
        <StatCell proof={tile("rvb-break-even")} label="Break-even" value={r.values["rvb-break-even"]} tone={sim.breakEvenYear && sim.breakEvenYear <= horizon ? "pos" : "warn"} sub={`within ${SIM_YEARS} years`} />
        <StatCell proof={tile("rvb-owning")} label="Owning, year one" value={`${formatUsd(r.values["rvb-owning"])}/mo`} sub={<WhatIf inline why="owning's cost as a share of the price you typed">{`unrecoverable · ${formatPercentRatio(snap.totalCostOfHomeOwnershipAnnualPct, 2)} of value a year`}</WhatIf>} />
        <StatCell proof={tile("rvb-rent")} label="Renting" value={`${formatUsd(r.values["rvb-rent"])}/mo`} sub={priceToRent ? `price-to-rent ratio ${priceToRent.toFixed(1)}` : undefined} />
      </StatGrid>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="The home"
            subtitle="From the Test a price tab."
            actions={
              <button type="button" className={btn.ghost} onClick={goToBudget}>
                Change
              </button>
            }
          >
            <WhatIf why="the home you typed on Test a price" className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-muted">Price</span>
              <span className="num text-right font-medium">{formatUsd(b.homePrice)}</span>
              <span className="text-muted">Down payment</span>
              <span className="num text-right font-medium">{formatPercentRatio(b.downPaymentPct, 1)} · {formatUsd(b.downPaymentDollars)}</span>
              <span className="text-muted">Mortgage</span>
              <span className="num text-right font-medium">{formatPercentRatio(ins.annualMortgageRate, 3)} · {ins.mortgageTermYears} yr</span>
              <span className="text-muted">Cash in on day one</span>
              <span className="num text-right font-medium">{formatUsd(sim.upfrontCash)}</span>
            </WhatIf>
          </Card>

          <Card title="Assumptions">
            <Group title="Renting">
              {S("marketRentMonthly", { spec: rentSpec, hint: "Rent for a comparable home. Typical band: price-to-rent ratio of 15–25." })}
              {S("rentGrowthRate")}
            </Group>
            <Group title="Markets">
              {S("homeAppreciationRate")}
              {S("investmentReturnRate", {
                onChange: (v: number) => {
                  patch("investmentReturnRate", v);
                  if (funds.returns.linked) funds.setConfig({ ...funds.config, returns: "manual" });
                },
                extra:
                  funds.returns.forecast == null ? undefined : funds.returns.linked ? (
                    <NotFigure why="your setting (Forecast)">Linked: the Forecast&apos;s return ({formatPercentRatio(funds.returns.forecast, 1)}). Moving it types your own.</NotFigure>
                  ) : (
                    <button type="button" className="text-accent hover:underline" onClick={() => funds.setConfig({ ...funds.config, returns: "forecast" })}>
                      <NotFigure why="your setting (Forecast)">use the Forecast&apos;s return ({formatPercentRatio(funds.returns.forecast, 1)})</NotFigure>
                    </button>
                  ),
              })}
              <GainsTaxControl ins={ins} patch={patch} funds={funds} full />
            </Group>
            <Group title="Selling">
              {S("horizonYears")}
              {S("sellingCostsPct")}
              <div className="flex items-center justify-between gap-2 py-2">
                <span className="text-xs font-medium text-fg-2" title="Home-sale gain excluded from tax under §121">
                  Tax-free home gain
                </span>
                <Segmented
                  size="xs"
                  ariaLabel="Home sale exclusion"
                  options={[
                    { value: "500000", label: <NotFigure why="set by law">$500k joint</NotFigure> },
                    { value: "250000", label: <NotFigure why="set by law">$250k single</NotFigure> },
                    { value: "0", label: "None" },
                  ]}
                  value={String(ins.homeSaleExclusion)}
                  onChange={(v) => patch("homeSaleExclusion", Number(v))}
                />
              </div>
            </Group>
            <Group title="Year-one snapshot">{S("equityRiskPremium")}</Group>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-14 lg:self-start">
          <Card title="Net worth if you sold that year" subtitle="After selling costs, mortgage payoff and capital-gains tax on both sides.">
            <div className="h-[280px] w-full min-w-0">
              <RechartsResponsive>
                <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid {...ui.grid} />
                  <XAxis dataKey="year" {...ui.xAxis} tickFormatter={(v: number) => `Y${v}`} />
                  <YAxis {...ui.yAxis} tickFormatter={axisUsd} width={64} />
                  <Tooltip {...ui.tooltip} labelFormatter={(l) => `Sell in year ${l}`} formatter={(v, n) => [formatUsd(Number(v)), n === "Buy" ? "Buyer" : "Renter"]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === "Buy" ? "Buy" : "Rent and invest")} />
                  <ReferenceLine x={horizon} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: "You sell", position: "insideTopLeft", fontSize: 10, fill: chart.axis }} />
                  {sim.breakEvenYear && <ReferenceLine x={sim.breakEvenYear} stroke={chart.series[2]} strokeDasharray="2 3" />}
                  <Line type="monotone" dataKey="Buy" stroke={chart.series[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="Rent" stroke={chart.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </RechartsResponsive>
            </div>
          </Card>

          <Card title="Year one: the cost of owning vs rent" subtitle="Money that's gone each month, not equity: interest, tax, upkeep, insurance and what the cash in the home would otherwise earn.">
            <WhatIf why="year one's cost of owning the home you typed">
            <StackBar
              segments={snapSegments}
              marker={{ value: ins.marketRentMonthly, label: `Rent ${formatUsd(ins.marketRentMonthly)}` }}
              overLabel={(o) => `Owning costs ${formatUsd(o)} a month more than renting in year one.`}
            />
            {snap.advantageToBuy > 0 && <p className="mt-2 text-xs font-medium text-pos">Owning costs {formatUsd(snap.advantageToBuy)} a month less than renting in year one.</p>}
            </WhatIf>
          </Card>

          <Card title="Year by year">
            <WhatIf why="buying vs renting, year by year" className="max-h-[360px] overflow-auto">
              <table className={`${table.table} min-w-[640px]`}>
                <thead className={table.head}>
                  <tr>
                    <th className={table.th}>Year</th>
                    <th className={table.thR}>Home value</th>
                    <th className={table.thR}>Loan left</th>
                    <th className={table.thR}>Owning / mo</th>
                    <th className={table.thR}>Rent / mo</th>
                    <th className={table.thR}>Buyer</th>
                    <th className={table.thR}>Renter</th>
                    <th className={table.thR}>Buy − rent</th>
                  </tr>
                </thead>
                <tbody>
                  {tableYears.map((y) => (
                    <tr key={y.year} className={`${table.tr} ${y.year === horizon ? "bg-accent-soft" : ""}`}>
                      <td className={table.td}>{y.year}</td>
                      <td className={table.tdR}>{formatUsd(y.homeValue)}</td>
                      <td className={table.tdR}>{formatUsd(y.loanBalance)}</td>
                      <td className={table.tdR}>{formatUsd(y.ownerMonthlyCost)}</td>
                      <td className={table.tdR}>{formatUsd(y.rentMonthly)}</td>
                      <td className={table.tdR}>{formatUsd(y.buyerWealth)}</td>
                      <td className={table.tdR}>{formatUsd(y.renterWealth)}</td>
                      <td className={`${table.tdR} font-semibold ${y.buyAdvantage >= 0 ? "text-pos" : "text-neg"}`}>{formatUsd(y.buyAdvantage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </WhatIf>
            <p data-not-figure="how the table counts" className="mt-2 text-[11px] leading-snug text-faint">
              Owning / mo is the cash cost (mortgage, tax, insurance, upkeep, HOA, and mortgage insurance under 20% down until the loan reaches 78% of the price), excluding utilities, which both pay. The mortgage-interest deduction is ignored.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
