"use client";

import { useChartPalette } from "@/components/shell/chartPalette";
import { Badge, btn, Callout, Card } from "@/components/ui/kit";
import { formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import { computeBudgetScenario, priceForHousingShare, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import { useMemo, type ReactNode } from "react";
import type { Patch } from "./HomeBudgetClient";
import { spendingFit, StackBar, StressGauge, stressOf } from "./parts";

export function PriceTab({
  ins,
  patch,
  maxPrice,
  lenderMaxPrice,
  allCashDownPct,
  spendMonthly,
}: {
  ins: HomeBudgetInputs;
  patch: Patch;
  maxPrice: number;
  lenderMaxPrice: number;
  allCashDownPct: number;
  spendMonthly: number | null;
}) {
  const chart = useChartPalette();
  const b = useMemo(() => computeBudgetScenario(ins), [ins]);
  const cap = ins.housingCostMaxOfGross;
  const stress = stressOf(b.housingPctOfGrossIncome, cap);
  const takeHome = b.monthlyIncome * (1 - ins.incomeTaxRate);
  const ofTakeHome = takeHome > 0 ? b.monthlyTotalHousing / takeHome : 0;
  const left = b.remainingDiscretionaryMonthly;
  const short = b.cashSurplus < -0.5;
  const vsMax = b.homePrice - maxPrice;
  const capPrice = priceForHousingShare(ins, cap);
  const fit = spendMonthly != null ? spendingFit(left, spendMonthly) : null;

  const housingSegments = [
    { key: "pmt", label: "Mortgage (P&I)", value: b.monthlyMortgagePayment, color: chart.series[0]! },
    { key: "tax", label: "Property tax", value: b.monthlyPropertyTax, color: chart.series[1]! },
    { key: "ins", label: "Insurance", value: b.monthlyInsurance, color: chart.series[2]! },
    { key: "maint", label: "Maintenance", value: b.monthlyMaintenance, color: chart.series[3]! },
    { key: "util", label: "Utilities", value: b.monthlyUtilities, color: chart.series[4]! },
    { key: "hoa", label: "HOA", value: b.monthlyHoa, color: chart.series[6]! },
    { key: "mi", label: "Mortgage insurance", value: b.monthlyMortgageInsurance, color: chart.series[7]! },
  ];
  const paySegments = [
    { key: "tax", label: "Income tax", value: b.incomeTaxMonthly, color: chart.neutral },
    { key: "housing", label: "Housing", value: b.monthlyTotalHousing, color: chart.series[0]! },
    { key: "save", label: "Savings target", value: ins.minimumMonthlySavings, color: chart.series[2]! },
    { key: "left", label: "Left to spend", value: Math.max(0, left), color: chart.series[3]! },
  ];
  const cashSegments = [
    { key: "down", label: `Down payment (${formatPercentRatio(b.downPaymentPct, 1)})`, value: b.downPaymentDollars, color: chart.series[0]! },
    { key: "closing", label: "Closing costs", value: b.closingCostsDollars, color: chart.series[1]! },
    { key: "reno", label: "Renovation / furnishing", value: b.renovationDollars, color: chart.series[3]! },
    { key: "spare", label: "Unused", value: Math.max(0, b.cashSurplus), color: chart.neutral },
  ];

  const fixes: ReactNode[] = [];
  if (short)
    fixes.push(
      <Callout
        key="cash"
        tone="bad"
        title={`${formatUsd(-b.cashSurplus)} short of cash at closing`}
        action={
          allCashDownPct >= 0.03 ? (
            <button type="button" className={btn.secondary} onClick={() => patch("budgetDownPaymentPct", Math.floor(allCashDownPct * 200) / 200)}>
              Use {formatPercentRatio(Math.floor(allCashDownPct * 200) / 200, 1)} down
            </button>
          ) : undefined
        }
      >
        Down payment, closing and renovation need {formatUsd(b.cashNeeded)}; the cash for the home is {formatUsd(ins.cashForHome)}.
      </Callout>,
    );
  if (left < 0)
    fixes.push(
      <Callout key="left" tone="bad" title={`${formatUsd(-left)} a month short`}>
        Income tax, housing and the {formatUsd(ins.minimumMonthlySavings)} savings target add up to more than gross pay.
      </Callout>,
    );
  if (b.downPaymentPct < 0.2 && ins.annualMortgageInsuranceRateOnLoan === 0)
    fixes.push(
      <Callout key="pmi" tone="warn" title="Under 20% down — expect mortgage insurance">
        Lenders usually charge PMI below 20% down; add it under Mortgage to see the real monthly cost.
      </Callout>,
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* The verdict. */}
      <section className="min-w-0 rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              A <span className="num normal-case text-fg">{formatUsd(b.homePrice)}</span> home costs
              <Badge tone={stress.tone}>{stress.label}</Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
              <span className="num text-4xl font-semibold tracking-tight text-fg sm:text-5xl">{formatUsd(b.monthlyTotalHousing)}</span>
              <span className="text-sm text-muted">a month, all-in</span>
            </div>
            <p className="mt-2 text-sm text-fg-2">
              <span className="num font-semibold text-fg">{formatPercentRatio(b.housingPctOfGrossIncome, 1)}</span> of gross pay ·{" "}
              <span className="num font-semibold text-fg">{formatPercentRatio(ofTakeHome, 1)}</span> of take-home ({formatUsd(takeHome)}/mo after {formatPercentRatio(ins.incomeTaxRate, 1)} tax)
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-1">
              {[-50_000, -10_000, 10_000, 50_000].map((d) => (
                <button key={d} type="button" className={`${btn.secondary} num !px-2 text-xs`} onClick={() => patch("budgetHomePrice", Math.max(0, ins.budgetHomePrice + d))}>
                  {d > 0 ? "+" : "−"}${Math.abs(d) / 1000}k
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              <button type="button" className={`${btn.ghost} text-xs`} onClick={() => patch("budgetHomePrice", Math.round(capPrice / 1000) * 1000)} title="The price where housing lands exactly on your limit at this down payment">
                Price at your limit
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <StressGauge share={b.housingPctOfGrossIncome} cap={cap} priceAt={(s) => priceForHousingShare(ins, s)} youLabel={`This home ${formatPercentRatio(b.housingPctOfGrossIncome, 1)}`} />
          <p className="mt-1 text-[11px] text-faint">Housing as a share of gross pay. Prices under each mark: what lands on it at {formatPercentRatio(b.downPaymentPct, 1)} down.</p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
          <Tile
            label="Left to spend"
            value={`${formatUsd(left)}/mo`}
            tone={left < 0 ? "neg" : "pos"}
            sub={
              spendMonthly != null ? (
                <>
                  you spend {formatUsd(spendMonthly)}/mo outside housing{fit?.label ? <> · <Badge tone={fit.tone}>{fit.label}</Badge></> : null}
                </>
              ) : (
                `after tax, housing, ${formatUsd(ins.minimumMonthlySavings)} savings`
              )
            }
          />
          <Tile label={short ? "Cash short" : "Cash to spare"} value={formatUsd(Math.abs(b.cashSurplus))} tone={short ? "neg" : "neutral"} sub={`needs ${formatUsd(b.cashNeeded)} of ${formatUsd(ins.cashForHome)}`} />
          <Tile label={vsMax > 0 ? "Over your max" : "Under your max"} value={formatUsd(Math.abs(vsMax))} tone={vsMax > 0 ? "neg" : "neutral"} sub={`max ${formatUsd(Math.round(maxPrice / 1000) * 1000)} with all cash in · lender ${formatUsd(Math.floor(lenderMaxPrice / 1000) * 1000)}`} />
          <Tile label="Loan" value={formatUsd(b.loanAmount)} sub={`${formatPercentRatio(b.downPaymentPct, 1)} down · ${formatUsd(b.monthlyMortgagePayment)}/mo P&I`} />
        </div>
      </section>

      {fixes}

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Card title="Where a month of pay goes" subtitle={`${formatUsd(b.monthlyIncome)} gross a month.`}>
          <StackBar segments={paySegments} scale={Math.max(b.monthlyIncome, b.incomeTaxMonthly + b.monthlyTotalHousing + ins.minimumMonthlySavings)} />
        </Card>
        <Card title="Monthly housing vs your limit" subtitle={`Limit ${formatUsd(b.monthlyIncome * cap)} — ${formatPercentRatio(cap, 1)} of gross.`}>
          <StackBar
            segments={housingSegments}
            marker={{ value: b.monthlyIncome * cap, label: `Limit ${formatUsd(b.monthlyIncome * cap)}` }}
            overLabel={(o) => `${formatUsd(o)} a month over your limit.`}
          />
        </Card>
      </div>
      <Card title="Cash at closing" subtitle={`${formatUsd(b.cashNeeded)} needed of ${formatUsd(ins.cashForHome)} set aside for the home.`}>
        <StackBar
          segments={cashSegments}
          marker={{ value: ins.cashForHome, label: `Cash for the home ${formatUsd(ins.cashForHome)}` }}
          overLabel={(o) => `${formatUsd(o)} more cash than you've set aside — lower the down payment or price, or commit more.`}
        />
      </Card>
    </div>
  );
}

function Tile({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: ReactNode; tone?: "neutral" | "pos" | "neg" }) {
  const cls = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg";
  return (
    <div className="min-w-0 bg-surface px-3 py-2.5">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`num mt-0.5 text-lg font-semibold ${cls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</div>}
    </div>
  );
}
