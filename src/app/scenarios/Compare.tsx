"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Segmented } from "@/components/ui/kit";
import { axisUsd, NA } from "@/lib/formatMoney";
import { flowOf, goalShift, type Flow, type Metrics } from "@/lib/scenarios/compare";
import type { ScenarioRun } from "@/lib/scenarios/engine";
import type { GoalReach } from "@/lib/scenarios/goals";
import { memo, useMemo, useState, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { delta, money, monthLabel, monthsShift, pct, pctDelta } from "./ui";

/** One column of the comparison: today's plan first, then each compared scenario. */
export type Col = { id: string; name: string; run: ScenarioRun; m: Metrics; today: boolean };

const th = "px-2 py-1 text-right text-[11px] font-semibold text-fg-2 whitespace-nowrap";
const td = "num px-2 py-[3px] text-right whitespace-nowrap";
const lab = "px-2 py-[3px] text-left text-[12px] text-fg-2 whitespace-nowrap";

/** Good when positive (more saved), or when negative (less tax): the colour of a difference. */
const tone = (d: number | null, goodUp = true) => (d == null || Math.abs(d) < 50 ? "text-muted" : d > 0 === goodUp ? "text-pos" : "text-neg");

function Cell({ v, d, goodUp = true, raw }: { v: string; d?: { text: string; n: number | null } | null; goodUp?: boolean; raw?: ReactNode }) {
  return (
    <td className={td}>
      <span className="text-fg">{raw ?? v}</span>
      {d && <span className={`ml-1.5 text-[11px] ${tone(d.n, goodUp)}`}>{d.text}</span>}
    </td>
  );
}

export const DifferenceTable = memo(function DifferenceTable({ cols, goals, startKey, selected, onSelect }: { cols: Col[]; goals: GoalReach[]; startKey: string; selected: string; onSelect: (id: string) => void }) {
  const p = useChartPalette();
  const today = cols[0]!;
  // Each scenario's first year of change, against today's plan over the same months.
  const win = (c: Col): { s: Flow; t: Flow } => (c.today ? { s: c.m.window, t: c.m.window } : { s: c.m.window, t: flowOf(today.run.months, c.m.window.from) });
  const money3 = (f: (m: Metrics) => number) => (c: Col) => {
    const v = f(c.m);
    return { v: money(v), d: c.today ? null : { text: delta(v - f(today.m)), n: v - f(today.m) } };
  };
  const flowRow = (label: string, k: keyof Omit<Flow, "from" | "to" | "months" | "rate">, goodUp: boolean) => (
    <tr key={label} className="border-t border-line/60">
      <td className={lab}>{label}</td>
      {cols.map((c) => {
        const { s, t } = win(c);
        const n = s[k] - t[k];
        return <Cell key={c.id} v={money(s[k])} d={c.today ? null : { text: delta(n), n }} goodUp={goodUp} />;
      })}
    </tr>
  );
  const rows3 = (label: string, f: (m: Metrics) => number, goodUp = true, hint?: string) => (
    <tr key={label} className="border-t border-line/60" title={hint}>
      <td className={lab}>{label}</td>
      {cols.map((c) => {
        const x = money3(f)(c);
        return <Cell key={c.id} v={x.v} d={x.d} goodUp={goodUp} />;
      })}
    </tr>
  );
  const section = (title: string, sub?: ReactNode) => (
    <tr className="border-t border-line">
      <td colSpan={cols.length + 1} className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        {title}
        {sub && <span className="ml-2 font-normal normal-case tracking-normal text-faint">{sub}</span>}
      </td>
    </tr>
  );
  const nwAt = (offset: number) => {
    const y = Number(startKey.slice(0, 4)) + offset;
    return (m: Metrics) => m.netWorth.find((x) => x.year === y)?.cents ?? 0;
  };
  const y0 = Number(startKey.slice(0, 4));
  const horizon = today.m.horizon.year;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left text-[11px] font-semibold text-muted">vs today&apos;s plan</th>
            {cols.map((c, i) => (
              <th key={c.id} className={`${th} ${c.id === selected ? "bg-surface-2" : ""}`}>
                <button type="button" className="inline-flex items-center gap-1.5 outline-none hover:text-fg focus-visible:underline" onClick={() => onSelect(c.id)} title={c.today ? "Today's plan: the forecast" : `Edit ${c.name}`}>
                  <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: c.today ? p.lineBalance : p.series[i % p.series.length] }} />
                  {c.name}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section("A year from the change", "each scenario's first 12 months from its first change, against today's plan over the same months")}
          <tr className="border-t border-line/60">
            <td className={lab}>Months</td>
            {cols.map((c) => (
              <td key={c.id} className={`${td} text-muted`}>
                {monthLabel(c.m.window.from)} – {monthLabel(c.m.window.to)}
              </td>
            ))}
          </tr>
          {flowRow("Take-home pay", "takeHome", true)}
          {flowRow("Taxes", "tax", false)}
          {flowRow("Spending", "spending", false)}
          {flowRow("  of which childcare", "childcare", false)}
          {flowRow("  of which housing", "housing", false)}
          {flowRow("Saved", "saved", true)}
          <tr className="border-t border-line/60">
            <td className={lab}>Savings rate</td>
            {cols.map((c) => {
              const { s, t } = win(c);
              const n = s.rate != null && t.rate != null ? s.rate - t.rate : null;
              return <Cell key={c.id} v={pct(s.rate)} d={c.today ? null : { text: pctDelta(n), n: n == null ? null : n * 1e4 } } />;
            })}
          </tr>
          {section("Next three years")}
          {[0, 1, 2].map((k) => rows3(`Saved, year ${k + 1}`, (m) => m.years[k]?.saved ?? 0))}
          {rows3("Lowest cash", (m) => m.lowestCash.cents, true, "The lowest liquid balance (cash and taxable investments) over the next three years")}
          <tr className="border-t border-line/60" title="That lowest balance in months of the three years' average spending">
            <td className={lab}>Cash cushion</td>
            {cols.map((c) => (
              <td key={c.id} className={td}>
                {c.m.cushionMonths == null ? NA : `${c.m.cushionMonths.toFixed(1)} mo`}
                <span className="ml-1.5 text-[11px] text-muted">{monthLabel(c.m.lowestCash.key)}</span>
              </td>
            ))}
          </tr>
          {section("Long term")}
          {rows3(`Net worth ${y0 + 5}`, nwAt(5))}
          {rows3(`Net worth ${y0 + 10}`, nwAt(10))}
          {rows3(`Net worth ${horizon}`, (m) => m.horizon.netWorth, true, "Invested money plus home equity at the end of the forecast's last year")}
          {rows3(`  invested ${horizon}`, (m) => m.horizon.portfolio, true, "Cash, taxable and retirement money")}
          {rows3(`  home equity ${horizon}`, (m) => m.horizon.equity, true, "The home's value less what's still owed (no selling costs)")}
          <tr className="border-t border-line/60" title="The first year whose walk-away income (FIRE's rule: the withdrawal rate on January 1's invested money, after tax) covers that year's spending">
            <td className={lab}>Financially independent</td>
            {cols.map((c) => {
              const n = c.m.fiYear != null && today.m.fiYear != null ? c.m.fiYear - today.m.fiYear : null;
              return <Cell key={c.id} v={c.m.fiYear == null ? "not in 60 yrs" : String(c.m.fiYear)} d={c.today ? null : { text: n == null ? NA : n === 0 ? "—" : `${n > 0 ? "+" : "−"}${Math.abs(n)} yr`, n: n == null ? null : -n }} />;
            })}
          </tr>
          {goals.some((g) => g.remaining != null) && section("Goals reached")}
          {goals.map((g, gi) =>
            g.remaining == null ? null : (
              <tr key={g.id} className="border-t border-line/60" title={g.targetDate ? `Target: ${g.targetDate}` : undefined}>
                <td className={lab}>{g.name}</td>
                {cols.map((c) => {
                  const at = c.m.goals[gi] ?? null;
                  const n = goalShift(at, today.m.goals[gi] ?? null, startKey);
                  const late = g.targetDate && at && at !== "now" && at > g.targetDate.slice(0, 7);
                  return (
                    <Cell
                      key={c.id}
                      v=""
                      raw={<span className={late ? "text-warn" : ""}>{at === "now" ? "reached" : at ? monthLabel(at) : "not in view"}</span>}
                      d={c.today ? null : { text: monthsShift(n), n: n == null ? null : -n * 100 }}
                    />
                  );
                })}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
});

type ChartKey = "netWorth" | "portfolio" | "liquid";

export const PathChart = memo(function PathChart({ cols, horizonYear }: { cols: Col[]; horizonYear: number }) {
  const p = useChartPalette();
  const chrome = chartChrome(p);
  const [key, setKey] = useState<ChartKey>("netWorth");
  const data = useMemo(() => {
    const years = cols[0]!.run.years.filter((y) => y.year <= horizonYear).map((y) => y.year);
    return years.map((year) => {
      const row: Record<string, number> = { year };
      for (const c of cols) {
        const y = c.run.years.find((x) => x.year === year);
        if (!y) continue;
        row[c.id] = Math.round((key === "netWorth" ? y.netWorth : key === "portfolio" ? y.liquid + y.illiquid : y.liquid) / 100);
      }
      return row;
    });
  }, [cols, horizonYear, key]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-2">Path, end of each year</h3>
        <span className="ml-auto">
          <Segmented<ChartKey>
            size="xs"
            ariaLabel="What the chart shows"
            value={key}
            onChange={setKey}
            options={[
              { value: "netWorth", label: "Net worth", title: "Invested money plus home equity" },
              { value: "portfolio", label: "Invested", title: "Cash, taxable and retirement money (no home)" },
              { value: "liquid", label: "Liquid", title: "Cash and taxable investments: what goals and a down payment draw on" },
            ]}
          />
        </span>
      </div>
      <div className="h-56">
        <RechartsResponsive>
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...chrome.grid} />
            <XAxis dataKey="year" {...chrome.xAxis} />
            <YAxis {...chrome.yAxis} tickFormatter={(v: number) => axisUsd(v)} />
            <Tooltip {...chrome.tooltip} formatter={(v, name) => [money(Number(v) * 100), cols.find((c) => c.id === name)?.name ?? String(name)]} />
            {cols.map((c, i) => (
              <Line key={c.id} dataKey={c.id} type="monotone" dot={false} isAnimationActive={false} stroke={c.today ? p.lineBalance : p.series[i % p.series.length]} strokeWidth={c.today ? 1.5 : 2} strokeDasharray={c.today ? "4 3" : undefined} />
            ))}
          </LineChart>
        </RechartsResponsive>
      </div>
    </div>
  );
});

/** Month by month for a year of one scenario, against today's plan. */
export const MonthTable = memo(function MonthTable({ col, today }: { col: Col; today: Col }) {
  const [y, setY] = useState<"0" | "1" | "2">("0");
  const from = col.run.months.findIndex((m) => m.key >= (col.today ? col.run.months[0]!.key : col.m.window.from));
  const ms = col.run.months.slice(Math.max(0, from) + Number(y) * 12, Math.max(0, from) + Number(y) * 12 + 12);
  const base = new Map(today.run.months.map((m) => [m.key, m]));
  const line = (label: string, f: (m: (typeof ms)[number]) => number, hint?: string, cls = "") => (
    <tr className="border-t border-line/60" title={hint}>
      <td className={lab}>{label}</td>
      {ms.map((m) => (
        <td key={m.key} className={`${td} ${cls}`}>
          {money(f(m))}
        </td>
      ))}
    </tr>
  );
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-2">Month by month: {col.name}</h3>
        <span className="ml-auto">
          <Segmented<"0" | "1" | "2">
            size="xs"
            ariaLabel="Which year"
            value={y}
            onChange={setY}
            options={[
              { value: "0", label: "Year 1" },
              { value: "1", label: "Year 2" },
              { value: "2", label: "Year 3" },
            ]}
          />
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-[11px] font-semibold text-muted">{col.today ? "" : "from the change"}</th>
              {ms.map((m) => (
                <th key={m.key} className={th}>
                  {monthLabel(m.key).replace(" 20", " ’")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {line("Gross pay", (m) => m.gross, "Base pay and bonuses before tax")}
            {line("Taxes", (m) => m.tax, "Income and payroll tax on pay, and the tax a bonus adds")}
            {line("Take-home", (m) => m.takeHome, "Pay after tax and deductions (retirement saving included), plus bonuses kept")}
            {line("Spending", (m) => m.spending, "Living cost (childcare and housing included) and one-offs")}
            {line("  childcare", (m) => m.childcare, undefined, "text-muted")}
            {line("  housing", (m) => m.housing, "Rent and utilities, or the home's monthly cost", "text-muted")}
            {line("Saved", (m) => m.saved, "Take-home and employer money less spending")}
            {!col.today && (
              <tr className="border-t border-line/60">
                <td className={lab}>vs today</td>
                {ms.map((m) => {
                  const d = m.saved - (base.get(m.key)?.saved ?? 0);
                  return (
                    <td key={m.key} className={`${td} ${tone(d)}`}>
                      {delta(d)}
                    </td>
                  );
                })}
              </tr>
            )}
            {line("Liquid", (m) => m.liquid, "Cash and taxable investments at the month's end")}
          </tbody>
        </table>
      </div>
    </div>
  );
});
