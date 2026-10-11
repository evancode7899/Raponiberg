"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { btn, Callout, Card, StatCell, StatGrid } from "@/components/ui/kit";
import { FAT_SHARE, fireNumber, fiYear, LEAN_SHARE, livingIn, type FireRow } from "@/lib/fire/fire";
import { axisUsd } from "@/lib/formatMoney";
import type { OutlookSeeds } from "@/lib/profile/basePay";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import { monthLabel } from "@/app/forecast/forecastUi";
import type { FireTab } from "./FireClient";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { deflator, DollarsToggle, pct, short, tipUsd, usd, yearAge, yearsFrom, type FireProps } from "./ui";

type Tab = FireTab;

export function OverviewTab({
  f,
  dollars,
  setDollars,
  r,
  s,
  livingLabel,
  livingTyped,
  onGo,
}: FireProps & { r: AnnualProfileReport; s: OutlookSeeds; livingLabel: string; livingTyped: boolean; onGo: (t: Tab) => void }) {
  const { plan, now } = f;
  const fiIn = f.fi ? f.fi.year - plan.start.year : null;
  return (
    <>
      <Progress f={f} />
      <StatGrid cols={3}>
        <StatCell label="FIRE number" value={short(now.fireNumber)} sub={`${now.multiple.toFixed(1)}× living cost of ${short(now.livingCost)}`} />
        <StatCell
          label="Financially independent"
          value={f.fi ? String(f.fi.year) : "Not in 60 yrs"}
          tone={f.fi ? "pos" : "warn"}
          sub={
            <>
              {f.fi ? `${f.fi.age != null ? `age ${f.fi.age} · ` : ""}${fiIn! <= 0 ? "already there" : `${fiIn} yr${fiIn === 1 ? "" : "s"} to go`}` : "walk-away income stays short"}
              {f.fiBase?.year !== f.fi?.year && <> · with no bonuses: {f.fiBase ? f.fiBase.year : "not in 60 yrs"}</>}
            </>
          }
        />
        <StatCell label="Savings rate" value={pct(f.savingsRate, 0)} sub="of take-home + employer money, this year's plan" />
        <StatCell label="Years of spending saved" value={now.yearsOfSpending.toFixed(1)} sub={`net worth ÷ ${short(now.livingCost)} a year`} />
        <StatCell label="Runway (liquid)" value={`${now.liquidYears.toFixed(1)} yrs`} sub="taxable money ÷ a year's living cost" />
        <StatCell
          label="Coast FIRE"
          value={now.coastNumber != null && now.netWorth >= now.coastNumber ? "Reached" : f.coast ? String(f.coast.year) : plan.birthYear == null ? "Needs age" : "—"}
          sub={f.retireYear ? `stop saving, still FI at ${f.retireYear - plan.birthYear!}` : "add birth years in Settings"}
        />
      </StatGrid>
      <Insights f={f} r={r} s={s} livingLabel={livingLabel} livingTyped={livingTyped} onGo={onGo} />
      <TargetChart f={f} r={r} dollars={dollars} setDollars={setDollars} />
      <Flavors f={f} />
      <Milestones f={f} />
    </>
  );
}

function Progress({ f }: { f: FireProps["f"] }) {
  const { now } = f;
  const max = Math.max(now.fatNumber, now.netWorth) * 1.04;
  const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const marks = [
    { v: now.leanNumber, label: "Lean" },
    { v: now.fireNumber, label: "FIRE" },
    { v: now.fatNumber, label: "Fat" },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Progress to financial independence</div>
          <div className="num text-3xl font-semibold text-fg">{pct(now.progress, 0)}</div>
        </div>
        <div className="text-right text-xs text-muted">
          <span className="num font-medium text-fg">{usd(now.netWorth)}</span> net worth ({now.asOf}) of a <span className="num font-medium text-fg">{usd(now.fireNumber)}</span> FIRE number
          <br />
          {now.netWorth >= now.fireNumber ? "You're there — your money can cover your living cost." : `${usd(now.fireNumber - now.netWorth)} to go in today's terms`}
        </div>
      </div>
      <div className="relative mt-6 mb-5 h-3 rounded-full bg-surface-3" role="meter" aria-valuenow={Math.round(now.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to FI">
        <div className="h-3 rounded-full bg-accent" style={{ width: at(now.netWorth) }} />
        {marks.map((m) => (
          <div key={m.label} className="absolute -top-1.5 h-6 w-0.5 bg-fg-2" style={{ left: at(m.v) }} title={`${m.label} FIRE: ${usd(m.v)}`}>
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-fg-2">{m.label}</span>
            <span className="num absolute top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted">{short(m.v)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Insights({ f, r, s, livingLabel, livingTyped, onGo }: { f: FireProps["f"]; r: AnnualProfileReport; s: OutlookSeeds; livingLabel: string; livingTyped: boolean; onGo: (t: Tab) => void }) {
  const { plan } = f;
  const items: { tone: "info" | "warn" | "good"; title: string; body: ReactNode; action?: ReactNode }[] = [];
  const creep = plan.livingGrowth - plan.inflation;
  const creepFi = useMemo(() => (creep > 0.0001 ? fiYear({ ...plan, livingGrowth: plan.inflation }) : null), [plan, creep]);
  if (creep > 0.0001) {
    items.push({
      tone: "info",
      title: `Spending grows ${pct(creep)} a year faster than inflation`,
      body: (
        <>
          That&apos;s lifestyle creep compounding: living cost reaches {short(livingIn(plan, plan.start.year + 10))} in ten years. If spending only kept pace with inflation, FI would come in{" "}
          <strong>{creepFi ?? "more than 60 years"}</strong>
          {f.fi && creepFi ? ` instead of ${f.fi.year}` : ""}.
        </>
      ),
      action: (
        <button type="button" className={btn.secondary} onClick={() => onGo("levers")}>
          See the levers
        </button>
      ),
    });
  }
  const base = r.years.find((y) => y.year === s.baseYear);
  const untagged = base?.oneOffCandidates.filter((c) => !c.tagged) ?? [];
  if (!livingTyped && untagged.length) {
    const cents = untagged.reduce((t, c) => t + c.cents, 0);
    items.push({
      tone: "warn",
      title: `Living cost may include ${s.baseYear} one-offs`,
      body: (
        <>
          The plan starts from {usd(f.now.livingCost)} a year ({livingLabel.toLowerCase()}). {s.baseYear} living expenses include {usd(cents)} in {untagged.length} single charges of $1,500 or more not marked one-off. Each
          $1,000 a year that won&apos;t recur lowers your FIRE number by about {short(fireNumber(plan, plan.start.year, 1_000_00))}.
        </>
      ),
      action: (
        <Link href="/annual?tab=one-offs" className={btn.secondary}>
          Review one-offs
        </Link>
      ),
    });
  }
  if (plan.walkAwayYear != null && (!f.fi || plan.walkAwayYear < f.fi.year)) {
    const row = f.rows.find((x) => x.year === plan.walkAwayYear);
    items.push({
      tone: "warn",
      title: `Walking away in ${plan.walkAwayYear} is before financial independence`,
      body: row ? `Walk-away income would cover ${pct(row.coverage, 0)} of that year's living cost — about ${usd(row.gapMonthly)} a month short.` : "",
      action: (
        <button type="button" className={btn.secondary} onClick={() => onGo("walk-away")}>
          Walk-away income
        </button>
      ),
    });
  }
  const deficit = f.projection.find((p) => p.working && p.saved < 0);
  if (deficit) items.push({ tone: "warn", title: `From ${deficit.year} the plan saves nothing new`, body: "Living cost outgrows take-home pay; net worth grows only from returns after that." });
  if (plan.birthYear == null)
    items.push({
      tone: "info",
      title: "Add birth years for ages",
      body: "Coast FIRE, the 59½ access check and every age on this page need a birth year.",
      action: (
        <Link href="/settings?tab=household" className={btn.secondary}>
          Settings › Household
        </Link>
      ),
    });
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((i) => (
        <Callout key={i.title} tone={i.tone} title={i.title} action={i.action}>
          {i.body}
        </Callout>
      ))}
    </div>
  );
}

/** Net worth (actual dots, plan line) against the FIRE number it has to reach, on Jan 1 of each year. */
function TargetChart({ f, r, dollars, setDollars }: FireProps & { r: AnnualProfileReport }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const { plan } = f;
  const data = useMemo(() => {
    const d = (x: number, v: number | null) => (v == null ? null : v / 100 / deflator(plan, dollars, x));
    const rows: Record<string, number | null>[] = [];
    const byYear = new Map(f.rows.map((x) => [x.year, x]));
    const last = f.projection.at(-1)!;
    for (let year = plan.start.year; year <= last.year + 1; year++) {
      const p = f.projection.find((y) => y.year === year);
      const row = byYear.get(year);
      const living = livingIn(plan, year);
      rows.push({
        x: year,
        plan: d(year, p ? p.startNetWorth : last.netWorth),
        fire: d(year, row?.fireNumber ?? fireNumber(plan, year, living)),
        lean: d(year, fireNumber(plan, year, Math.round(living * LEAN_SHARE))),
        fat: d(year, fireNumber(plan, year, Math.round(living * FAT_SHARE))),
        coast: row?.coastNumber != null ? d(year, row.coastNumber) : null,
        actual: null,
      });
    }
    // Proven year ends (Dec 31 = Jan 1 of the next year) and the latest proven net worth.
    for (const y of r.years) {
      if (!y.netWorth) continue;
      const x = y.isCurrent ? y.year + (Date.parse(y.netWorthAsOf) - Date.UTC(y.year, 0, 1)) / (365.25 * 86_400_000) : y.year + 1;
      rows.push({ x, actual: d(x, y.netWorth.netWorth), plan: null, fire: null, lean: null, fat: null, coast: null });
    }
    return rows.sort((a, b) => a.x! - b.x!);
  }, [f, r, plan, dollars]);
  const xs = data.map((d) => d.x!);
  // Scale to net worth and the FIRE number; Fat FIRE runs off the top rather than flattening everything else.
  const yMax = Math.ceil(Math.max(...data.flatMap((d) => [d.plan ?? 0, d.fire ?? 0, d.actual ?? 0, d.coast ?? 0])) * 1.08);
  const ticks: number[] = [];
  const step = Math.max(1, Math.ceil((Math.max(...xs) - Math.min(...xs)) / 12));
  for (let t = Math.ceil(Math.min(...xs)); t <= Math.max(...xs); t += step) ticks.push(t);
  return (
    <Card
      title="Net worth vs. your FIRE number"
      subtitle={`On Jan 1 of each year. Where the plan line crosses the FIRE number, walk-away income covers living cost. The FIRE number rises with living cost (${pct(plan.livingGrowth)} a year).`}
      actions={<DollarsToggle value={dollars} onChange={setDollars} />}
    >
      <div className="h-[340px] w-full min-w-0">
        <RechartsResponsive>
          <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} ticks={ticks} tickFormatter={(v: number) => String(Math.round(v))} {...ui.xAxis} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} domain={[0, yMax]} allowDataOverflow />
            <Tooltip {...ui.tooltip} labelFormatter={(v) => (Number.isInteger(Number(v)) ? `Jan 1, ${v}` : "Latest proven")} formatter={(v, name) => [tipUsd(v), String(name)]} />
            <Legend {...ui.legend} />
            <Line type="monotone" dataKey="fat" name="Fat FIRE" stroke={chart.neutral} strokeDasharray="2 3" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="fire" name="FIRE number" stroke={chart.series[1]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="lean" name="Lean FIRE" stroke={chart.series[3]} strokeDasharray="5 3" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            {data.some((d) => d.coast != null) && (
              <Line type="monotone" dataKey="coast" name="Coast FIRE" stroke={chart.series[4]} strokeDasharray="1 3" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            )}
            <Line type="monotone" dataKey="plan" name="Net worth (plan)" stroke={chart.series[0]} strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="actual" name="Net worth (proven)" stroke="none" dot={{ r: 4, fill: chart.lineBalance, stroke: chart.tooltipBg, strokeWidth: 2 }} activeDot={{ r: 5 }} isAnimationActive={false} />
            {f.fi && <ReferenceLine x={f.fi.year} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: `FI ${f.fi.year}`, fill: chart.legend, fontSize: 11, position: "insideTopLeft" }} />}
            {plan.walkAwayYear && plan.walkAwayYear !== f.fi?.year && (
              <ReferenceLine x={plan.walkAwayYear} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: "Walk away", fill: chart.legend, fontSize: 11, position: "insideTopRight" }} />
            )}
          </ComposedChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

function Flavors({ f }: { f: FireProps["f"] }) {
  const { plan, now } = f;
  const card = (title: string, target: string, row: FireRow | null, what: ReactNode, reached: boolean) => (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-fg">{title}</span>
        {reached && <span className="rounded-full bg-pos-soft px-1.5 text-[10px] font-semibold uppercase text-pos">reached</span>}
      </div>
      <div className="num text-lg font-semibold text-fg">{reached ? "Now" : row ? yearAge(row.year, plan) : "Not in 60 yrs"}</div>
      <div className="text-[11px] text-muted">{reached || !row ? "" : yearsFrom(row.year, plan)}</div>
      <div className="text-[11px] font-medium text-fg-2">{target}</div>
      <p className="text-[11px] leading-snug text-muted">{what}</p>
    </div>
  );
  return (
    <Card title="The flavors of FIRE" subtitle="The community's names for different finish lines. Each is a first year you could make the switch, keeping the rest of the plan as set.">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
        {card("Lean FIRE", `${short(now.leanNumber)} today`, f.lean, `Retire on a leaner budget: ${LEAN_SHARE * 100}% of today's living cost (${short(now.livingCost * LEAN_SHARE)}/yr).`, now.netWorth >= now.leanNumber)}
        {card(
          "Coast FIRE",
          now.coastNumber != null ? `${short(now.coastNumber)} invested today` : "needs a birth year",
          f.coast,
          f.retireYear
            ? `Stop saving; returns alone grow your money to the FIRE number by ${f.retireYear} (age ${f.retireYear - plan.birthYear!}). Work only to cover spending.`
            : "Stop saving and let returns finish the job by retirement age.",
          now.coastNumber != null && now.netWorth >= now.coastNumber,
        )}
        {card(
          "Barista FIRE",
          `${usd(f.baristaMonthly)}/mo part-time, today's $`,
          f.barista,
          "Leave the career for part-time work that covers the gap between walk-away income and living cost (set the amount under Retiring).",
          false,
        )}
        {card("FIRE", `${short(now.fireNumber)} today`, f.fi, "Walk-away income covers your full living cost, after tax. Work becomes optional.", now.netWorth >= now.fireNumber)}
        {card("Fat FIRE", `${short(now.fatNumber)} today`, f.fat, `Room to spare: walk-away income covers ${FAT_SHARE * 100}% of living cost — upgrades, travel, a buffer for bad markets.`, now.netWorth >= now.fatNumber)}
      </div>
    </Card>
  );
}

function Milestones({ f }: { f: FireProps["f"] }) {
  const { plan } = f;
  return (
    <Card
      title="Milestones"
      subtitle="Net worth marks: the month the forecast first gets there (the same dates as the Forecast page). FI marks: the first Jan 1, when a year's draw is set."
    >
      <ol className="relative ml-2 border-l border-line">
        {f.milestones.map((m) => (
          <li key={m.id} className="relative pb-3 pl-5 last:pb-0">
            <span className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 ${m.reached ? "border-pos bg-pos" : m.year ? "border-accent bg-surface" : "border-line-strong bg-surface"}`} aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className={`text-sm font-medium ${m.reached ? "text-fg" : "text-fg-2"}`}>{m.label}</span>
              <span className={`num text-xs ${m.reached ? "text-pos" : "text-muted"}`}>{m.reached ? "✓ reached" : m.key ? `${monthLabel(m.year!, Number(m.key.slice(5)))}${m.age != null ? ` (age ${m.age})` : ""} · ${yearsFrom(m.year, plan)}` : m.year ? `Jan 1, ${yearAge(m.year, plan)} · ${yearsFrom(m.year, plan)}` : "not within 60 years"}</span>
            </div>
            {m.hint && <div className="text-[11px] text-muted">{m.hint}</div>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
