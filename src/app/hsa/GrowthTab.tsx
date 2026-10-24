"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Callout, Card, StatCell, StatGrid, table } from "@/components/ui/kit";
import { axisUsd, formatPercentRatio, formatUsdCents, usd0 } from "@/lib/formatMoney";
import { KIND_LABEL, type ExpenseKind } from "@/lib/hsa/qualify";
import type { Breakdown, HsaReport } from "@/lib/hsa/report";
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { hsaProof } from "./proof";

const RATE_SOURCE = { SETTING: "your setting", MEASURED: "your HSA's measured return", FORECAST: "the forecast's return (Forecast page)", DEFAULT: "a long-run stock-market assumption" };

export function GrowthTab({ r }: { r: HsaReport }) {
  const g = r.growth;
  const p = useChartPalette();
  const chrome = chartChrome(p);
  const a = g.assumptions;
  const edge = g.futureValueCents - g.taxableValueCents;
  const scale = r.totals.unreimbursedCents / 100_000;
  const taxableTerms = `${formatPercentRatio(a.dividendYield, 1)} dividends taxed yearly and ${formatPercentRatio(a.taxableRate, 0)} on the gain when sold`;
  if (g.withheld)
    return (
      <Callout tone="info" title="Growth and strategy figures withheld">
        {g.withheld} Type a rate under Settings to see them with it, labelled as yours.
      </Callout>
    );
  return (
    <>
      <StatGrid cols={3}>
        <StatCell label={`Worth in ${g.planYear}`} value={usd0(g.futureValueCents)} tone="accent" proof={hsaProof("future", g.futureValueCents)} sub={`today's ${usd0(r.totals.unreimbursedCents)} of receipts left invested ${g.years} years at ${formatPercentRatio(g.rate, 1)}, after any tax`} />
        <StatCell
          label={a.growthCovered ? "Tax-free growth by then" : "Growth by then, after tax"}
          value={usd0(g.futureValueCents - r.totals.unreimbursedCents)}
          tone="pos"
          proof={hsaProof("future-growth", g.futureValueCents - r.totals.unreimbursedCents)}
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
        title="Pay a medical bill from the HSA, or out of pocket?"
        subtitle={`Per $1,000 bill, with the HSA maxed out either way, so the contribution, its tax saving and your employer's part are the same in both and left out. Either way the bill costs $1,000 of take-home today; what differs is where that $1,000 sits until ${g.planYear} (${g.years} years): a taxable account (${taxableTerms}) or the HSA. Waiting only works if you can cash-flow the bills and keep the receipts.`}
      >
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>How</th>
                <th className={table.thR} title="What the HSA pays toward the bill today">
                  HSA pays
                </th>
                <th className={table.thR} title="What your bank account (take-home) pays toward the bill today">
                  Bank pays
                </th>
                <th className={table.thR} title="Take-home that goes into a taxable account today instead of paying the bill">
                  Into taxable
                </th>
                <th className={table.thR} title="Money that stays invested in the HSA instead of paying the bill">
                  Stays in HSA
                </th>
                <th className={table.thR} title={`What that money is worth in ${g.planYear}, after every tax, as if taken out then`}>
                  Worth in {g.planYear}
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
                  <td className={table.tdR}>{usd0(s.fromHsaCents)}</td>
                  <td className={table.tdR}>{usd0(s.fromBankCents)}</td>
                  <td className={table.tdR}>{usd0(s.taxableNowCents)}</td>
                  <td className={table.tdR}>{usd0(s.hsaNowCents)}</td>
                  <td className={table.tdR}>{usd0(s.worthCents)}</td>
                  <td className={`${table.tdR} ${s.aheadCents > 0 ? "text-pos" : s.aheadCents < 0 ? "text-neg" : ""}`}>{usd0(s.aheadCents)}</td>
                  {scale > 0 && <td className={`${table.tdR} ${s.aheadCents > 0 ? "text-pos" : s.aheadCents < 0 ? "text-neg" : ""}`}>{usd0(Math.round(s.aheadCents * scale))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          Ahead is against paying from the HSA now.{" "}
          {a.growthCovered
            ? "The HSA's growth is assumed to come out tax-free, backed by later medical bills."
            : `The HSA's growth comes out taxed at ${formatPercentRatio(a.exitRate, 0)}, with no receipt behind it.`}{" "}
          Not counted, because it&apos;s the same in both: the plan&apos;s premium and deductible, and account fees.
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
