"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { Callout, Card, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import type { SpendingMonth } from "@/lib/book/reports/spending";
import { axisUsd, formatPercentRatio, formatUsd, usd0, usdCompact, usdDelta } from "@/lib/formatMoney";
import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { Ctx } from "./CashFlowClient";
import { KINDS, mergeCategories, mergeMerchants, MONTH_NAMES, monthKey, shiftMonth, SPEND_CATEGORIES, sum, totals } from "./model";
import { categoryColor, Delta, DivergingBar, Dot } from "./parts";

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
  const latest = report.months.at(-1)!;
  const latestKey = monthKey(latest.start);

  const keys = (k: string, n: number) => Array.from({ length: n }, (_, i) => shiftMonth(k, -(n - 1 - i)));
  const nowKeys = mode === "month" ? [latestKey] : mode === "ytd" ? keys(latestKey, Number(latestKey.slice(5))) : keys(latestKey, 12);
  const thenKeys = nowKeys.map((k) => shiftMonth(k, -12));
  const missing = [...nowKeys, ...thenKeys].filter((k) => !byKey.has(k));
  const now = nowKeys.map((k) => byKey.get(k)).filter((m): m is SpendingMonth => m != null);
  const then = thenKeys.map((k) => byKey.get(k)).filter((m): m is SpendingMonth => m != null);
  const label = (ks: string[]) => (ks.length === 1 ? byKey.get(ks[0]!)?.label ?? ks[0]! : `${byKey.get(ks[0]!)?.label ?? ks[0]} – ${byKey.get(ks.at(-1)!)?.label ?? ks.at(-1)}`);


  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
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

/** Spending by category in both periods, biggest change first. */
function compareCategories(now: SpendingMonth[], then: SpendingMonth[]) {
  const n = new Map(mergeCategories(now, (m) => m.spendingByCategory).map((c) => [c.category, c.cents]));
  const t = new Map(mergeCategories(then, (m) => m.spendingByCategory).map((c) => [c.category, c.cents]));
  return [...new Set([...n.keys(), ...t.keys()])]
    .map((category) => ({ category, now: n.get(category) ?? 0, then: t.get(category) ?? 0 }))
    .filter((c) => c.now || c.then)
    .sort((x, y) => Math.abs(y.now - y.then) - Math.abs(x.now - x.then));
}

/** Spending by merchant in both periods. */
function compareMerchants(now: SpendingMonth[], then: SpendingMonth[]) {
  const n = new Map(mergeMerchants(now).map((m) => [m.key, m]));
  const t = new Map(mergeMerchants(then).map((m) => [m.key, m]));
  return [...new Set([...n.keys(), ...t.keys()])].map((key) => ({ key, name: (n.get(key) ?? t.get(key))!.name, now: n.get(key)?.cents ?? 0, then: t.get(key)?.cents ?? 0 }));
}

function Comparison({ ctx, now, then }: { ctx: Ctx; now: SpendingMonth[]; then: SpendingMonth[] }) {
  const { chart } = ctx;
  const a = useMemo(() => totals(now), [now]);
  const b = useMemo(() => totals(then), [then]);
  const categories = useMemo(() => compareCategories(now, then), [now, then]);
  const merchants = useMemo(() => compareMerchants(now, then), [now, then]);
  const maxChange = Math.max(1, ...categories.map((c) => Math.abs(c.now - c.then)));
  const up = merchants.filter((m) => m.now - m.then > 0).sort((x, y) => y.now - y.then - (x.now - x.then)).slice(0, 10);
  const down = merchants.filter((m) => m.now - m.then < 0).sort((x, y) => x.now - x.then - (y.now - y.then)).slice(0, 10);

  return (
    <>
      <StatGrid cols={4}>
        <StatCell label="Spending" value={usd0(a.spending)} sub={<Change now={a.spending} then={b.spending} goodWhenDown />} />
        <StatCell label="Income" value={usd0(a.income)} sub={<Change now={a.income} then={b.income} />} />
        <StatCell label="Saved" value={usd0(a.net)} tone={a.net < 0 ? "neg" : "neutral"} sub={<Change now={a.net} then={b.net} />} />
        <StatCell
          label="Savings rate"
          value={a.savingsRate == null ? "—" : formatPercentRatio(a.savingsRate, 0)}
          sub={b.savingsRate == null ? "—" : `${formatPercentRatio(b.savingsRate, 0)} a year earlier`}
        />
      </StatGrid>
      <Card title="By category" subtitle="Largest changes first. Click a category for its rows.">
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
                  <td className={`${table.tdR} text-muted`}>{usd0(c.then)}</td>
                  <td className={table.tdR}>{usd0(c.now)}</td>
                  <td className={table.td}>
                    <DivergingBar value={c.now - c.then} max={maxChange} />
                  </td>
                  <td className={`${table.tdR} ${c.now > c.then ? "text-neg" : c.now < c.then ? "text-pos" : ""}`}>{usdDelta(c.now - c.then)}</td>
                  <td className={table.tdR}>{c.then ? <Delta now={c.now} before={c.then} goodWhenDown /> : <span className="text-xs text-muted">new</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <MoverCard title="Spending more at" rows={up} ctx={ctx} />
        <MoverCard title="Spending less at" rows={down} ctx={ctx} />
      </div>
    </>
  );
}

function Change({ now, then, goodWhenDown = false }: { now: number; then: number; goodWhenDown?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <Delta now={now} before={then} goodWhenDown={goodWhenDown} />
      <span>from {usd0(then)}</span>
    </span>
  );
}

function MoverCard({ title, rows, ctx }: { title: string; rows: { key: string; name: string; now: number; then: number }[]; ctx: Ctx }) {
  return (
    <Card title={title} subtitle="Merchants, by dollar change.">
      {rows.length === 0 ? (
        <p className="text-xs text-muted">None.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line text-[13px]">
          {rows.map((m) => (
            <li key={m.key}>
              <button type="button" className="flex w-full items-center justify-between gap-3 py-1.5 text-left hover:text-accent" onClick={() => ctx.open({ kind: "merchant", key: m.key, name: m.name, lane: "EXPENSE" })}>
                <span className="min-w-0 truncate">{m.name}</span>
                <span className="num shrink-0 text-xs text-muted">
                  {usd0(m.then)} → <span className="text-fg">{usd0(m.now)}</span>
                  {!m.then && <span className="ml-1.5 text-info">new</span>}
                  {!m.now && <span className="ml-1.5">stopped</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type YearMetric = "spending" | "everyday" | "income" | "saved";
const METRIC: Record<YearMetric, { label: string; f: (m: SpendingMonth) => number; goodWhenDown: boolean }> = {
  spending: { label: "Spending", f: (m) => m.spendingCents, goodWhenDown: true },
  everyday: { label: "Everyday spending", f: (m) => m.kinds.everydayCents, goodWhenDown: true },
  income: { label: "Income", f: (m) => m.incomeCents, goodWhenDown: false },
  saved: { label: "Saved", f: (m) => m.netCents, goodWhenDown: false },
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
  const rows = MONTH_NAMES.map((name, i) => Object.fromEntries([["name", name], ...shown.map((s) => [String(s.y), s.values[i] == null ? null : s.values[i]! / 100])]));
  const latest = shown.at(-1);
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

  return (
    <Card
      title={`${METRIC[metric].label}, every year`}
      subtitle={
        view === "cumulative"
          ? "Running total from January: a line above last year's means more so far. A year without a proven January has no running total."
          : "Each month on its own. A gap is a month that isn't proven."
      }
      actions={
        <>
          <Segmented
            size="xs"
            ariaLabel="Figure"
            options={[
              { value: "spending", label: "Spending" },
              { value: "everyday", label: "Everyday" },
              { value: "income", label: "Income" },
              { value: "saved", label: "Saved" },
            ]}
            value={metric}
            onChange={setMetric}
          />
          <Segmented
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
            <span className="num font-semibold">{usd0(pace.now)}</span> <Delta now={pace.now} before={pace.then} goodWhenDown={METRIC[metric].goodWhenDown} />
          </span>
          <span>
            <span className="text-muted">{pace.prevYear} at that point:</span> <span className="num font-medium">{usd0(pace.then)}</span>
            {pace.full != null && <span className="text-muted"> · finished at {usd0(pace.full)}</span>}
          </span>
          {pace.projected != null && (
            <span title={`This year's total so far, scaled by how ${pace.prevYear}'s grew from ${MONTH_NAMES[pace.m]} to December.`} className="cursor-help">
              <span className="text-muted">
                On {pace.prevYear}&apos;s curve, {latest.y} lands near
              </span>{" "}
              <span className="num font-medium">{usdCompact(pace.projected)}</span>
            </span>
          )}
        </div>
      )}
      <div className="h-[300px] w-full min-w-0">
        <RechartsResponsive>
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="name" {...ui.xAxis} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip {...ui.tooltip} itemSorter={(it) => -Number(it.dataKey)} formatter={(v, n) => [v == null ? "—" : formatUsd(Math.round(Number(v))), String(n)]} />
            <Legend {...ui.legend} />
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
          </LineChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

type YearRow = { label: string; f: (m: SpendingMonth) => number; goodWhenDown?: boolean; strong?: boolean; color?: string; indent?: boolean };

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
    { label: "Income", f: (m) => m.incomeCents, strong: true },
    { label: "Spending", f: (m) => m.spendingCents, goodWhenDown: true, strong: true },
    ...KINDS.map((k) => ({ label: k.label, f: (m: SpendingMonth) => m.kinds[k.id], goodWhenDown: true, indent: true })),
    { label: "Saved", f: (m) => m.netCents, strong: true },
  ];
  const categoryRows: YearRow[] = SPEND_CATEGORIES.filter((c) => report.months.some((m) => m.spendingByCategory.some((x) => x.category === c && x.cents))).map((c) => ({
    label: c,
    f: (m: SpendingMonth) => m.spendingByCategory.find((x) => x.category === c)?.cents ?? 0,
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
        return (
          <td key={y.y} className={`${table.tdR} ${r.strong ? "font-semibold" : ""}`}>
            {usd0(v)}
            <div className="leading-none">{comparable(i) ? <YearDelta now={v} before={val(years[i - 1]!.months, r.f)} goodWhenDown={r.goodWhenDown} /> : <span className="text-xs">&nbsp;</span>}</div>
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
        <Segmented
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
                    {r == null ? "—" : formatPercentRatio(r, 0)}
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
function YearDelta({ now, before, goodWhenDown }: { now: number; before: number; goodWhenDown?: boolean }) {
  const meaningful = before >= 10_000 && Math.abs(now / before - 1) <= 3;
  return <Delta now={now} before={before} goodWhenDown={goodWhenDown} asPercent={meaningful} />;
}
