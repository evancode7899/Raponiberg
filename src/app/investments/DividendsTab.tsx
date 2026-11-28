"use client";

import { Card, EmptyState, NotFigure, StatCell, StatGrid, table, WordsCell } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { divKey } from "@/lib/book/derived/dividends";
import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import type { InvestmentsReport } from "@/lib/book/reports/investments";
import { formatUsdFromCents, NA, usd0 } from "@/lib/formatMoney";

/**
 * Investments › Dividends (reports/dividends.ts): every dividend the brokerage statements
 * print, security by month for the twelve months through the latest proven month, and when
 * each paid, which says when it pays next. Nothing is forecast: no amount appears for a month
 * still to come.
 */
export function DividendsTab({ r, d }: { r: InvestmentsReport; d: DerivedFigure[] }) {
  const cal = r.dividends;
  if (!cal.securities.length) return <EmptyState title="No dividends on your brokerage statements in the last twelve months" />;
  const fig = (row: string, month: string) => derivedTarget("investments", d, "div", divKey(row, month));
  const best = cal.months.reduce((m, x) => (x.cents > m.cents ? x : m), cal.months[0]!);
  const upcoming = cal.securities.filter((s) => s.next).sort((a, b) => a.next!.localeCompare(b.next!));
  return (
    <>
      <StatGrid cols={3}>
        <StatCell proof={fig("all", "total")} label="Dividends, twelve months" value={usd0(cal.totalCents)} sub={`${cal.from.slice(0, 7)} to ${cal.through.slice(0, 7)}, as the statements print them`} />
        <StatCell proof={fig("all", best.key)} label="Biggest month" value={usd0(best.cents)} sub={best.label} />
        <WordsCell label="Paying securities" value={String(cal.securities.length)} sub={`${cal.securities.filter((s) => s.moneyMarket).length} of them money-market funds`} />
      </StatGrid>

      <Card title="Dividend calendar" subtitle="What each security paid, month by month. The months it paid in say when it pays next: the next column names the month, never an amount.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Security</th>
                {cal.months.map((m) => (
                  <th key={m.key} className={table.thR}>{m.label.slice(0, 3)}</th>
                ))}
                <th className={table.thR}>Twelve months</th>
                <th className={table.th}>Pays</th>
              </tr>
            </thead>
            <tbody>
              {cal.securities.map((s) => (
                <tr key={s.key} className={table.tr}>
                  <td className={table.td}>
                    {s.security}
                    <span className="ml-1 text-faint">{s.accountName}</span>
                  </td>
                  {cal.months.map((m) => (
                    <td key={m.key} className={table.tdR}>
                      {s.byMonth[m.key] ? <ProofValue proof={fig(s.key, m.key)}>{formatUsdFromCents(s.byMonth[m.key]!)}</ProofValue> : "—"}
                    </td>
                  ))}
                  <td className={table.tdR}>
                    <ProofValue proof={fig(s.key, "total")}>{usd0(s.totalCents)}</ProofValue>
                  </td>
                  <td className={table.td}>
                    <NotFigure why="when it paid, in words">{s.cadence}{s.next ? `, next ${s.next}` : ""}</NotFigure>
                  </td>
                </tr>
              ))}
              <tr className={`${table.tr} border-t-2 border-line-strong font-medium`}>
                <td className={table.td}>Every account</td>
                {cal.months.map((m) => (
                  <td key={m.key} className={table.tdR}>
                    {m.cents ? <ProofValue proof={fig("all", m.key)}>{usd0(m.cents)}</ProofValue> : "—"}
                  </td>
                ))}
                <td className={table.tdR}>
                  <ProofValue proof={fig("all", "total")}>{usd0(cal.totalCents)}</ProofValue>
                </td>
                <td className={table.td} />
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Next to pay" subtitle="Each security's next month, from the months it paid in over the last year.">
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {upcoming.map((s) => (
            <li key={s.key} className="flex justify-between gap-3">
              <span>{s.security} <span className="text-faint">{s.accountName}</span></span>
              <NotFigure why="a month, from when it paid before">{s.next ?? NA}</NotFigure>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
