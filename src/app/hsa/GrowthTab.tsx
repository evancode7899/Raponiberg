"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Card, StatCell, StatGrid, table } from "@/components/ui/kit";
import { axisUsd, formatPercentRatio, formatUsdCents, usd0 } from "@/lib/formatMoney";
import { KIND_LABEL, type ExpenseKind } from "@/lib/hsa/qualify";
import type { Breakdown, HsaReport } from "@/lib/hsa/report";
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

const RATE_SOURCE = { SETTING: "your setting", MEASURED: "your HSA's measured return", DEFAULT: "a long-run stock-market assumption" };
const MARGINAL_SOURCE = { SETTING: "your setting", RETIREMENT: "the Account limits page", DEFAULT: "an assumed bracket" };

export function GrowthTab({ r }: { r: HsaReport }) {
  const g = r.growth;
  const p = useChartPalette();
  const chrome = chartChrome(p);
  const a = g.assumptions;
  const edge = g.futureValueCents - g.taxableValueCents;
  const scale = r.totals.unreimbursedCents / 100_000;
  const taxableTerms = `${formatPercentRatio(a.dividendYield, 1)} dividends taxed yearly and ${formatPercentRatio(a.taxableRate, 0)} on the gain when sold`;
  return (
    <>
      <StatGrid cols={3}>
        <StatCell label={`Worth in ${g.planYear}`} value={usd0(g.futureValueCents)} tone="accent" sub={`today's ${usd0(r.totals.unreimbursedCents)} of receipts left invested ${g.years} years at ${formatPercentRatio(g.rate, 1)}, after any tax`} />
        <StatCell
          label={a.growthCovered ? "Tax-free growth by then" : "Growth by then, after tax"}
          value={usd0(g.futureValueCents - r.totals.unreimbursedCents)}
          tone="pos"
          sub={a.growthCovered ? "on top of the receipts; tax-free as long as later medical bills cover it" : `on top of the receipts, taxed at ${formatPercentRatio(a.exitRate, 0)} with no receipt behind it`}
        />
        <StatCell label="Edge over reimbursing now" value={usd0(edge)} tone={edge > 0 ? "pos" : "neutral"} sub={`vs. ${usd0(g.taxableValueCents)} if reimbursed today and invested in a taxable account (${taxableTerms})`} />
      </StatGrid>

      <Card
        title={`Letting the receipts ride until ${g.planYear}`}
        subtitle={`Today's unreimbursed total left in the HSA vs. reimbursed today and invested in a taxable account (${taxableTerms}). Both lines are after every tax, as if taken out that year. Growth: ${formatPercentRatio(g.rate, 1)} from ${RATE_SOURCE[g.rateSource]}. All set on Settings.`}
      >
        {r.totals.unreimbursedCents === 0 ? (
          <p className="text-xs text-muted">Nothing unreimbursed to project.</p>
        ) : (
          <div className="h-64">
            <RechartsResponsive>
              <LineChart data={g.path.map((x) => ({ year: x.year, hsa: x.hsaCents / 100, taxable: x.taxableCents / 100 }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...chrome.grid} />
                <XAxis dataKey="year" {...chrome.xAxis} />
                <YAxis {...chrome.yAxis} tickFormatter={axisUsd} />
                <Tooltip {...chrome.tooltip} formatter={(v) => usd0(Number(v) * 100)} />
                <Legend {...chrome.legend} />
                <Line type="monotone" dataKey="hsa" name="Left in the HSA" stroke={p.series[2]} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="taxable" name="Reimbursed now, in a taxable account" stroke={p.neutral} strokeWidth={2} strokeDasharray="4 3" dot={false} />
              </LineChart>
            </RechartsResponsive>
          </div>
        )}
      </Card>

      <Card
        title="Three ways to pay a medical bill"
        subtitle={`Per $1,000 of bills, with the HSA contribution made either way, reimbursed in ${g.planYear} (${g.years} years). Ahead is your wealth in ${g.planYear} vs. no HSA, after every tax: whatever a way costs less today is invested in a taxable account, plus what comes out of the HSA. Waiting only works if you can cash-flow the bills and keep the receipts.`}
      >
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>How</th>
                <th className={table.thR} title="Pay before tax this uses today: the HSA contribution plus the pay that earned any bank money for the bill">
                  Pay used now
                </th>
                <th className={table.thR} title="The same, after tax: take-home pay it costs today">
                  Cost now, after tax
                </th>
                <th className={table.thR} title="Income and payroll tax not paid on the HSA contribution">
                  Tax saved
                </th>
                <th className={table.thR} title={`After-tax money out of the HSA in ${g.planYear}: the receipt's amount plus its growth`}>
                  Out of the HSA, {g.planYear}
                </th>
                <th className={table.thR}>Ahead in {g.planYear}</th>
                {scale > 0 && <th className={table.thR}>On your {usd0(r.totals.unreimbursedCents)}</th>}
              </tr>
            </thead>
            <tbody>
              {g.strategy.map((s) => (
                <tr key={s.key} className={`${table.tr} ${s.key === "LATER" ? "font-semibold" : ""}`}>
                  <td className={`${table.td} min-w-[18rem]`}>
                    <div className="text-fg">{s.label}</div>
                    <div className="text-[11px] font-normal text-muted">{s.note}</div>
                  </td>
                  <td className={table.tdR}>{usd0(s.payNowCents)}</td>
                  <td className={table.tdR}>{usd0(s.costNowCents)}</td>
                  <td className={table.tdR}>{usd0(s.taxSavedCents)}</td>
                  <td className={table.tdR}>{usd0(s.hsaLaterCents)}</td>
                  <td className={`${table.tdR} ${s.aheadCents > 0 ? "text-pos" : s.aheadCents < 0 ? "text-neg" : ""}`}>{usd0(s.aheadCents)}</td>
                  {scale > 0 && <td className={`${table.tdR} ${s.aheadCents > 0 ? "text-pos" : s.aheadCents < 0 ? "text-neg" : ""}`}>{usd0(Math.round(s.aheadCents * scale))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          Tax saved uses {formatPercentRatio(g.marginalRate, 0)} income tax ({MARGINAL_SOURCE[g.marginalSource]}) + {formatPercentRatio(a.payrollRate, 2)} payroll tax. Not counted: employer contributions (they make having an HSA better still, but they arrive however you pay a bill), the plan&apos;s premium and deductible, and account fees. The tax saved is assumed invested, not spent; spending it lowers both HSA rows by the same amount, so waiting&apos;s edge over paying now doesn&apos;t change.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By year" subtitle="Bills by the year they were paid, and reimbursements by the year they were taken. Reimbursed in year is what the 1099-SA's distributions should be backed by on Form 8889.">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Year</th>
                  <th className={table.thR}>Bills</th>
                  <th className={table.thR}>Paid</th>
                  <th className={table.thR}>Still open</th>
                  <th className={table.thR}>Reimbursed in year</th>
                </tr>
              </thead>
              <tbody>
                {r.years.map((y) => (
                  <tr key={y.year} className={table.tr}>
                    <td className={`${table.td} num`}>{y.year}</td>
                    <td className={table.tdR}>{y.count}</td>
                    <td className={table.tdR}>{formatUsdCents(y.totalCents)}</td>
                    <td className={table.tdR}>{formatUsdCents(y.unreimbursedCents)}</td>
                    <td className={table.tdR}>{formatUsdCents(y.reimbursedInYearCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          <BreakdownCard title="By patient" rows={r.byPatient} label={(k) => k} />
          <BreakdownCard title="By kind of care" rows={r.byKind} label={(k) => KIND_LABEL[k as ExpenseKind] ?? k} />
        </div>
      </div>

      <Card title="The rules this relies on" subtitle="A summary, not tax advice.">
        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-fg-2">
          <li>Any qualified medical expense (IRS Publication 502) incurred after the HSA was established can be reimbursed tax-free, with no deadline — years or decades later.</li>
          <li>Keep the receipt or EOB for every expense you reimburse, and keep it for as long as the reimbursement&apos;s tax year could be examined. The log notes where each one lives.</li>
          <li>An expense can be reimbursed once, and not if it was also deducted as an itemized medical expense or paid by insurance or an FSA.</li>
          <li>Each year&apos;s withdrawals arrive on a 1099-SA; Form 8889 reports them, with the qualified expenses they paid (the Reimbursed in year column).</li>
          <li>After 65, withdrawals for anything are taxed like a traditional IRA, but withdrawals backed by these receipts stay tax-free — so a long receipt log is flexibility you keep.</li>
          <li>Most states follow the federal treatment; California and New Jersey tax HSA contributions and growth.</li>
        </ul>
      </Card>
    </>
  );
}

function BreakdownCard({ title, rows, label }: { title: string; rows: Breakdown[]; label: (key: string) => string }) {
  const max = Math.max(1, ...rows.map((x) => x.totalCents));
  return (
    <Card title={title}>
      <ul className="flex flex-col gap-2 text-xs">
        {rows.map((b) => (
          <li key={b.key}>
            <div className="mb-0.5 flex justify-between gap-3">
              <span className="text-fg">
                {label(b.key)} <span className="text-muted">· {b.count}</span>
              </span>
              <span className="num text-fg">
                {formatUsdCents(b.totalCents)}
                {b.unreimbursedCents !== b.totalCents && <span className="text-muted"> · {formatUsdCents(b.unreimbursedCents)} open</span>}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(b.totalCents / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
