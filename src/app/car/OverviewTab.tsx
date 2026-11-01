"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { ShareBar } from "@/components/charts/ShareBar";
import { chartChrome } from "@/components/shell/chartPalette";
import { Badge, btn, Card, NotFigure, Segmented, StatCell, StatGrid, table, type Tone } from "@/components/ui/kit";
import { compositeOf, sumOf, type ProofRef } from "@/components/ui/proof/context";
import { COST_LINES, LINE_INFO, type CostLine } from "@/lib/car/report";
import { SHARED } from "@/lib/car/settings";
import { axisUsd, formatPercentRatio, usd0 } from "@/lib/formatMoney";
import { useMemo, useState, type ReactNode } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
import type { CarCtx } from "./CarClient";
import { isReading } from "./EntryEditor";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { BUCKETS, bucketColor, bucketOf, byBucket, carProof, fmtDate, logProof, miles, NumInput, perMile, relative, Swatch, throughText, usd2 } from "./parts";
import { serviceDue } from "./ServiceTab";
import { noFigure } from "@/lib/book/proof/clearance";
import { outlookKey } from "@/lib/book/derived/car";

type Span = "toDate" | "last12" | "next12";

export function OverviewTab({ ctx }: { ctx: CarCtx }) {
  const { report: r, chart } = ctx;
  const t = r.totals;
  const ui = chartChrome(chart);
  const [span, setSpan] = useState<Span>("toDate");

  const view = useMemo(() => {
    const until = throughText(r, ctx.car.sale?.date ?? null);
    if (span === "last12") return { lines: r.last12.lines as Partial<Record<CostLine, number>>, total: r.last12.total, miles: r.last12.miles, months: 12, note: `${fmtDate(r.last12.from)} – ${until}` };
    if (span === "next12") return { lines: r.outlook12.lines, total: r.outlook12.total, miles: r.outlook12.miles, months: 12, note: `Estimate. ${r.outlook12.notes.join(" · ")}` };
    return { lines: r.accrued as Partial<Record<CostLine, number>>, total: t.tco, miles: r.odometer.driven, months: r.odometer.daysOwned / (365.25 / 12), note: `${fmtDate(r.odometer.readings[0]?.date)} – ${until}; prepaid premiums count as they're used` };
  }, [span, r, t.tco, ctx.car.sale?.date]);

  const monthly = useMemo(
    () =>
      r.months.map((m) => {
        const b = byBucket(m.lines);
        return { label: m.label, ...b, miles: m.miles, perMile: m.cumulativePerMile == null ? null : m.cumulativePerMile / 100, total: m.total / 100 };
      }),
    [r.months],
  );

  // Figures to date and over the last 12 months open the car proof; the next 12 months (an estimate on no statement) are the outlook the derived list states.
  const proven = span === "next12" ? null : span;
  const segments = BUCKETS.map((b) => ({ id: b.id, label: b.label, cents: b.lines.reduce((s, l) => s + (view.lines[l] ?? 0), 0), color: bucketColor(chart, b.id) }));
  const lines = COST_LINES.filter((l) => (view.lines[l] ?? 0) !== 0).sort((a, b) => (view.lines[b] ?? 0) - (view.lines[a] ?? 0));
  // A line and the total as figures: proven to date or the last 12 months, the outlook the derived list states for the next 12.
  const lineRef = (l: CostLine, c: number): ProofRef => (proven ? carProof(r.carId, { span: proven, line: l }, c) : ctx.dp("outlook", outlookKey(r.carId, l)));
  const totalRef: ProofRef = proven ? carProof(r.carId, { span: proven }, view.total) : ctx.dp("outlook", outlookKey(r.carId, "total"));
  const fixedLines = lines.filter((l) => LINE_INFO[l].group === "FIXED");
  const fixedCents = fixedLines.reduce((s, l) => s + (view.lines[l] ?? 0), 0);

  return (
    <>
      <Garage ctx={ctx} />

      <StatGrid cols={6}>
        <StatCell label="Cost of ownership" value={usd0(t.tco)} proof={carProof(r.carId, { span: "toDate" }, t.tco)} sub={
            <>
              {miles(r.odometer.daysOwned / 30.44, 0)} months, all-in · <ProofValue proof={ctx.dp("statement-cents")}>{usd0(t.statementCents)}</ProofValue> on statements, <NotFigure why="your entries: the price, interest and costs paid outside your statements">{usd0(t.typedCents)}</NotFigure> typed by you (price, interest, off-statement)
            </>
          }
        />
        <StatCell label="All-in per mile" value={perMile(t.perMile)} proof={t.perMile != null ? carProof(r.carId, { span: "toDate", per: "mile" }, null) : noFigure("no miles to divide by yet")} tone="accent" sub={r.last12.perMile != null ? <><ProofValue proof={carProof(r.carId, { span: "last12", per: "mile" }, null)}>{perMile(r.last12.perMile)}</ProofValue> over the last 12 months</> : undefined} />
        <StatCell label="Per month" value={usd0(t.perMonth)} proof={t.perMonth != null ? carProof(r.carId, { span: "toDate", per: "month" }, null) : noFigure("not a month owned yet")} sub={t.perDay != null ? <><ProofValue proof={ctx.dp("per-day")}>{perMile(t.perDay)}</ProofValue> a day</> : undefined} />
        <StatCell proof={ctx.dp("marginal-per-mile")} drawn={{ per: 100 }}
          label="One more mile"
          value={perMile(t.marginalPerMile)}
          sub={
            t.operatingPerMile != null ? (
              <>
                <ProofValue proof={ctx.dp("operating-per-mile")} drawn={{ per: 100 }}>{perMile(t.operatingPerMile)}</ProofValue> fuel &amp; upkeep + <ProofValue proof={ctx.dp("planned-per-mile")} drawn={{ per: 100 }}>{perMile(r.depreciation.plannedPerMile)}</ProofValue> wear
              </>
            ) : (
              "needs odometer readings"
            )
          }
        />
        <StatCell proof={ctx.dp("miles-driven")} label="Miles driven" value={miles(r.odometer.driven)} sub={r.odometer.perYear ? `~${miles(r.odometer.perYear)} a year · odometer ${miles(r.odometer.current)}` : undefined} />
        <StatCell proof={ctx.dp("mpg")} label="Fuel economy" value={r.fuel.mpg ? `${r.fuel.mpg.toFixed(1)} mpg` : "—"} sub={r.fuel.recentMpg ? `${r.fuel.recentMpg.toFixed(1)} over the last ${Math.min(5, r.fuel.fills.length)} fills` : "log gallons and odometer"} />
      </StatGrid>

      <Alerts ctx={ctx} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <Card
          title="Where the money goes"
          subtitle={view.note}
          actions={
            <Segmented view
              size="xs"
              value={span}
              onChange={setSpan}
              options={[
                { value: "toDate", label: "To date" },
                { value: "last12", label: "Last 12 mo" },
                ...(r.sold ? [] : [{ value: "next12" as const, label: "Next 12 mo" }]),
              ]}
            />
          }
        >
          <ShareBar segments={segments} label="Cost of ownership by kind" />
          <div className={`${table.wrap} mt-3`}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Cost</th>
                  <th className={table.thR}>Total</th>
                  <th className={table.thR}>Per mile</th>
                  <th className={table.thR}>Per month</th>
                  <th className={table.thR}>Share</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const c = view.lines[l] ?? 0;
                  return (
                    <tr key={l} className={table.tr}>
                      <td className={table.td}>
                        <span className="flex items-center gap-2">
                          <Swatch color={bucketColor(chart, bucketOf(l))} />
                          {LINE_INFO[l].label}
                          {l === "DEPRECIATION" && <Badge tone="neutral">{r.depreciation.method === "MARKET" ? "market" : r.depreciation.method === "SOLD" ? "sold" : "planned"}</Badge>}
                        </span>
                      </td>
                      <td className={table.tdR}>
                        <ProofValue proof={proven ? carProof(r.carId, { span: proven, line: l }, c) : ctx.dp("outlook", outlookKey(r.carId, l))}>{usd0(c)}</ProofValue>
                      </td>
                      <td className={table.tdR}>{view.miles > 0 ? <ProofValue proof={proven ? carProof(r.carId, { span: proven, line: l, per: "mile" }, null) : ctx.dp("outlook-per-mile", outlookKey(r.carId, l))} drawn={proven ? undefined : { per: 100 }}>{perMile(c / view.miles)}</ProofValue> : "—"}</td>
                      <td className={table.tdR}>{view.months >= 1 ? <ProofValue proof={proven ? carProof(r.carId, { span: proven, line: l, per: "month" }, null) : ctx.dp("outlook-per-month", outlookKey(r.carId, l))}>{usd0(c / view.months)}</ProofValue> : "—"}</td>
                      <td className={`${table.tdR} text-muted`}>{view.total ? <ProofValue proof={compositeOf("share", [lineRef(l, c), totalRef], { ratio: c / view.total })}>{formatPercentRatio(c / view.total, 0)}</ProofValue> : "—"}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-[3px] border-double border-line-strong font-semibold">
                  <td className={table.td}>Total</td>
                  <td className={table.tdR}>
                    <ProofValue proof={proven ? carProof(r.carId, { span: proven }, view.total) : ctx.dp("outlook", outlookKey(r.carId, "total"))}>{usd0(view.total)}</ProofValue>
                  </td>
                  <td className={table.tdR}>{view.miles > 0 ? <ProofValue proof={proven ? carProof(r.carId, { span: proven, per: "mile" }, null) : ctx.dp("outlook-per-mile", outlookKey(r.carId, "total"))} drawn={proven ? undefined : { per: 100 }}>{perMile(view.total / view.miles)}</ProofValue> : "—"}</td>
                  <td className={table.tdR}>{view.months >= 1 ? <ProofValue proof={proven ? carProof(r.carId, { span: proven, per: "month" }, null) : ctx.dp("outlook-per-month", outlookKey(r.carId, "total"))}>{usd0(view.total / view.months)}</ProofValue> : "—"}</td>
                  <td className={table.tdR} />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            {miles(view.miles)} miles. Fixed costs (insurance, parking, taxes) are{" "}
            {view.total && fixedLines.length ? (
              <ProofValue proof={compositeOf("share", [sumOf(fixedLines.map((l) => lineRef(l, view.lines[l] ?? 0)), fixedCents), totalRef], { ratio: fixedCents / view.total })}>{formatPercentRatio(fixedCents / view.total, 0)}</ProofValue>
            ) : (
              "—"
            )}{" "}
            of the total: the more you drive, the less each mile costs.
          </p>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <RecentLog ctx={ctx} />
          {!r.sold && <TripCost ctx={ctx} />}
          <Card title="Owning vs driving" subtitle="What the car costs standing still, and what each mile adds.">
            <StatGrid cols={2}>
              <StatCell proof={ctx.dp("fixed-per-month")} label="Owning it, per month" value={usd0(t.fixedPerMonth)} sub="insurance, parking, taxes, interest — accrued to date" />
              <StatCell proof={ctx.dp("operating-per-mile")} drawn={{ per: 100 }} label="Driving it, per mile" value={perMile(t.operatingPerMile)} sub="fuel, maintenance, repairs, care" />
              <StatCell proof={ctx.dp("cash-out-the-door")} label="Cash out the door" value={usd0(t.cashOutTheDoor)} sub="purchase, interest and every cost paid" />
              <StatCell proof={ctx.dp("prepaid")} label="Prepaid, not yet used" value={usd0(r.prepaidCents)} sub="the rest of premiums and annual bills" />
            </StatGrid>
          </Card>
        </div>
      </div>

      <Card title="Cost by month" subtitle="Accrued: a 6-month premium counts a sixth a month; depreciation follows the miles driven (or the market). The line is miles driven.">
        <div className="h-72">
          <RechartsResponsive>
            <ComposedChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={16} />
              <YAxis yAxisId="usd" {...ui.yAxis} tickFormatter={(v: number) => axisUsd(v / 100)} />
              <YAxis yAxisId="mi" orientation="right" {...ui.yAxis} width={44} tickFormatter={(v: number) => `${Math.round(v)}`} />
              <Tooltip
                {...ui.tooltip}
                formatter={(v, n) => (n === "Miles" ? [`${miles(Number(v))} mi`, n] : [usd0(Number(v)), String(n)])}
              />
              <Legend {...ui.legend} />
              {BUCKETS.map((b) => (
                <Bar key={b.id} yAxisId="usd" dataKey={b.id} name={b.label} stackId="c" fill={bucketColor(chart, b.id)} maxBarSize={28} isAnimationActive={false} />
              ))}
              <Line yAxisId="mi" type="monotone" dataKey="miles" name="Miles" stroke={chart.lineBalance} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </RechartsResponsive>
        </div>
      </Card>

      <Card title="All-in cost per mile, so far" subtitle="Everything spent and lost to depreciation so far, divided by miles so far. Fixed costs make early miles expensive; it settles as miles add up.">
        <div className="h-56">
          <RechartsResponsive>
            <ComposedChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={16} />
              <YAxis {...ui.yAxis} tickFormatter={(v: number) => `$${v.toFixed(2)}`} domain={[0, "auto"]} />
              <Tooltip {...ui.tooltip} formatter={(v) => [`$${Number(v).toFixed(2)} a mile`, "All-in, cumulative"]} />
              <Line type="monotone" dataKey="perMile" name="All-in per mile" stroke={chart.series[0]} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </RechartsResponsive>
        </div>
      </Card>
    </>
  );
}

function TripCost({ ctx }: { ctx: CarCtx }) {
  const { report: r } = ctx;
  // Each is a proven rate times the miles you typed (a composite that names your number).
  const times = (proof: ProofRef, rate: number | null, cents: number) => (rate == null ? usd0(cents) : <ProofValue proof={compositeOf("times", [proof], { ratio: cents }, undefined, m)} drawn={{ per: 100 }}>{usd0(cents)}</ProofValue>);
  const [trip, setTrip] = useState<number | null>(100);
  const m = trip ?? 0;
  const fuel = (r.fuel.fuelPerMile ?? 0) * m;
  const running = (r.totals.operatingPerMile ?? 0) * m;
  const wear = (r.depreciation.plannedPerMile ?? 0) * m;
  return (
    <Card title="What a trip costs" subtitle="Round-trip miles. Only what the miles add — the fixed costs are paid either way.">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-fg-2">Miles</span>
          <NumInput value={trip} onChange={setTrip} className="w-28" suffix="mi" ariaLabel="Trip miles" />
        </label>
        <div className="grid flex-1 grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-muted">Fuel</div>
            <div className="num text-lg font-semibold text-fg">{times(ctx.dp("fuel-per-mile"), r.fuel.fuelPerMile, fuel)}</div>
          </div>
          <div>
            <div className="text-muted">+ upkeep</div>
            <div className="num text-lg font-semibold text-fg">{times(ctx.dp("operating-per-mile"), r.totals.operatingPerMile, running)}</div>
          </div>
          <div>
            <div className="text-muted">+ wear</div>
            <div className="num text-lg font-semibold text-accent">
              {r.totals.operatingPerMile != null && r.depreciation.plannedPerMile != null ? (
                <ProofValue
                  proof={compositeOf("sum", [compositeOf("times", [ctx.dp("operating-per-mile")], { ratio: running }, undefined, m), compositeOf("times", [ctx.dp("planned-per-mile")], { ratio: wear }, undefined, m)], { ratio: running + wear })}
                  drawn={{ per: 100 }}
                >
                  {usd0(running + wear)}
                </ProofValue>
              ) : (
                usd0(running + wear)
              )}
            </div>
          </div>
        </div>
      </div>
      {r.totals.perMile != null && (
        <p className="mt-2 text-xs text-muted">
          At the all-in rate (<ProofValue proof={carProof(r.carId, { span: "toDate", per: "mile" }, null)}>{perMile(r.totals.perMile)}</ProofValue>/mi, fixed costs included) it would be{" "}
          <ProofValue proof={compositeOf("times", [carProof(r.carId, { span: "toDate", per: "mile" }, null)], { cents: r.totals.perMile * m }, undefined, m)}>{usd0(r.totals.perMile * m)}</ProofValue>.
        </p>
      )}
    </Card>
  );
}

function Alerts({ ctx }: { ctx: CarCtx }) {
  const { report: r, garage, car, goTo } = ctx;
  const items: { tone: Tone; label: string; text: ReactNode; onClick: () => void }[] = [];
  const due = r.sold ? null : serviceDue(r, car.plan.serviceEveryMonths);
  if (due) items.push({ tone: due.tone, label: r.service.overdue ? "Service overdue" : "Next service", text: due.headline.replace(/^(Next service|Service overdue):?\s*/, ""), onClick: () => goTo("service") });
  if (r.insurance.renewsOn) {
    items.push({
      tone: r.insurance.renewsOn <= r.today ? "warn" : "neutral",
      label: "Insurance renews",
      text: (
        <>
          {fmtDate(r.insurance.renewsOn)} ({relative(r.insurance.renewsOn, r.today)}) — last premium <ProofValue proof={ctx.dp("insurance-expected")}>{usd0(r.insurance.expectedCents)}</ProofValue>, <ProofValue proof={ctx.dp("insurance-monthly")}>{usd0(r.insurance.monthlyCents)}</ProofValue>/mo
        </>
      ),
      onClick: () => goTo("costs"),
    });
  }
  const w = r.warranty;
  if (w.endsOn && !r.sold) {
    items.push({
      tone: w.daysLeft != null && w.daysLeft < 180 ? "warn" : "neutral",
      label: "Warranty",
      text: `ends by ${w.endsBy === "MILES" ? "mileage" : "time"} ${fmtDate(w.endsOn)}${w.milesLeft != null ? ` · ${miles(w.milesLeft)} mi left` : ""}${w.endsBy === "TIME" && w.odometerAtExpiry != null ? ` · you'll be near ${miles(w.odometerAtExpiry)} mi` : ""}`,
      onClick: () => goTo("service"),
    });
  }
  const st = garage.statements;
  const a = st.audit;
  if (a.notFound)
    items.push({
      tone: "warn",
      label: "Not on statements",
      text: (
        <>
          {a.notFound} log entr{a.notFound === 1 ? "y has" : "ies have"} no statement charge (<NotFigure why="your log entry">{usd0(a.notFoundCents)}</NotFigure>) and count nothing — find each one&apos;s charge or mark it paid outside your statements
        </>
      ),
      onClick: () => goTo("statements"),
    });
  if (a.toCheck) items.push({ tone: "accent", label: "Matches to check", text: `${a.toCheck} log entr${a.toCheck === 1 ? "y was" : "ies were"} matched to a charge that's worth a look (a different amount, a split, a few days off)`, onClick: () => goTo("statements") });
  if (st.suggested) items.push({ tone: "accent", label: "From statements", text: `${st.suggested} possible car charge${st.suggested === 1 ? "" : "s"} to confirm`, onClick: () => goTo("statements") });
  if (st.guessed) items.push({ tone: "accent", label: "Which car?", text: `${st.guessed} statement charge${st.guessed === 1 ? "" : "s"} from when you had more than one car went to the usual car — check them`, onClick: () => goTo("statements") });
  if (r.odometer.asOf && !r.sold && daysSince(r.odometer.asOf, r.today) > 45) {
    items.push({ tone: "neutral", label: "Odometer", text: `last reading ${fmtDate(r.odometer.asOf)} (${relative(r.odometer.asOf, r.today)}) — log one to keep miles and service current`, onClick: () => ctx.logNew("ODOMETER") });
  }
  if (r.fuel.withoutDetail) {
    items.push({ tone: "neutral", label: "Fuel", text: `${r.fuel.withoutDetail} fill-up${r.fuel.withoutDetail === 1 ? "" : "s"} without gallons or odometer (counted in cost, not MPG)`, onClick: () => goTo("log") });
  }
  if (!items.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((i) => (
        <button key={i.label} type="button" onClick={i.onClick} className="flex min-w-0 items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-xs shadow-[var(--shadow)] hover:bg-surface-2">
          <Badge tone={i.tone}>{i.label}</Badge>
          <span className="min-w-0 text-fg-2">{i.text}</span>
        </button>
      ))}
    </div>
  );
}

const daysSince = (iso: string, today: string) => (Date.parse(today) - Date.parse(iso)) / 86_400_000;

/** Every car side by side, with what the household's cars cost together. Only with more than one car. */
function Garage({ ctx }: { ctx: CarCtx }) {
  const { garage: g, car, selectCar } = ctx;
  if (g.cars.length < 2) return null;
  const { tcoCents, last12Cents: last12, next12Cents: nextYear } = g.together;
  // The household's totals: each car's own figures added up.
  const live = g.cars.filter((c) => c.configured);
  const tcoRef = sumOf(live.map((c) => carProof(c.carId, { span: "toDate" }, c.totals.tco)), tcoCents);
  const last12Ref = sumOf(live.map((c) => carProof(c.carId, { span: "last12" }, c.last12.total)), last12);
  const nextRef = sumOf(live.filter((c) => !c.sold).map((c) => ctx.dp("outlook", outlookKey(c.carId, "total"))), nextYear);
  return (
    <Card
      title="Your cars"
      subtitle={
        <>
          Together about <ProofValue proof={compositeOf("times", [nextRef], { cents: nextYear / 12 }, undefined, 1 / 12)}>{usd0(nextYear / 12)}</ProofValue> a month over the next 12 months (<ProofValue proof={nextRef}>{usd0(nextYear)}</ProofValue> a year, depreciation included). Shared costs are split between the cars owned at the time. Pick a car to see it below.
        </>
      }
    >
      <div className={table.wrap}>
        <table className={table.table} style={{ minWidth: "46rem" }}>
          <thead>
            <tr className={table.head}>
              <th className={table.th}>Car</th>
              <th className={table.thR}>Owned</th>
              <th className={table.thR}>Miles a year</th>
              <th className={table.thR}>Cost to date</th>
              <th className={table.thR}>Per mile</th>
              <th className={table.thR}>Last 12 mo</th>
              <th className={table.thR}>Next 12 mo</th>
            </tr>
          </thead>
          <tbody>
            {g.cars.map((c) => (
              <tr key={c.carId} className={`${table.trHover} cursor-pointer ${c.carId === car.id ? "bg-accent-soft" : ""}`} onClick={() => selectCar(c.carId)}>
                <td className={table.td}>
                  <span className="font-medium text-fg">{c.name}</span> {c.sold && <Badge tone="neutral">sold</Badge>}
                </td>
                <td className={`${table.tdR} text-muted`}>{c.configured ? `${miles(c.odometer.daysOwned / 30.44, 0)} mo` : "—"}</td>
                <td className={table.tdR}>{c.odometer.perYear ? miles(c.odometer.perYear) : "—"}</td>
                <td className={table.tdR}>{c.configured ? <ProofValue proof={carProof(c.carId, { span: "toDate" }, c.totals.tco)}>{usd0(c.totals.tco)}</ProofValue> : "—"}</td>
                <td className={table.tdR}>{c.configured && c.totals.perMile != null ? <ProofValue proof={carProof(c.carId, { span: "toDate", per: "mile" }, null)}>{perMile(c.totals.perMile)}</ProofValue> : "—"}</td>
                <td className={table.tdR}>{c.configured ? <ProofValue proof={carProof(c.carId, { span: "last12" }, c.last12.total)}>{usd0(c.last12.total)}</ProofValue> : "—"}</td>
                <td className={table.tdR}>{c.sold || !c.configured ? "—" : <ProofValue proof={ctx.dp("outlook", outlookKey(c.carId, "total"))}>{usd0(c.outlook12.total)}</ProofValue>}</td>
              </tr>
            ))}
            <tr className="border-t-[3px] border-double border-line-strong font-semibold">
              <td className={table.td}>All cars</td>
              <td className={table.tdR} />
              <td className={table.tdR} />
              <td className={table.tdR}>
                <ProofValue proof={tcoRef}>{usd0(tcoCents)}</ProofValue>
              </td>
              <td className={table.tdR} />
              <td className={table.tdR}>
                <ProofValue proof={last12Ref}>{usd0(last12)}</ProofValue>
              </td>
              <td className={table.tdR}>
                <ProofValue proof={nextRef}>{usd0(nextYear)}</ProofValue>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The latest few things logged for this car, a click from changing them. */
function RecentLog({ ctx }: { ctx: CarCtx }) {
  const { garage: g, settings: s, car, editEntry, goTo } = ctx;
  const recent = [...g.log]
    .reverse()
    .filter((i) => (i.carId === car.id || i.carId === SHARED) && i.date <= g.today && i.source !== "RENT" && (i.counted || isReading(i)))
    .slice(0, 6);
  return (
    <Card
      title="Recent car costs"
      actions={
        <button type="button" className={btn.link} onClick={() => goTo("log")}>
          Whole log →
        </button>
      }
    >
      {recent.length === 0 ? (
        <p className="text-xs text-muted">Nothing yet. Use the buttons above to log a fill-up, a cost or an odometer reading.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {recent.map((i) => {
            const entry = i.entryIds.length ? s.entries.find((e) => e.id === i.entryIds[0]) : null;
            return (
              <li key={i.id}>
                <button type="button" className="flex w-full items-center gap-3 py-1.5 text-left text-xs hover:bg-surface-2" onClick={() => (entry ? editEntry(entry) : goTo("log"))}>
                  <span className="num w-24 shrink-0 text-muted">{fmtDate(i.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-fg" title={i.item}>
                    {i.label ?? i.item}
                    {i.label && <span className="ml-1 font-mono text-[11px] text-muted">{i.item}</span>}
                    {i.carId === SHARED && <span className="ml-1 text-muted">(shared)</span>}
                  </span>
                  <span className="num shrink-0 text-muted">{i.odometer != null ? `${miles(i.odometer)} mi` : ""}</span>
                  <span className="num w-20 shrink-0 text-right text-fg-2">{isReading(i) ? "" : <ProofValue proof={logProof(i.id, i.cents)}>{usd2(i.cents)}</ProofValue>}</span>
                  {i.source === "STATEMENT" && i.counted && <Badge tone="info">stmt</Badge>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
