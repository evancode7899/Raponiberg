"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { Card, Segmented } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofRef } from "@/components/ui/proof/context";
import { CHARGE_BUCKETS, type SpendingMonth } from "@/lib/book/reports/spending";
import { axisUsd, formatPercentRatio, formatUsd, usd0 } from "@/lib/formatMoney";
import { useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { Ctx } from "./CashFlowClient";
import { median, sliceStart, sum } from "./model";
import { Delta } from "./parts";
import { unswept } from "@/lib/book/proof/clearance";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pctAxis = (v: number) => `${Math.round(v * 100)}%`;
/** Monday = 0 … Sunday = 6, for a day of a month. */
const weekday = (m: SpendingMonth, i: number) => {
  const [y, mo] = m.start.split("-").map(Number) as [number, number];
  return (new Date(Date.UTC(y, mo - 1, i + 1)).getUTCDay() + 6) % 7;
};
const bucketLabel = (i: number) => {
  const lo = i ? CHARGE_BUCKETS[i - 1]! / 100 : 0;
  const hi = CHARGE_BUCKETS[i]!;
  const k = (d: number) => (d >= 1000 ? `$${d / 1000}k` : `$${d}`);
  return hi === Infinity ? `${k(lo)}+` : i ? `${k(lo)}–${k(hi / 100)}` : `< ${k(hi / 100)}`;
};

const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;

type Basis = "all" | "everyday";

/**
 * How spending moves inside a month and a week: the month's running total against a
 * typical month's, which days and weekdays the money leaves on, and how charges split
 * by size. Everyday spending leaves out bills and charges of $1,500+, so a rent payment
 * or a tax bill doesn't drown out the pattern.
 */
export function PatternsTab({ ctx }: { ctx: Ctx }) {
  const { slice } = ctx;
  return (
    <>
      <Pace ctx={ctx} />
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Weekdays ctx={ctx} />
        <ChargeSizes ctx={ctx} months={slice.months} />
      </div>
      <MonthDays ctx={ctx} />
    </>
  );
}

const cumulative = (xs: number[]) => {
  let run = 0;
  return xs.map((v) => (run += v));
};

/** The latest month's running total, day by day, against the last month and a typical one. */
function Pace({ ctx }: { ctx: Ctx }) {
  const { report, slice, chart } = ctx;
  const ui = chartChrome(chart);
  const [basis, setBasis] = useState<Basis>("all");
  // A proven month still under way leads when the range runs to the latest month.
  const atEnd = slice.months.at(-1) === report.months.at(-1);
  const month = (atEnd && report.current) || slice.months.at(-1)!;
  const partial = month === report.current;
  const i = partial ? report.months.length : sliceStart(report, slice) + slice.months.length - 1;
  const days = (m: SpendingMonth) => (basis === "all" ? m.daily.allCents : m.daily.everydayCents);
  const prev = report.months[i - 1] ?? null;
  const history = report.months.slice(Math.max(0, i - 12), i);
  const cur = cumulative(days(month));
  const prevCum = prev ? cumulative(days(prev)) : [];
  const histCum = history.map((m) => cumulative(days(m)));
  // Typical: the median running total at each day across the twelve months before.
  const typical = Array.from({ length: 31 }, (_, d) => (histCum.length ? median(histCum.map((c) => c[Math.min(d, c.length - 1)]!)) : null));
  const throughDay = partial && month.through ? Number(month.through.slice(8, 10)) : cur.length;
  const rows = Array.from({ length: 31 }, (_, d) => ({
    day: d + 1,
    now: d < throughDay && d < cur.length ? cur[d]! / 100 : null,
    prev: d < prevCum.length ? prevCum[d]! / 100 : null,
    typical: typical[d] == null ? null : typical[d]! / 100,
  }));
  const nowAt = cur[throughDay - 1] ?? 0;
  const typAt = typical[throughDay - 1] ?? null;
  const typEnd = typical[30] ?? null;
  const mid = Math.min(14, cur.length - 1);
  const firstHalf = typEnd ? (typical[mid] ?? 0) / typEnd : null;
  // A running total is a month's spending only when it counts all of it: every charge, and
  // no quarter-total line spread across months (those count whole on the day here).
  const whole = (m: SpendingMonth, cents: number) => (basis === "all" && cents === m.spendingCents ? ctx.proof("spending", [m], { shownCents: cents }) : unswept("only all spending, to the whole month, has a recipe"));

  return (
    <Card
      title={`${month.label}, day by day${partial ? ` (through ${month.through})` : ""}`}
      subtitle={`Running total of ${basis === "all" ? "all spending" : "everyday spending (no bills, nothing over $1,500)"} against ${prev ? prev.label : "the month before"} and a typical month — the median running total of the ${history.length} months before. Pick an earlier end month with the range picker.`}
      actions={
        <Segmented
          size="xs"
          ariaLabel="Which spending"
          options={[
            { value: "all", label: "All spending" },
            { value: "everyday", label: "Everyday only" },
          ]}
          value={basis}
          onChange={setBasis}
        />
      }
    >
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-1 xl:content-start">
          {partial ? (
            <Stat label={`Spent through day ${throughDay}`} value={usd0(nowAt)} proof={whole(month, nowAt)} sub={typAt != null ? <><Delta now={nowAt} before={typAt} goodWhenDown /> vs typical {usd0(typAt)} by day {throughDay}</> : undefined} />
          ) : (
            <Stat label="Spent in the month" value={usd0(nowAt)} proof={whole(month, nowAt)} sub={typEnd != null ? <><Delta now={nowAt} before={typEnd} goodWhenDown /> vs a typical month</> : undefined} />
          )}
          {prev && (
            <Stat
              label={partial ? `${prev.label} by day ${throughDay}` : prev.label}
              value={usd0(partial ? prevCum[Math.min(throughDay, prevCum.length) - 1] ?? 0 : prevCum.at(-1) ?? 0)}
              proof={partial ? unswept("part of a month: no recipe for a day count yet") : whole(prev, prevCum.at(-1) ?? 0)}
              sub={partial ? `${usd0(prevCum.at(-1) ?? 0)} for the whole month` : "the month before"}
            />
          )}
          {typEnd != null && <Stat label="A typical month" value={usd0(typEnd)} proof={unswept("a typical month (median) has no recipe yet")} sub={firstHalf != null ? `${formatPercentRatio(firstHalf, 0)} of it gone by the 15th` : undefined} />}
        </div>
        <div className="h-[280px] w-full min-w-0">
          <RechartsResponsive>
            <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="day" {...ui.xAxis} ticks={[1, 5, 10, 15, 20, 25, 31]} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
              <Tooltip {...ui.tooltip} labelFormatter={(d) => `Day ${d}`} formatter={(v, n) => [v == null ? "—" : formatUsd(Math.round(Number(v))), String(n)]} />
              <Legend {...ui.legend} />
              <Line dataKey="typical" name="Typical month" stroke={chart.neutral} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              {prev && <Line dataKey="prev" name={prev.label} stroke={chart.series[6]} strokeWidth={1.5} strokeOpacity={0.7} dot={false} isAnimationActive={false} />}
              <Line dataKey="now" name={month.label} stroke={chart.spending} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </RechartsResponsive>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, sub, proof }: { label: string; value: string; sub?: ReactNode; proof: ProofRef }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold tracking-tight text-fg">
        <ProofValue proof={proof}>{value}</ProofValue>
      </div>
      {sub && <div className="mt-0.5 text-xs leading-snug text-muted">{sub}</div>}
    </div>
  );
}

/** Average everyday spending on each weekday (per occurrence of that weekday). */
function Weekdays({ ctx }: { ctx: Ctx }) {
  const { slice, chart } = ctx;
  const ui = chartChrome(chart);
  const cents = WEEKDAYS.map(() => 0);
  const seen = WEEKDAYS.map(() => 0);
  for (const m of slice.months) {
    m.daily.everydayCents.forEach((v, i) => {
      const w = weekday(m, i);
      cents[w]! += v;
      seen[w]!++;
    });
  }
  const rows = WEEKDAYS.map((name, w) => ({ name, avg: seen[w] ? cents[w]! / seen[w]! / 100 : 0 }));
  const total = sum(cents, (c) => c);
  const weekend = total > 0 ? (cents[5]! + cents[6]!) / total : null;
  const top = [...rows].sort((a, b) => b.avg - a.avg)[0]!;
  const low = [...rows].sort((a, b) => a.avg - b.avg)[0]!;
  return (
    <Card
      title="By weekday"
      subtitle={
        weekend == null
          ? "Average everyday spending on each day of the week."
          : `Average everyday spending per day. Weekends take ${formatPercentRatio(weekend, 0)} of it on 29% of the days; ${top.name} is the priciest day (${usd0(top.avg * 100)}), ${low.name} the cheapest (${usd0(low.avg * 100)}).`
      }
    >
      <div className="h-[240px] w-full min-w-0">
        <RechartsResponsive>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="name" {...ui.xAxis} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip {...ui.tooltip} formatter={(v) => [formatUsd(Math.round(Number(v))), "Average day"]} />
            <Bar dataKey="avg" fill={chart.spending} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
          </BarChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

/** How charges split by size: share of the count against share of the dollars. */
function ChargeSizes({ ctx, months }: { ctx: Ctx; months: SpendingMonth[] }) {
  const { chart } = ctx;
  const ui = chartChrome(chart);
  const b = CHARGE_BUCKETS.map((_, i) => ({ count: sum(months, (m) => m.chargeSizes[i]!.count), cents: sum(months, (m) => m.chargeSizes[i]!.cents) }));
  const n = sum(b, (x) => x.count);
  const c = sum(b, (x) => x.cents);
  const rows = b.map((x, i) => ({ name: bucketLabel(i), charges: n ? x.count / n : 0, dollars: c ? x.cents / c : 0, count: x.count, cents: x.cents }));
  const small = rows.slice(0, 3);
  const smallCount = sum(small, (r) => r.charges);
  const smallUsd = sum(small, (r) => r.dollars);
  return (
    <Card
      title="Charge sizes"
      subtitle={n ? `${formatPercentRatio(smallCount, 0)} of the ${n.toLocaleString("en-US")} charges were under $50, but they add up to only ${formatPercentRatio(smallUsd, 0)} of the dollars — the few big charges set the total.` : "No charges in range."}
    >
      <div className="h-[240px] w-full min-w-0">
        <RechartsResponsive>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="name" {...ui.xAxis} interval={0} tick={{ ...ui.xAxis.tick, fontSize: 10 }} />
            <YAxis {...ui.yAxis} width={40} tickFormatter={pctAxis} />
            <Tooltip
              {...ui.tooltip}
              formatter={(v, name, item) => {
                const r = item.payload as (typeof rows)[number];
                return name === "Share of charges" ? [`${formatPercentRatio(Number(v), 0)} · ${r.count.toLocaleString("en-US")} charges`, name] : [`${formatPercentRatio(Number(v), 0)} · ${usd0(r.cents)}`, String(name)];
              }}
            />
            <Legend {...ui.legend} />
            <Bar dataKey="charges" name="Share of charges" fill={chart.series[0]} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            <Bar dataKey="dollars" name="Share of dollars" fill={chart.spending} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          </BarChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

/** When in the month money leaves: bills and everyday spending by day of the month. */
function MonthDays({ ctx }: { ctx: Ctx }) {
  const { slice, chart } = ctx;
  const ui = chartChrome(chart);
  const rows = Array.from({ length: 31 }, (_, d) => {
    const has = slice.months.filter((m) => d < m.daily.allCents.length);
    const avg = (f: (m: SpendingMonth) => number[]) => (has.length ? sum(has, (m) => f(m)[d]!) / has.length / 100 : 0);
    return { day: d + 1, bills: avg((m) => m.daily.billCents), everyday: avg((m) => m.daily.everydayCents) };
  });
  const bills = sum(rows, (r) => r.bills);
  const firstWeek = sum(rows.slice(0, 7), (r) => r.bills);
  const everyday = rows.map((r) => r.everyday);
  const busiest = rows[everyday.indexOf(Math.max(...everyday))]!;
  return (
    <Card
      title="By day of the month"
      subtitle={`Average per calendar day over ${slice.label}; big one-offs left out.${
        bills > 0 ? ` ${formatPercentRatio(firstWeek / bills, 0)} of bill money leaves in the first week of the month.` : ""
      } Everyday spending runs highest on the ${ordinal(busiest.day)}.`}
    >
      <div className="h-[260px] w-full min-w-0">
        <RechartsResponsive>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="day" {...ui.xAxis} interval={1} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip {...ui.tooltip} labelFormatter={(d) => `Day ${d}`} formatter={(v, n) => [formatUsd(Math.round(Number(v))), String(n)]} />
            <Legend {...ui.legend} />
            <Bar dataKey="bills" name="Bills & subscriptions" stackId="d" fill={chart.series[6]} stroke={chart.tooltipBg} strokeWidth={1} maxBarSize={18} isAnimationActive={false} />
            <Bar dataKey="everyday" name="Everyday" stackId="d" fill={chart.spending} stroke={chart.tooltipBg} strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          </BarChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}
