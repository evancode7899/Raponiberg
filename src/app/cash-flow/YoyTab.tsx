"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { windowKey } from "@/lib/book/derived/cashFlow";
import { chartChrome } from "@/components/shell/chartPalette";
import { Callout, Card, NotFigure, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import type { CashFlowMetric } from "@/lib/book/proof/cashFlowProof";
import type { SpendingKind, SpendingMonth } from "@/lib/book/reports/spending";
import { axisUsd, formatPercentRatio, formatUsd, formatUsdCents, NA, usd0, usdCompact, usdDelta } from "@/lib/formatMoney";
import { useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
import { seasonBands, yearEndEstimate, type SeasonMetric } from "@/lib/book/reports/seasonality";
import { yearEndKey } from "@/lib/book/derived/cashFlow";
import type { Ctx } from "./CashFlowClient";
import { compareCategories, yearCategories, yoyWindows } from "@/lib/book/reports/cashFlowWindows";
import { KINDS, merchantMovers, MONTH_NAMES, monthKey, sum, totals } from "./model";
import { categoryColor, Delta, DivergingBar, Dot } from "./parts";
import { noFigure, unswept } from "@/lib/book/proof/clearance";
import { contributions } from "@/lib/book/reports/contributions";

type Mode = "month" | "ytd" | "12m";


/**
 * Spending against the same months a year earlier: the latest month, the year to date,
 * or the last twelve months. Uses only proven months on both sides, independent of the
 * range picker (a comparison needs like-for-like months), and says which months are
 * missing when a side isn't complete.
 */
export function YoyTab({ ctx }: { ctx: Ctx }) {
  const { report } = ctx;
  const [mode, setMode] = useState<Mode>("month");
  const byKey = useMemo(() => new Map(report.months.map((m) => [monthKey(m.start), m])), [report.months]);
  // The same months either side the proof sweep enumerates (cashFlowWindows).
  const { nowKeys, thenKeys, missing, now, then } = useMemo(() => yoyWindows(report.months, mode), [report.months, mode]);
  const label = (ks: string[]) => (ks.length === 1 ? byKey.get(ks[0]!)?.label ?? ks[0]! : `${byKey.get(ks[0]!)?.label ?? ks[0]} – ${byKey.get(ks.at(-1)!)?.label ?? ks.at(-1)}`);


  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented view
          ariaLabel="Comparison"
          options={[
            { value: "month", label: "Latest month" },
            { value: "ytd", label: "Year to date" },
            { value: "12m", label: "Last 12 months" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <span className="text-xs text-muted">
          {label(nowKeys)} <span className="text-faint">vs</span> {label(thenKeys)}
        </span>
      </div>
      {missing.length > 0 ? (
        <Callout tone="warn" title="Not every month on both sides is proven">
          A fair comparison needs the same months a year apart. Not proven yet: {missing.map((k) => MONTH_NAMES[Number(k.slice(5)) - 1] + " " + k.slice(0, 4)).join(", ")}.
          {mode !== "month" && " Try the latest month, or see Statements → Issues for what to fetch."}
        </Callout>
      ) : (
        <Comparison ctx={ctx} now={now} then={then} />
      )}
      <AllYears ctx={ctx} />
      <YearTable ctx={ctx} />
    </>
  );
}

function Comparison({ ctx, now, then }: { ctx: Ctx; now: SpendingMonth[]; then: SpendingMonth[] }) {
  const { chart } = ctx;
  const a = useMemo(() => totals(now), [now]);
  const b = useMemo(() => totals(then), [then]);
  const categories = useMemo(() => compareCategories(now, then), [now, then]);
  // The ten that rose and fell most (merchantMovers: the lists the proof sweep enumerates too).
  const { up, down } = useMemo(() => merchantMovers(now, then), [now, then]);
  const maxChange = Math.max(1, ...categories.map((c) => Math.abs(c.now - c.then)));
  // Each category's part of the change in spending, adding up to it to the cent (reports/contributions.ts).
  const contrib = useMemo(() => contributions(categories.map((c) => ({ key: c.category, now: c.now, then: c.then })), { now: a.spending, then: b.spending }), [categories, a.spending, b.spending]);
  const catProof = (c: { category: string; now: number; then: number }) => {
    const n = ctx.proof("spending", now, { category: c.category, shownCents: c.now });
    const t = ctx.proof("spending", then, { category: c.category, shownCents: c.then });
    return { n, t, change: !c.then ? n : !c.now ? t : compositeOf("diff", [n, t], { cents: c.now - c.then }) };
  };
  const totalNow = ctx.proof("spending", now, { shownCents: a.spending });
  const totalThen = ctx.proof("spending", then, { shownCents: b.spending });
  const totalChange = compositeOf("diff", [totalNow, totalThen], { cents: a.spending - b.spending });
  const shareOf = (change: ProofRef, cents: number) => {
    const s = contrib.total.change ? cents / contrib.total.change : null;
    return s == null || Math.abs(contrib.total.change) < 100 ? <span className="text-faint">{NA}</span> : <ProofValue proof={compositeOf("share", [change, totalChange], { ratio: s })}>{formatPercentRatio(s, 0)}</ProofValue>;
  };

  return (
    <>
      <StatGrid cols={4}>
        <StatCell
          label="Spending"
          value={usd0(a.spending)}
          proof={ctx.proof("spending", now, { shownCents: a.spending })}
          sub={<Change now={a.spending} then={b.spending} nowProof={ctx.proof("spending", now, { shownCents: a.spending })} proof={ctx.proof("spending", then, { shownCents: b.spending })} goodWhenDown />}
        />
        <StatCell label="Income" value={usd0(a.income)} proof={ctx.proof("income", now, { shownCents: a.income })} sub={<Change now={a.income} then={b.income} nowProof={ctx.proof("income", now, { shownCents: a.income })} proof={ctx.proof("income", then, { shownCents: b.income })} />} />
        <StatCell
          label="Saved from take-home"
          value={usd0(a.net)}
          proof={ctx.proof("net", now, { shownCents: a.net })}
          tone={a.net < 0 ? "neg" : "neutral"}
          sub={<Change now={a.net} then={b.net} nowProof={ctx.proof("net", now, { shownCents: a.net })} proof={ctx.proof("net", then, { shownCents: b.net })} />}
        />
        <StatCell proof={ctx.dp("savings-rate", windowKey(now))}
          label="Savings rate (take-home)"
          value={a.savingsRate == null ? NA : formatPercentRatio(a.savingsRate, 0)}
          sub={
            b.savingsRate == null ? (
              NA
            ) : (
              <>
                <ProofValue proof={ctx.dp("savings-rate", windowKey(then))}>{formatPercentRatio(b.savingsRate, 0)}</ProofValue> a year earlier
              </>
            )
          }
        />
      </StatGrid>
      <Card title="By category" subtitle="Largest changes first; each category's part of the change in spending adds up to it. Click a category for its rows.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Category</th>
                <th className={table.thR}>A year earlier</th>
                <th className={table.thR}>Now</th>
                <th className={`${table.th} w-[24%]`} />
                <th className={table.thR}>Change</th>
                <th className={table.thR}>%</th>
                <th className={table.thR} title="Each category's part of the change in total spending: the column adds up to 100%.">Of the change</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.category} className={`${table.trHover} cursor-pointer`} onClick={() => ctx.open({ kind: "category", category: c.category })}>
                  <td className={table.td}>
                    <span className="flex items-center gap-2">
                      <Dot color={categoryColor(chart, c.category)} />
                      {c.category}
                    </span>
                  </td>
                  <td className={`${table.tdR} text-muted`}>
                    <ProofValue proof={ctx.proof("spending", then, { category: c.category, shownCents: c.then })}>{usd0(c.then)}</ProofValue>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={ctx.proof("spending", now, { category: c.category, shownCents: c.now })}>{usd0(c.now)}</ProofValue>
                  </td>
                  <td className={table.td}>
                    <DivergingBar value={c.now - c.then} max={maxChange} />
                  </td>
                  <td className={`${table.tdR} ${c.now > c.then ? "text-neg" : c.now < c.then ? "text-pos" : ""}`}>
                    <ProofValue
                      proof={
                        !c.then
                          ? ctx.proof("spending", now, { category: c.category, shownCents: c.now })
                          : !c.now
                            ? ctx.proof("spending", then, { category: c.category, shownCents: c.then })
                            : compositeOf("diff", [ctx.proof("spending", now, { category: c.category, shownCents: c.now }), ctx.proof("spending", then, { category: c.category, shownCents: c.then })], { cents: c.now - c.then })
                      }
                    >
                      {usdDelta(c.now - c.then)}
                    </ProofValue>
                  </td>
                  <td className={table.tdR}>{c.then ? <Delta now={c.now} before={c.then} goodWhenDown of={[ctx.proof("spending", now, { category: c.category, shownCents: c.now }), ctx.proof("spending", then, { category: c.category, shownCents: c.then })]} /> : <span className="text-xs text-muted">new</span>}</td>
                  <td className={`${table.tdR} text-muted`}>{c.now === c.then ? "—" : shareOf(catProof(c).change, c.now - c.then)}</td>
                </tr>
              ))}
              {contrib.rest !== 0 && (
                <tr className={table.tr} title="Each category's months are rounded to the cent on their own; the total is rounded once.">
                  <td className={`${table.td} text-muted`}>Rounding</td>
                  <td className={table.tdR} />
                  <td className={table.tdR} />
                  <td className={table.td} />
                  <td className={`${table.tdR} text-muted`}>
                    <ProofValue proof={compositeOf("diff", [totalChange, compositeOf("sum", categories.filter((c) => c.now !== c.then).map((c) => catProof(c).change), { cents: contrib.total.change - contrib.rest })], { cents: contrib.rest })}>{formatUsdCents(contrib.rest)}</ProofValue>
                  </td>
                  <td className={table.tdR} />
                  <td className={table.tdR} />
                </tr>
              )}
              <tr className="border-t border-line-strong font-semibold">
                <td className={table.td}>Spending</td>
                <td className={`${table.tdR} text-muted`}>
                  <ProofValue proof={totalThen}>{usd0(b.spending)}</ProofValue>
                </td>
                <td className={table.tdR}>
                  <ProofValue proof={totalNow}>{usd0(a.spending)}</ProofValue>
                </td>
                <td className={table.td} />
                <td className={`${table.tdR} ${a.spending > b.spending ? "text-neg" : a.spending < b.spending ? "text-pos" : ""}`}>
                  <ProofValue proof={totalChange}>{usdDelta(a.spending - b.spending)}</ProofValue>
                </td>
                <td className={table.tdR}>
                  <Delta now={a.spending} before={b.spending} goodWhenDown of={[totalNow, totalThen]} />
                </td>
                <td className={`${table.tdR} text-muted`}>{Math.abs(contrib.total.change) < 100 ? NA : <NotFigure why="the whole change: the column above adds up to it">100%</NotFigure>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <MoverCard title="Spending more at" rows={up} ctx={ctx} now={now} then={then} />
        <MoverCard title="Spending less at" rows={down} ctx={ctx} now={now} then={then} />
      </div>
    </>
  );
}

function Change({ now, then, nowProof, proof, goodWhenDown = false }: { now: number; then: number; nowProof: ProofRef; proof: ProofRef; goodWhenDown?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <Delta now={now} before={then} goodWhenDown={goodWhenDown} of={[nowProof, proof]} />
      <span>
        from <ProofValue proof={proof}>{usd0(then)}</ProofValue>
      </span>
    </span>
  );
}

function MoverCard({ title, rows, ctx, now, then }: { title: string; rows: { key: string; name: string; now: number; then: number }[]; ctx: Ctx; now: SpendingMonth[]; then: SpendingMonth[] }) {
  return (
    <Card title={title} subtitle="Merchants, by dollar change.">
      {rows.length === 0 ? (
        <p className="text-xs text-muted">None.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line text-[13px]">
          {rows.map((m) => (
            <li key={m.key} className="flex items-center justify-between gap-3 py-1.5">
              <button type="button" className="min-w-0 truncate text-left hover:text-accent" onClick={() => ctx.open({ kind: "merchant", key: m.key, name: m.name, lane: "EXPENSE" })}>
                {m.name}
              </button>
              <span className="num shrink-0 text-xs text-muted">
                <ProofValue proof={m.then ? ctx.proof("spending", then, { merchantKey: m.key, shownCents: m.then }) : noFigure("nothing spent here in that span", true)}>{usd0(m.then)}</ProofValue> →{" "}
                <ProofValue proof={m.now ? ctx.proof("spending", now, { merchantKey: m.key, shownCents: m.now }) : noFigure("nothing spent here in that span", true)} className="text-fg">
                  {usd0(m.now)}
                </ProofValue>
                {!m.then && <span className="ml-1.5 text-info">new</span>}
                {!m.now && <span className="ml-1.5">stopped</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type YearMetric = "spending" | "everyday" | "income" | "saved";
const METRIC: Record<YearMetric, { label: string; f: (m: SpendingMonth) => number; goodWhenDown: boolean; proof: { metric: CashFlowMetric; spendingKind?: SpendingKind } }> = {
  spending: { label: "Spending", f: (m) => m.spendingCents, goodWhenDown: true, proof: { metric: "spending" } },
  everyday: { label: "Everyday spending", f: (m) => m.kinds.everydayCents, goodWhenDown: true, proof: { metric: "spending", spendingKind: "everyday" } },
  income: { label: "Income", f: (m) => m.incomeCents, goodWhenDown: false, proof: { metric: "income" } },
  saved: { label: "Saved from take-home", f: (m) => m.netCents, goodWhenDown: false, proof: { metric: "net" } },
};

/** Proven months grouped by calendar year, oldest first; each year's months indexed by month (0 = Jan). */
function byYear(months: SpendingMonth[]) {
  const out = new Map<number, (SpendingMonth | null)[]>();
  for (const m of months) {
    const y = Number(m.start.slice(0, 4));
    const list = out.get(y) ?? Array.from({ length: 12 }, () => null);
    list[Number(m.start.slice(5, 7)) - 1] = m;
    out.set(y, list);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Every year on one chart, month by month or as a running total from January. The
 * running total shows the pace: where this year stands against the same point in
 * earlier years. A year that doesn't start in January has no running total.
 */
function AllYears({ ctx }: { ctx: Ctx }) {
  const { report, chart } = ctx;
  const ui = chartChrome(chart);
  const [metric, setMetric] = useState<YearMetric>("spending");
  const [view, setView] = useState<"monthly" | "cumulative">("cumulative");
  const f = METRIC[metric].f;
  const series = byYear(report.months).map(([y, ms]) => {
    if (view === "monthly") return { y, values: ms.map((m) => (m ? f(m) : null)) };
    // A running total stops at the first month that isn't proven.
    let run = 0;
    let broken = false;
    return {
      y,
      values: ms.map((m) => {
        if (!m) broken = true;
        if (broken) return null;
        run += f(m!);
        return run;
      }),
    };
  });
  const shown = series.filter((s) => s.values.some((v) => v != null));
  const latest = shown.at(-1);
  // Seasonality: the same month in earlier years, as a band (low to high) and its middle, behind this year's months.
  const seasonal = (metric === "spending" || metric === "everyday") && view === "monthly" && latest ? seasonBands(report.months, latest.y, f) : null;
  // With one earlier year its own line is the band: drawn once two or more give it a spread.
  const banded = seasonal?.some((b) => b && b.n >= 2) ?? false;
  const rows = MONTH_NAMES.map((name, i) => {
    const b = seasonal?.[i];
    return Object.fromEntries([
      ["name", name],
      ...shown.map((s) => [String(s.y), s.values[i] == null ? null : s.values[i]! / 100]),
      ...(banded ? [["band", b && b.n >= 2 ? [b.low / 100, b.high / 100] : null], ["middle", b ? b.mid / 100 : null]] : []),
    ]);
  });
  // Where the year lands, for spending: an estimate (named one), never part of a proven total.
  const yearEnd = (metric === "spending" || metric === "everyday") && view === "cumulative" ? yearEndEstimate(report.months, f) : null;
  const age = (y: number) => (latest ? latest.y - y : 0);
  const color = (y: number) => (age(y) === 0 ? chart.series[0]! : age(y) === 1 ? chart.series[6]! : chart.neutral);

  // Pace: this year's running total against last year's at the same month.
  let pace: { m: number; now: number; then: number; full: number | null; projected: number | null; prevYear: number } | null = null;
  if (view === "cumulative" && latest) {
    const m = latest.values.findLastIndex((v) => v != null);
    const prev = shown.find((s) => s.y === latest.y - 1);
    if (m >= 0 && prev && prev.values[m] != null) {
      const full = prev.values[11] ?? null;
      const now = latest.values[m]!;
      const then = prev.values[m]!;
      pace = { m, now, then, full, projected: full != null && then > 0 && m < 11 ? (now * full) / then : null, prevYear: prev.y };
    }
  }
  // A pace figure: the year's month m (Monthly), or its months from January through m (Running total).
  const yearMonths = new Map(byYear(report.months));
  const paceProof = (y: number, m: number, cents: number): ProofRef => {
    const ms = (yearMonths.get(y) ?? []).slice(view === "monthly" ? m : 0, m + 1);
    return ms.length && ms.every(Boolean) ? ctx.proof(METRIC[metric].proof.metric, ms as SpendingMonth[], { spendingKind: METRIC[metric].proof.spendingKind, shownCents: cents }) : noFigure("a month isn't proven");
  };

  return (
    <Card
      title={`${METRIC[metric].label}, every year`}
      subtitle={
        view === "cumulative"
          ? "Running total from January: a line above last year's means more so far. A year without a proven January has no running total."
          : metric === "spending" || metric === "everyday"
            ? "Each month on its own, over the band the same month spanned in earlier years (low to high) and its middle. A gap is a month that isn't proven."
            : "Each month on its own. A gap is a month that isn't proven."
      }
      actions={
        <>
          <Segmented view
            size="xs"
            ariaLabel="Figure"
            options={[
              { value: "spending", label: "Spending" },
              { value: "everyday", label: "Everyday" },
              { value: "income", label: "Income" },
              { value: "saved", label: "Saved from take-home" },
            ]}
            value={metric}
            onChange={setMetric}
          />
          <Segmented view
            size="xs"
            ariaLabel="View"
            options={[
              { value: "cumulative", label: "Running total" },
              { value: "monthly", label: "Monthly" },
            ]}
            value={view}
            onChange={setView}
          />
        </>
      }
    >
      {pace && latest && (
        <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[13px]">
          <span>
            <span className="text-muted">
              {latest.y} through {MONTH_NAMES[pace.m]}:
            </span>{" "}
            <span className="num font-semibold">
              <ProofValue proof={paceProof(latest.y, pace.m, pace.now)}>{usd0(pace.now)}</ProofValue>
            </span>{" "}
            <Delta now={pace.now} before={pace.then} goodWhenDown={METRIC[metric].goodWhenDown} of={[paceProof(latest.y, pace.m, pace.now), paceProof(pace.prevYear, pace.m, pace.then)]} />
          </span>
          <span>
            <span className="text-muted">{pace.prevYear} at that point:</span>{" "}
            <span className="num font-medium">
              <ProofValue proof={paceProof(pace.prevYear, pace.m, pace.then)}>{usd0(pace.then)}</ProofValue>
            </span>
            {pace.full != null && (
              <span className="text-muted">
                {" "}· finished at <ProofValue proof={view === "monthly" ? paceProof(pace.prevYear, 11, pace.full) : paceProof(pace.prevYear, 11, pace.full)}>{usd0(pace.full)}</ProofValue>
              </span>
            )}
          </span>
          {yearEnd && (
            <span title="The year so far, plus each month left at the middle of the same month in earlier years. Months not yet on file: an estimate, never added into a proven total." className="cursor-help">
              <span className="text-muted">Estimate for all of {yearEnd.year}:</span>{" "}
              <span className="num font-medium">
                <ProofValue proof={ctx.dp("year-end", yearEndKey(yearEnd.year, metric as SeasonMetric))}>{usdCompact(yearEnd.estimateCents)}</ProofValue>
              </span>
            </span>
          )}
          {pace.projected != null && (
            <span title={`An estimate: this year's total so far, scaled by how ${pace.prevYear}'s grew from ${MONTH_NAMES[pace.m]} to December.`} className="cursor-help">
              <span className="text-muted">
                Estimate on {pace.prevYear}&apos;s curve:
              </span>{" "}
              <span className="num font-medium">
                <ProofValue proof={compositeOf("scale", [paceProof(latest.y, pace.m, pace.now), paceProof(pace.prevYear, 11, pace.full!), paceProof(pace.prevYear, pace.m, pace.then)], { cents: pace.projected })}>{usdCompact(pace.projected)}</ProofValue>
              </span>
            </span>
          )}
        </div>
      )}
      <div className="h-[300px] w-full min-w-0">
        <RechartsResponsive>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="name" {...ui.xAxis} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip
              {...ui.tooltip}
              itemSorter={(it) => (it.dataKey === "band" || it.dataKey === "middle" ? 1 : -Number(it.dataKey))}
              formatter={(v, n) => (n === "band" ? [Array.isArray(v) ? v.map((x) => formatUsd(Math.round(Number(x)))).join(" – ") : NA, "Earlier years, low – high"] : [v == null ? NA : formatUsd(Math.round(Number(v))), n === "middle" ? "Earlier years, middle" : String(n)])}
            />
            <Legend {...ui.legend} formatter={(n) => (n === "band" ? "earlier years, low – high" : n === "middle" ? "earlier years, middle" : n)} />
            {banded && <Area dataKey="band" stroke="none" fill={chart.neutral} fillOpacity={0.22} isAnimationActive={false} connectNulls={false} />}
            {banded && <Line dataKey="middle" stroke={chart.neutral} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />}
            {shown.map((s) => (
              <Line
                key={s.y}
                dataKey={String(s.y)}
                stroke={color(s.y)}
                strokeWidth={age(s.y) === 0 ? 2.5 : age(s.y) === 1 ? 2 : 1.5}
                strokeOpacity={age(s.y) <= 1 ? 1 : Math.max(0.35, 1 - (age(s.y) - 1) * 0.25)}
                dot={view === "monthly" ? { r: age(s.y) === 0 ? 3 : 2 } : false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

/** `proof`: the figure the row sums, when it's one the Book proves (the kinds of spending are a split the page makes). */
type YearRow = { label: string; f: (m: SpendingMonth) => number; proof?: { metric: CashFlowMetric; category?: string; spendingKind?: SpendingKind }; goodWhenDown?: boolean; strong?: boolean; color?: string; indent?: boolean };

/**
 * Each calendar year side by side, as an average month so a partial year compares fairly
 * (or as totals). Each cell shows its change from the year before.
 */
function YearTable({ ctx }: { ctx: Ctx }) {
  const { report, chart } = ctx;
  const [as, setAs] = useState<"avg" | "total">("avg");
  const years = byYear(report.months).map(([y, ms]) => ({ y, months: ms.filter((m): m is SpendingMonth => m != null) }));
  const val = (ms: SpendingMonth[], f: (m: SpendingMonth) => number) => (as === "avg" ? sum(ms, f) / Math.max(1, ms.length) : sum(ms, f));
  const comparable = (i: number) => i > 0 && (as === "avg" || (years[i]!.months.length === 12 && years[i - 1]!.months.length === 12));
  const cashRows: YearRow[] = [
    { label: "Income", f: (m) => m.incomeCents, proof: { metric: "income" }, strong: true },
    { label: "Spending", f: (m) => m.spendingCents, proof: { metric: "spending" }, goodWhenDown: true, strong: true },
    ...KINDS.map((k) => ({ label: k.label, f: (m: SpendingMonth) => m.kinds[k.id], proof: { metric: "spending" as const, spendingKind: k.kind }, goodWhenDown: true, indent: true })),
    { label: "Saved from take-home", f: (m) => m.netCents, proof: { metric: "net" }, strong: true },
  ];
  const categoryRows: YearRow[] = yearCategories(report.months).map((c) => ({
    label: c,
    f: (m: SpendingMonth) => m.spendingByCategory.find((x) => x.category === c)?.cents ?? 0,
    proof: { metric: "spending" as const, category: c },
    goodWhenDown: true,
    color: categoryColor(chart, c),
  }));
  const rate = (ms: SpendingMonth[]) => {
    const inc = sum(ms, (m) => m.incomeCents);
    return inc > 0 ? (inc - sum(ms, (m) => m.spendingCents)) / inc : null;
  };
  const heading = (title: string) => (
    <tr>
      <td colSpan={years.length + 1} className="pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">
        {title}
      </td>
    </tr>
  );
  const line = (r: YearRow) => (
    <tr key={r.label} className={table.trHover}>
      <td className={`${table.td} whitespace-nowrap ${r.strong ? "font-semibold" : ""} ${r.indent ? "!pl-6 text-fg-2" : ""}`}>
        <span className="flex items-center gap-2">
          {r.color && <Dot color={r.color} />}
          {r.label}
        </span>
      </td>
      {years.map((y, i) => {
        const v = val(y.months, r.f);
        // A year's months are one unbroken run (the report's months are), so one range covers them.
        const proof = r.proof ? ctx.proof(r.proof.metric, y.months, { category: r.proof.category, spendingKind: r.proof.spendingKind, perMonth: as === "avg", shownCents: sum(y.months, r.f) }) : unswept("nothing spent here in that span");
        return (
          <td key={y.y} className={`${table.tdR} ${r.strong ? "font-semibold" : ""}`}>
            <ProofValue proof={proof}>{usd0(v)}</ProofValue>
            <div className="leading-none">
              {comparable(i) ? (
                <YearDelta
                  now={v}
                  before={val(years[i - 1]!.months, r.f)}
                  goodWhenDown={r.goodWhenDown}
                  of={r.proof ? [proof, ctx.proof(r.proof.metric, years[i - 1]!.months, { category: r.proof.category, spendingKind: r.proof.spendingKind, shownCents: sum(years[i - 1]!.months, r.f) })] : undefined}
                  per={as === "avg" ? [y.months.length, years[i - 1]!.months.length] : undefined}
                />
              ) : (
                <span className="text-xs">&nbsp;</span>
              )}
            </div>
          </td>
        );
      })}
    </tr>
  );
  return (
    <Card
      title="Year by year"
      subtitle={`Calendar years from proven months. ${
        as === "avg" ? "An average month, so a partial year compares fairly with a full one." : "Totals; changes show only between two full years."
      } Under each figure, its change from the year before.`}
      actions={
        <Segmented view
          size="xs"
          ariaLabel="Figures"
          options={[
            { value: "avg", label: "Per month" },
            { value: "total", label: "Totals" },
          ]}
          value={as}
          onChange={setAs}
        />
      }
    >
      <div className={table.wrap}>
        <table className={`${table.table} min-w-[44rem]`}>
          <thead className={table.head}>
            <tr>
              <th className={table.th} />
              {years.map((y) => (
                <th key={y.y} className={table.thR}>
                  {y.y}
                  {y.months.length < 12 && <div className="text-[10px] font-normal normal-case tracking-normal text-faint">{y.months.length} mo</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heading("Cash flow")}
            {cashRows.map(line)}
            <tr className={table.trHover}>
              <td className={`${table.td} font-semibold`}>Savings rate</td>
              {years.map((y, i) => {
                const r = rate(y.months);
                const p = i ? rate(years[i - 1]!.months) : null;
                return (
                  <td key={y.y} className={`${table.tdR} font-semibold`}>
                    {r == null ? NA : <ProofValue proof={ctx.dp("savings-rate", windowKey(y.months))}>{formatPercentRatio(r, 0)}</ProofValue>}
                    <div className="text-xs font-normal leading-none text-muted">{r != null && p != null ? `${r >= p ? "+" : "−"}${Math.abs(Math.round((r - p) * 100))} pts` : " "}</div>
                  </td>
                );
              })}
            </tr>
            {heading("Spending by category")}
            {categoryRows.map(line)}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** A percent change, or dollars when the base is too small (or the swing too wild) for a percent to mean much. */
function YearDelta({ now, before, goodWhenDown, of, per }: { now: number; before: number; goodWhenDown?: boolean; of?: [ProofRef, ProofRef]; per?: [number, number] }) {
  const meaningful = before >= 10_000 && Math.abs(now / before - 1) <= 3;
  return <Delta now={now} before={before} goodWhenDown={goodWhenDown} asPercent={meaningful} of={of} per={per} />;
}
