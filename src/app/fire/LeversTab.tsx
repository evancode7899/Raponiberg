"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { NA } from "@/lib/formatMoney";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Card, NotFigure, table, WhatIf } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { fiLevers, firstYearIncome, fiTornado, fiYear, LEVER_YEARLY, savingsRateCurve, sensitivityGrid, spendingCuts, type TornadoBar } from "@/lib/fire/fire";
import { useEffect, useMemo, useState } from "react";
import { applyScenario, scenarioOutcome, type FireScenario } from "@/lib/fire/scenarios";
import { useApi } from "@/components/ledger/useApi";
import { notify } from "@/components/ui/Feedback";
import { btn, inputCls, MoneyInput } from "@/components/ui/kit";
import { CartesianGrid, Line, LineChart, ReferenceDot, Tooltip, XAxis, YAxis } from "recharts";
import { Living } from "./OverviewTab";
import { pct, short, usd, yearAge, type FireProof, type FireProps } from "./ui";

const RATES = Array.from({ length: 17 }, (_, i) => 0.05 + i * 0.05);
const CUTS = [250, 500, 1_000, 2_000, 3_000, 5_000].map((d) => d * 100);
const RETURNS = [0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09];
const WRS = [0.03, 0.035, 0.04, 0.045, 0.05];

/** What moves the FI date. Each figure reruns the same plan with one assumption changed. */
export function LeversTab({ f, d, pf }: FireProps & { pf: FireProof }) {
  const { plan } = f;
  const base = f.fi?.year ?? null;
  const delta = (y: number | null) => (y == null || base == null ? (y == null ? (base == null ? NA : "never") : "reaches FI") : y === base ? "same" : y < base ? `${base - y} yr${base - y === 1 ? "" : "s"} sooner` : `${y - base} yr${y - base === 1 ? "" : "s"} later`);
  const deltaTone = (y: number | null) => (y == null ? "text-warn" : base == null || y < base ? "text-pos" : y > base ? "text-warn" : "text-muted");

  const curve = useMemo(() => savingsRateCurve(plan, RATES), [plan]);
  const cuts = useMemo(() => spendingCuts(plan, CUTS), [plan]);
  const grid = useMemo(() => sensitivityGrid(plan, RETURNS, WRS), [plan]);
  const compare = useMemo(() => {
    const at = (key: "spend" | "earn") => levers.find((l) => l.key === key)!.fiYear;
    const levers = fiLevers(plan);
    return { spendLess: at("spend"), earnMore: at("earn"), earnMoreNet: Math.round(LEVER_YEARLY * plan.takeHomeRate) };
  }, [plan]);
  const creep = useMemo(
    () =>
      [
        { label: `With inflation only (${pct(plan.inflation)})`, g: plan.inflation },
        { label: `Inflation + 1% (${pct(plan.inflation + 0.01)})`, g: plan.inflation + 0.01 },
        { label: `Inflation + 2% (${pct(plan.inflation + 0.02)})`, g: plan.inflation + 0.02 },
        { label: `Inflation + 3% (${pct(plan.inflation + 0.03)})`, g: plan.inflation + 0.03 },
      ].map((c) => ({ ...c, year: fiYear({ ...plan, livingGrowth: c.g }), mine: Math.abs(c.g - plan.livingGrowth) < 1e-9 })),
    [plan],
  );

  return (
    <>
      <Tornado plan={plan} base={base} />
      <Scenarios plan={plan} />
      <SavingsRateChart f={f} curve={curve} d={d} pf={pf} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Card
          title="Spend less"
          subtitle={
            <>
              First-year living cost lower by a monthly amount (today <Living d={d}>{short(plan.livingCost)}</Living>/yr). Less spending saves more and lowers the FIRE number.
            </>
          }
        >
          <WhatIf why="living cost cut by a monthly amount" className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Cut</th>
                  <th className={table.thR}>Living cost</th>
                  <th className={table.thR}>FI year</th>
                  <th className={table.thR}>Change</th>
                </tr>
              </thead>
              <tbody>
                {cuts.map((c) => (
                  <tr key={c.monthly} className={table.trHover}>
                    <td className={table.td}>{usd(c.monthly)}/mo</td>
                    <td className={table.tdR}>{short(c.livingCost)}/yr</td>
                    <td className={table.tdR}>{yearAge(c.fiYear, plan)}</td>
                    <td className={`${table.tdR} ${deltaTone(c.fiYear)}`}>{delta(c.fiYear)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </WhatIf>
        </Card>
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title={<NotFigure why="the same round amount both ways">Spend $1,000/mo less, or earn $12,000/yr more?</NotFigure>}
            subtitle="Same dollars, different effect: a raise is taxed and only adds savings, while spending less also shrinks the target."
          >
            <WhatIf why="$12,000 a year less spending vs more pay" className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg border border-line p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted">Spend $12k/yr less</div>
                <div className="num text-xl font-semibold text-fg">{compare.spendLess ?? "never"}</div>
                <div className={`text-xs ${deltaTone(compare.spendLess)}`}>{delta(compare.spendLess)}</div>
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted">Earn $12k/yr more</div>
                <div className="num text-xl font-semibold text-fg">{compare.earnMore ?? "never"}</div>
                <div className={`text-xs ${deltaTone(compare.earnMore)}`}>{delta(compare.earnMore)}</div>
                <div className="text-[11px] text-muted">≈ {usd(compare.earnMoreNet)} after tax, growing {pct(plan.salaryGrowth)}/yr</div>
              </div>
            </WhatIf>
          </Card>
          <Card title="Lifestyle creep" subtitle="How fast living cost grows each year. Spending that rises faster than inflation keeps pushing the finish line away.">
            <WhatIf why="living cost growing faster than inflation" className={table.wrap}>
              <table className={table.table}>
                <tbody>
                  {creep.map((c) => (
                    <tr key={c.label} className={`${table.trHover} ${c.mine ? "bg-info-soft font-medium" : ""}`}>
                      <td className={table.td}>
                        {c.label}
                        {c.mine && <span className="ml-1.5 text-[10px] uppercase text-info">your plan</span>}
                      </td>
                      <td className={table.tdR}>{yearAge(c.year, plan)}</td>
                      <td className={`${table.tdR} ${deltaTone(c.year)}`}>{delta(c.year)}</td>
                    </tr>
                  ))}
                  {!creep.some((c) => c.mine) && (
                    <tr className={`${table.tr} bg-info-soft font-medium`}>
                      <td className={table.td}>Your plan ({pct(plan.livingGrowth)})</td>
                      <td className={table.tdR}>{yearAge(base, plan)}</td>
                      <td className={`${table.tdR} text-muted`}>—</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </WhatIf>
          </Card>
        </div>
      </div>
      <Card
        title="Markets and withdrawal rate"
        subtitle="FI year for each nominal return (rows) and withdrawal rate (columns). Lower withdrawal rates are safer over long early retirements but need a bigger pile. Your plan is outlined."
      >
        <WhatIf why="FI year at each return and withdrawal rate" className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Return \ Draw</th>
                {WRS.map((w) => (
                  <th key={w} className={table.thR}>
                    {pct(w)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RETURNS.map((r, i) => (
                <tr key={r} className={table.tr}>
                  <td className={`${table.td} font-medium`}>{pct(r)}</td>
                  {WRS.map((w, j) => {
                    const y = grid[i]![j]!;
                    const mine = Math.abs(r - plan.returnRate) < 1e-9 && Math.abs(w - plan.withdrawalRate) < 1e-9;
                    const tint = y == null ? "bg-neg-soft" : base == null ? "bg-pos-soft" : y < base ? "bg-pos-soft" : y > base ? "bg-warn-soft" : "";
                    return (
                      <td key={w} className={`${table.tdR} ${tint} ${mine ? "outline outline-2 -outline-offset-2 outline-accent font-semibold" : ""}`} title={y ? yearAge(y, plan) : "not within 60 years"}>
                        {y ?? NA}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </WhatIf>
        <p className="mt-2 text-[11px] text-muted">Green: sooner than your plan · amber: later · red: not within 60 years.</p>
      </Card>
    </>
  );
}

function SavingsRateChart({ f, curve, d, pf }: { f: FireProps["f"]; curve: ReturnType<typeof savingsRateCurve>; d: FireProps["d"]; pf: FireProof }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const { plan } = f;
  const data = curve.map((c) => ({ rate: Math.round(c.rate * 100), years: c.years }));
  const mine = f.savingsRate != null && f.fi ? { rate: Math.round(f.savingsRate * 100), years: f.fi.year - plan.start.year } : null;
  const income = firstYearIncome(plan);
  return (
    <Card
      title="Savings rate → years to financial independence"
      subtitle={
        <>
          The classic FIRE chart, on your numbers: <ProofValue proof={pf("income", income)}>{short(income)}</ProofValue> of take-home + employer money this year,{" "}
          <ProofValue proof={d.start}>{short(plan.start.liquid + plan.start.illiquid)}</ProofValue> already saved. Each point sets spending so that share is saved, then runs the plan
          to FI. The dot is you.
        </>
      }
    >
      <div className="h-[300px] w-full min-w-0">
        <RechartsResponsive tableTitle="Years to FI at each savings rate" plainSeries={{ years: "years to financial independence: a count of years, at each savings rate tried" }}>
          <LineChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="rate" type="number" domain={[5, 85]} ticks={[10, 20, 30, 40, 50, 60, 70, 80]} tickFormatter={(v: number) => `${v}%`} {...ui.xAxis} />
            <YAxis {...ui.yAxis} width={40} allowDecimals={false} tickFormatter={(v: number) => `${v}y`} />
            <Tooltip {...ui.tooltip} labelFormatter={(v) => `Saving ${v}%`} formatter={(v) => [v == null ? "not within 60 years" : `${v} years`, "To FI"]} />
            <Line type="linear" dataKey="years" name="Years to FI" stroke={chart.series[0]} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
            {mine && <ReferenceDot x={mine.rate} y={mine.years} r={6} fill={chart.series[1]} stroke={chart.tooltipBg} strokeWidth={2} label={{ value: "You", position: "top", fill: chart.legend, fontSize: 11 }} />}
          </LineChart>
        </RechartsResponsive>
      </div>
      {f.savingsRate != null && (
        <p className="mt-2 text-xs text-muted">
          You: saving{" "}
          <span className="font-medium text-fg">
            <ProofValue proof={pf("savings-rate", null)}>{pct(f.savingsRate, 0)}</ProofValue>
          </span>{" "}
          this year →{" "}
          {f.fi ? `FI in ${f.fi.year - plan.start.year} years` : "not financially independent within 60 years at that rate"}. Missing points: rates that don&apos;t reach FI within 60 years.
        </p>
      )}
    </Card>
  );
}

/**
 * What moves the date most (lib/fire/fire.ts fiTornado): each assumption a round step lower
 * and higher, the bar running from the year one way to the year the other, the plan's year the
 * line down the middle. Biggest swing at the top.
 */
function Tornado({ plan, base }: { plan: FireProps["f"]["plan"]; base: number | null }) {
  const bars = useMemo(() => fiTornado(plan), [plan]);
  if (base == null) return null;
  const years = bars.flatMap((b) => [b.low.fiYear, b.high.fiYear]).filter((y): y is number => y != null);
  const lo = Math.min(base, ...years) - 1;
  const hi = Math.max(base, ...years) + 1;
  const at = (y: number | null) => `${(((y ?? hi) - lo) / (hi - lo)) * 100}%`;
  const words = (y: number | null) => (y == null ? "not reached" : y === base ? "no change" : `${y} (${y < base ? "−" : "+"}${Math.abs(y - base)})`);
  const side = (s: TornadoBar["low"]) => (
    <span className={s.fiYear == null || s.fiYear > base ? "text-warn" : s.fiYear < base ? "text-pos" : "text-muted"}>
      {s.label}: {words(s.fiYear)}
    </span>
  );
  return (
    <Card title="What moves the date most" subtitle={`Each assumption a step lower and higher, the rest of the plan as it is; the line is the plan's FI year, ${base}. Biggest swing first.`}>
      <WhatIf why="the plan rerun with one assumption nudged" className="flex flex-col gap-1.5">
        {bars.map((b) => {
          const ys = [b.low.fiYear ?? hi, b.high.fiYear ?? hi];
          return (
            <div key={b.key} className="grid grid-cols-[9rem_1fr] items-center gap-2 text-xs sm:grid-cols-[9rem_1fr_16rem]">
              <span className="font-medium text-fg">{b.label}</span>
              <span aria-hidden className="relative block h-3 bg-surface-3">
                <span className="absolute inset-y-0 bg-accent/70" style={{ left: at(Math.min(...ys)), width: `calc(${at(Math.max(...ys))} - ${at(Math.min(...ys))})` }} />
                <span className="absolute inset-y-[-2px] w-px bg-fg" style={{ left: at(base) }} />
              </span>
              <span className="num hidden gap-2 sm:flex sm:justify-between">
                {side(b.low)}
                {side(b.high)}
              </span>
            </div>
          );
        })}
      </WhatIf>
    </Card>
  );
}

/**
 * Saved scenarios side by side (lib/fire/scenarios.ts): the plan as set, then each kept
 * scenario's changes run through the same engine. Kept in the data folder by name; a calculator.
 */
function Scenarios({ plan }: { plan: FireProps["f"]["plan"] }) {
  const api = useApi(false);
  const [list, setList] = useState<FireScenario[]>([]);
  const [draft, setDraft] = useState({ name: "", workYears: 0, livingMonthly: 0, oneOffAmount: 0, oneOffYear: plan.start.year + 1 });
  useEffect(() => {
    if (!api.ready) return;
    api
      .call<{ scenarios: FireScenario[] }>("/api/fire/scenarios")
      .then((x) => setList(x.scenarios))
      .catch(() => {});
  }, [api]);
  const post = (json: Record<string, unknown>, said: string) =>
    api
      .call<{ scenarios: FireScenario[] }>("/api/fire/scenarios", { method: "POST", json })
      .then((x) => {
        setList(x.scenarios);
        notify(said, { tone: "info" });
      })
      .catch((e: Error) => notify(e.message, { tone: "bad" }));
  const cols = useMemo(() => [{ id: "plan", name: "As planned", o: scenarioOutcome(plan) }, ...list.map((s) => ({ id: s.id, name: s.name, o: scenarioOutcome(applyScenario(plan, s)) }))], [plan, list]);
  const row = (label: string, v: (o: (typeof cols)[number]["o"]) => string) => (
    <tr className={table.tr}>
      <td className={table.td}>{label}</td>
      {cols.map((c) => (
        <td key={c.id} className={table.tdR}>
          {v(c.o)}
        </td>
      ))}
    </tr>
  );
  const save = () =>
    post(
      { op: "save", name: draft.name, workYears: draft.workYears, livingDelta: draft.livingMonthly * 12, oneOff: draft.oneOffAmount > 0 ? { year: draft.oneOffYear, amount: draft.oneOffAmount } : null },
      `Kept: ${draft.name}`,
    ).then(() => setDraft((d) => ({ ...d, name: "" })));
  return (
    <Card title="Scenarios side by side" subtitle="The plan as set, then each scenario you keep: more or fewer years of work, a change in living cost, a one-off cost like a down payment. Kept by name in the data folder.">
      <WhatIf why="the plan rerun with each scenario's changes" className={table.wrap}>
        <table className={`${table.table} min-w-[32rem]`}>
          <thead className={table.head}>
            <tr>
              <th className={table.th} />
              {cols.map((c) => (
                <th key={c.id} className={table.thR}>
                  {c.name}
                  {c.id !== "plan" && (
                    <button type="button" className={`${btn.ghost} ml-1 !px-1 !py-0 text-[11px]`} aria-label={`Remove ${c.name}`} onClick={() => void post({ op: "remove", id: c.id }, `Removed: ${c.name}`)}>
                      ✕
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row("FI year", (o) => (o.fiYear == null ? "not in 60 yrs" : String(o.fiYear)))}
            {row("Walk away", (o) => (o.walkAwayYear == null ? "—" : String(o.walkAwayYear)))}
            {row("Net worth at walk-away", (o) => (o.netWorthAtWalkAway == null ? "—" : short(o.netWorthAtWalkAway)))}
            {row("First retired year: income ÷ living cost", (o) => (o.firstCoverage == null ? "—" : pct(o.firstCoverage, 0)))}
            {row(`Net worth, ${plan.horizonYear}`, (o) => short(o.endNetWorth))}
          </tbody>
        </table>
      </WhatIf>
      <form
        className="mt-3 flex flex-wrap items-end gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.name.trim()) void save();
        }}
      >
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">Name</span>
          <input className={`${inputCls} w-40`} value={draft.name} placeholder="One more year" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">Years more work</span>
          <input className={`${inputCls} w-20`} type="number" min={-20} max={20} value={draft.workYears} onChange={(e) => setDraft({ ...draft, workYears: Number(e.target.value) || 0 })} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">Living cost a month more</span>
          <MoneyInput cents={draft.livingMonthly} ariaLabel="Living cost a month more" onChange={(c) => setDraft({ ...draft, livingMonthly: c ?? 0 })} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">One-off cost</span>
          <MoneyInput cents={draft.oneOffAmount} allowNegative={false} ariaLabel="One-off cost" onChange={(c) => setDraft({ ...draft, oneOffAmount: c ?? 0 })} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">in</span>
          <input className={`${inputCls} w-20`} type="number" value={draft.oneOffYear} onChange={(e) => setDraft({ ...draft, oneOffYear: Number(e.target.value) || plan.start.year + 1 })} />
        </label>
        <button type="submit" className={btn.secondary} disabled={!draft.name.trim()}>
          Keep scenario
        </button>
      </form>
    </Card>
  );
}
