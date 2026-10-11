"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { QualityBadge, QualityLegend, ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { chartChrome, groupColor, groupRank, useChartPalette } from "@/components/shell/chartPalette";
import { btn, Card, EmptyState, ErrorNote, Loading, PageBody, Segmented, StatCell, StatGrid, table, Tabs, useTabParam } from "@/components/ui/kit";
import { axisUsd, formatPercentRatio, formatUsd, usd0, usdDelta } from "@/lib/formatMoney";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import type { NetWorthPeriodWithBlockers as NetWorthPeriod, NetWorthReport } from "@/lib/book/reports/netWorth";
import type { RollforwardReport } from "@/lib/profile/rollforwards";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { AccountsTab } from "./AccountsTab";
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

const TABS = ["overview", "built", "returns", "accounts"] as const;
type Granularity = "month" | "quarter" | "year";

export function NetWorthClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [granularity, setGranularity] = useState<Granularity>("quarter");
  const [monthly, setMonthly] = useState(() => cachedResponse<NetWorthReport>("/api/dashboard/net-worth?granularity=month"));
  const [report, setReport] = useState<NetWorthReport | null>(null);
  const [rolls, setRolls] = useState(() => cachedResponse<RollforwardReport>("/api/dashboard/net-worth/accounts"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<NetWorthReport>("/api/dashboard/net-worth?granularity=month")
      .then(setMonthly)
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    if (!api.ready || tab !== "built") return;
    if (granularity === "month" && monthly) return; // already here: `built` below uses it
    api
      .call<NetWorthReport>(`/api/dashboard/net-worth?granularity=${granularity}`)
      .then(setReport)
      .catch((e: Error) => setError(e.message));
  }, [api, granularity, tab, monthly]);
  useEffect(() => {
    if (!api.ready || tab !== "accounts" || rolls) return;
    api
      .call<RollforwardReport>("/api/dashboard/net-worth/accounts")
      .then(setRolls)
      .catch((e: Error) => setError(e.message));
  }, [api, tab, rolls]);
  // The monthly view is the report already loaded for the overview; other views are fetched.
  const built = granularity === "month" && monthly ? monthly : report;

  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "built", label: "How it was built" },
          { id: "returns", label: "Investment returns" },
          { id: "accounts", label: "Account roll-forwards" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!monthly ? (
          api.ready && !error && <Loading label="Valuing every account on the same month-ends…" />
        ) : monthly.periods.length === 0 ? (
          <EmptyState
            title="No committed statements yet"
            action={
              <Link href="/statements" className={btn.primary}>
                Import statements
              </Link>
            }
          />
        ) : tab === "overview" ? (
          <Overview r={monthly} />
        ) : tab === "built" ? (
          <Built r={built?.granularity === granularity ? built : null} granularity={granularity} setGranularity={setGranularity} />
        ) : tab === "returns" ? (
          <Returns r={monthly} />
        ) : rolls ? (
          <AccountsTab r={rolls} />
        ) : (
          !error && <Loading label="Rolling every investment account forward, year by year…" />
        )}
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------

const uniq = (bs: BlockerRef[]) => [...new Map(bs.map((b) => [b.id, b])).values()];
/** Blockers touching one account (or the whole household). */
const forAccount = (bs: BlockerRef[], id: string) => bs.filter((b) => !b.accountId || b.accountId === id);
const shown = (v: string, bs: BlockerRef[]) => (bs.length ? <BlockedValue blockers={bs} /> : v);

function trailing(r: NetWorthReport, months: number) {
  const ps = r.periods.slice(-months);
  const blockers = uniq(ps.flatMap((p) => p.blockers));
  const sum = (f: (p: NetWorthPeriod) => number) => ps.reduce((s, p) => s + f(p), 0);
  return {
    change: (ps.at(-1)?.household.closingCents ?? 0) - (ps[0]?.household.openingCents ?? 0),
    principal: sum((p) => p.household.principalCents + p.household.newlyTrackedCents),
    growth: sum((p) => p.household.growthNetOfFeesCents),
    transit: sum((p) => p.household.transferResidualCents + p.household.unexplainedCents),
    blockers,
  };
}

function Overview({ r }: { r: NetWorthReport }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const [span, setSpan] = useState<"24" | "all">("all");
  const groups = useMemo(() => [...new Set(r.periods.flatMap((p) => p.byGroup.map((g) => g.group)))].sort((a, b) => groupRank(a) - groupRank(b)), [r]);
  const periods = span === "all" ? r.periods : r.periods.slice(-24);
  // A month-end that can't be proven is left out of the chart (a gap), not drawn.
  const rows = periods.map((p) => {
    const row: Record<string, number | string | null> = { label: p.label, total: null };
    if (p.blockers.length) return row;
    row.total = p.household.closingCents / 100;
    for (const g of p.byGroup) row[g.group] = g.closingCents / 100;
    return row;
  });
  const cur = r.current.blockers;
  const flagged = periods.filter((p) => p.household.quality === "INTERPOLATED" || p.household.quality === "STALE");
  const minY = Math.min(0, ...periods.map((p) => p.byGroup.filter((g) => g.closingCents < 0).reduce((s, g) => s + g.closingCents, 0) / 100));
  const yFloor = minY < 0 ? Math.floor((minY * 1.5) / 10_000) * 10_000 : 0;
  const assets = r.accounts.reduce((s, a) => s + Math.max(0, a.currentCents), 0);
  const debts = r.accounts.reduce((s, a) => s + Math.min(0, a.currentCents), 0);
  const t12 = trailing(r, 12);
  const mergeLabel = periods.find((p) => p.start <= r.mergeDate && r.mergeDate <= p.end)?.label;
  const byGroup = useMemo(() => {
    const m = new Map<(typeof groups)[number], NetWorthReport["accounts"]>();
    for (const a of [...r.accounts].sort((x, y) => Number(x.closed) - Number(y.closed) || y.currentCents - x.currentCents)) {
      m.set(a.group, [...(m.get(a.group) ?? []), a]);
    }
    return [...m].sort((a, b) => groups.indexOf(a[0]) - groups.indexOf(b[0]));
  }, [r, groups]);

  return (
    <>
      <BlockedNote what={`net worth as of ${r.current.asOf}`} blockers={cur} />
      <StatGrid cols={6}>
        <StatCell
          label="Net worth"
          value={shown(usd0(r.current.totalCents), cur)}
          sub={
            <>
              as of {r.current.asOf}
              <QualityBadge quality={r.current.quality} />
            </>
          }
        />
        <StatCell label="Assets" value={shown(usd0(assets), cur)} />
        <StatCell label="Debts" value={shown(usd0(debts), cur)} tone={!cur.length && debts < 0 ? "neg" : "neutral"} />
        <StatCell
          label="Last 12 months"
          value={shown(usdDelta(t12.change), t12.blockers)}
          tone={t12.blockers.length ? "neutral" : t12.change >= 0 ? "pos" : "neg"}
          sub={t12.blockers.length ? undefined : t12.transit ? `incl. ${usd0(t12.transit)} in transit` : "change"}
        />
        <StatCell label="…from saving" value={shown(usdDelta(t12.principal), t12.blockers)} sub="saved & contributed" />
        <StatCell label="…from markets" value={shown(usdDelta(t12.growth), t12.blockers)} sub="growth, net of fees" />
      </StatGrid>

      <Card
        title="Net worth by month-end"
        subtitle={`Stacked by account type, debts below zero. Every account is valued on the same calendar month-ends: exact for bank and card accounts, spread evenly inside investment statements. Proven through ${r.provenThrough}; month-ends that can't be proven are left blank (see Integrity).`}
        actions={
          <Segmented
            size="xs"
            options={[
              { value: "24", label: "24 months" },
              { value: "all", label: "All" },
            ]}
            value={span}
            onChange={setSpan}
          />
        }
      >
        <div className="h-[380px] w-full min-w-0">
          <RechartsResponsive>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} stackOffset="sign">
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={28} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} domain={[yFloor, "auto"]} allowDataOverflow />
              <Tooltip {...ui.tooltip} formatter={(v, name) => [formatUsd(Math.round(Number(v))), name === "total" ? "Net worth" : String(name)]} />
              <Legend {...ui.legend} formatter={(n) => (n === "total" ? "Net worth" : n)} />
              {flagged.map((p) => (
                <ReferenceArea key={p.start} x1={p.label} x2={p.label} fill={chart.neutral} fillOpacity={0.18} strokeOpacity={0} />
              ))}
              {mergeLabel && (
                <ReferenceLine x={mergeLabel} stroke={chart.axis} strokeDasharray="4 3" label={{ value: "Finances merged", fill: chart.legend, fontSize: 11, position: "insideTopLeft" }} />
              )}
              {groups.map((g) => (
                <Area key={g} type="monotone" dataKey={g} stackId="nw" stroke={groupColor(chart, g)} fill={groupColor(chart, g)} fillOpacity={0.55} strokeWidth={1} isAnimationActive={false} />
              ))}
              <Line type="monotone" dataKey="total" stroke={chart.lineBalance} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </RechartsResponsive>
        </div>
      </Card>

      <Card title="Accounts" subtitle={<QualityLegend />}>
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[40rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Account</th>
                <th className={table.th}>On file</th>
                <th className={table.thR}>Balance</th>
                <th className={table.thR}>Share</th>
              </tr>
            </thead>
            {byGroup.map(([g, list]) => {
              const sub = list.reduce((s, a) => s + a.currentCents, 0);
              const subBlockers = uniq(list.flatMap((a) => forAccount(cur, a.id)));
              return (
                <tbody key={g}>
                  <tr className="border-t border-line-strong bg-surface-2">
                    <td className={`${table.td} font-semibold`} colSpan={2}>
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: groupColor(chart, g) }} aria-hidden />
                      {g}
                    </td>
                    <td className={`${table.tdR} font-semibold ${sub < 0 ? "text-neg" : ""}`}>{shown(usd0(sub), subBlockers)}</td>
                    <td className={`${table.tdR} text-muted`}>{!cur.length && sub > 0 ? formatPercentRatio(sub / assets, 0) : ""}</td>
                  </tr>
                  {list.map((a) => (
                    <tr key={a.id} className={`${table.trHover} ${a.closed ? "opacity-55" : ""}`}>
                      <td className={`${table.td} pl-6`}>
                        {a.isInvestment ? (
                          a.name
                        ) : (
                          <Link href={`/transactions?accountId=${a.id}`} className="hover:text-accent hover:underline">
                            {a.name}
                          </Link>
                        )}
                      </td>
                      <td className={`${table.td} num whitespace-nowrap text-xs text-muted`}>
                        {a.firstDay} → {a.closed ? `${a.lastDay} (closed)` : a.lastDay}
                      </td>
                      <td className={table.tdR}>
                        {forAccount(cur, a.id).length ? (
                          <BlockedValue blockers={forAccount(cur, a.id)} />
                        ) : (
                          <>
                            {usd0(a.currentCents)}
                            <QualityBadge quality={a.currentQuality} asOf={a.currentAsOf} />
                          </>
                        )}
                      </td>
                      <td className={`${table.tdR} text-xs text-faint`}>{!cur.length && a.currentCents > 0 ? formatPercentRatio(a.currentCents / assets, 1) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

function Built({ r, granularity, setGranularity }: { r: NetWorthReport | null; granularity: Granularity; setGranularity: (g: Granularity) => void }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const names = useMemo(() => new Map(r?.accounts.map((a) => [a.id, a.name]) ?? []), [r]);
  const run = useMemo(() => (r?.proven.from ? r.periods.filter((p) => p.start >= r.proven.from!) : []), [r]);
  // Blockers on periods before the proven stretch withhold only that older history.
  const olderBlockers = useMemo(() => uniq(r?.periods.filter((p) => !run.includes(p)).flatMap((p) => p.blockers) ?? []), [r, run]);
  const cumulative = useMemo(() => {
    // Running totals carry every earlier period, so they start where the proven stretch
    // does, on top of the net worth already on hand then.
    const start = (run[0]?.household.openingCents ?? 0) / 100;
    const rows: { label: string; start: number; principal: number; growth: number }[] = [];
    let principal = 0;
    let growth = 0;
    for (const p of run) {
      const h = p.household;
      principal += h.principalCents + h.newlyTrackedCents + h.transferResidualCents + h.unexplainedCents;
      growth += h.growthNetOfFeesCents;
      rows.push({ label: p.label, start, principal: principal / 100, growth: growth / 100 });
    }
    return rows;
  }, [run]);

  const control = (
    <Segmented
      options={[
        { value: "month", label: "Month" },
        { value: "quarter", label: "Quarter" },
        { value: "year", label: "Year" },
      ]}
      value={granularity}
      onChange={setGranularity}
    />
  );
  if (!r) return <Loading />;
  const cols = ["Opening", "Income", "Spending", "Other money in/out", "401(k) via payroll", "Net principal", "Growth (net of fees)", "In transit", "Closing", "Return"];
  const last = cumulative.at(-1);
  const since = run[0]?.label;
  const seriesName = (n: unknown) => (n === "start" ? `On hand at start of ${since}` : n === "principal" ? "Saved since" : "Growth since");

  return (
    <>
      <Card
        title="Saved vs earned"
        subtitle={`Net worth already on hand${since ? ` at the start of ${since}` : ""}, plus cumulative principal since — everything saved or contributed: income minus spending, partner and untracked money, payroll and employer retirement contributions, plus balances already in accounts when they first appear — versus cumulative market growth after fees. Accumulated over the latest unbroken run of proven periods.`}
        actions={control}
      >
        <BlockedNote what={run.length ? `periods before ${since}, so totals accumulate from there` : "cumulative principal and growth"} blockers={olderBlockers} limit={3} />
        {last && (
          <div className="mb-3 flex flex-wrap gap-6 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: chart.neutral }} /> {seriesName("start")} <span className="num font-semibold text-fg">{formatUsd(Math.round(last.start))}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: chart.principal }} /> Saved since <span className="num font-semibold text-fg">{formatUsd(Math.round(last.principal))}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: chart.growth }} /> Growth since <span className="num font-semibold text-fg">{formatUsd(Math.round(last.growth))}</span>
            </span>
          </div>
        )}
        <div className="h-[300px] w-full min-w-0">
          <RechartsResponsive>
            <ComposedChart data={cumulative} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={24} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
              <Tooltip {...ui.tooltip} formatter={(v, n) => [formatUsd(Math.round(Number(v))), seriesName(n)]} />
              <Area type="monotone" dataKey="start" stackId="c" stroke={chart.neutral} fill={chart.neutral} fillOpacity={0.3} isAnimationActive={false} />
              <Area type="monotone" dataKey="principal" stackId="c" stroke={chart.principal} fill={chart.principal} fillOpacity={0.45} isAnimationActive={false} />
              <Area type="monotone" dataKey="growth" stackId="c" stroke={chart.growth} fill={chart.growth} fillOpacity={0.45} isAnimationActive={false} />
            </ComposedChart>
          </RechartsResponsive>
        </div>
      </Card>
      <Card
        title="Opening + net principal + growth = closing"
        subtitle={
          <>
            Each row ties exactly. Money moved between your own accounts nets to zero; what&apos;s left under “in transit” is money mid-move across a
            period boundary or a confirmed transfer cost. Periods that can&apos;t be proven say why. Click a row for each account.
            <div className="mt-1">
              <QualityLegend />
            </div>
          </>
        }
      >
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[64rem] text-xs`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Period</th>
                {cols.map((c) => (
                  <th key={c} className={table.thR}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...r.periods].reverse().map((p) => {
                const h = p.household;
                const isOpen = openRow === p.start;
                if (p.blockers.length)
                  return (
                    <tr key={p.start} className={table.tr}>
                      <td className={`${table.td} whitespace-nowrap font-medium`}>{p.label}</td>
                      <td className={table.tdR} colSpan={cols.length}>
                        <BlockedValue blockers={p.blockers} /> <span className="text-xs text-muted">— {p.blockers[0]!.title}{p.blockers.length > 1 ? ` (+${p.blockers.length - 1} more)` : ""}</span>
                      </td>
                    </tr>
                  );
                return (
                  <Fragment key={p.start}>
                    <tr className={`${table.trHover} cursor-pointer ${isOpen ? "bg-surface-2" : ""}`} onClick={() => setOpenRow(isOpen ? null : p.start)}>
                      <td className={`${table.td} whitespace-nowrap font-medium`}>
                        <span className="text-faint">{isOpen ? "▾" : "▸"}</span> {p.label}
                        <QualityBadge quality={h.quality} />
                      </td>
                      <td className={table.tdR}>{usd0(h.openingCents)}</td>
                      <td className={table.tdR}>{usd0(h.incomeCents)}</td>
                      <td className={table.tdR}>{usd0(h.spendingCents)}</td>
                      <td className={table.tdR} title={h.newlyTrackedCents ? `Includes ${usd0(h.newlyTrackedCents)} already in accounts first on file this period` : undefined}>
                        {usd0(h.externalCents + h.newlyTrackedCents)}
                      </td>
                      <td className={table.tdR} title={`Employee ${usd0(h.retirementEmployeeCents)} · employer ${usd0(h.retirementEmployerCents)}`}>
                        {usd0(h.retirementEmployeeCents + h.retirementEmployerCents)}
                      </td>
                      <td className={`${table.tdR} font-medium`}>{usd0(h.principalCents + h.newlyTrackedCents)}</td>
                      <td className={`${table.tdR} font-medium ${h.growthNetOfFeesCents < 0 ? "text-neg" : ""}`} title={`Fees ${usd0(h.feesCents)}`}>
                        {usd0(h.growthNetOfFeesCents)}
                      </td>
                      <td className={`${table.tdR} text-muted`}>{usd0(h.transferResidualCents + h.unexplainedCents)}</td>
                      <td className={`${table.tdR} font-semibold`}>{usd0(h.closingCents)}</td>
                      <td className={table.tdR}>{h.portfolioReturn == null ? "—" : formatPercentRatio(h.portfolioReturn, 1)}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={cols.length + 1} className="bg-surface-2 px-3 pb-3 pt-1">
                          <table className={`${table.table} rounded border border-line bg-surface text-xs`}>
                            <thead className={table.head}>
                              <tr>
                                <th className={table.th}>Account</th>
                                <th className={table.thR}>Opening</th>
                                <th className={table.thR}>Money in/out (incl. transfers)</th>
                                <th className={table.thR}>Growth (net of fees)</th>
                                <th className={table.thR}>Fees</th>
                                <th className={table.thR}>Unexplained</th>
                                <th className={table.thR}>Closing</th>
                                <th className={table.thR}>Return</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.byAccount.map((a) => (
                                <tr key={a.accountId} className={table.tr}>
                                  <td className={table.td}>
                                    {names.get(a.accountId)}
                                    <QualityBadge quality={a.quality} />
                                  </td>
                                  <td className={table.tdR}>
                                    {a.newlyTrackedCents ? <span title="Balance already in the account when its first statement on file begins">{usd0(a.newlyTrackedCents)} (first on file)</span> : usd0(a.openingCents)}
                                  </td>
                                  <td className={table.tdR}>{usd0(a.contributionsCents)}</td>
                                  <td className={table.tdR}>{usd0(a.growthNetOfFeesCents)}</td>
                                  <td className={`${table.tdR} text-muted`}>{usd0(a.feesCents)}</td>
                                  <td className={`${table.tdR} text-muted`}>{usd0(a.unexplainedCents)}</td>
                                  <td className={`${table.tdR} font-medium`}>{usd0(a.closingCents)}</td>
                                  <td className={table.tdR}>{a.returnRatio == null ? "—" : formatPercentRatio(a.returnRatio, 1)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

function Returns({ r }: { r: NetWorthReport }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const names = new Map(r.accounts.map((a) => [a.id, a]));
  const investmentIds = new Set(r.accounts.filter((a) => a.isInvestment).map((a) => a.id));
  // Only blockers on investment accounts (or the whole household) touch returns.
  const blockersOf = (x: NetWorthPeriod) => x.blockers.filter((b) => !b.accountId || investmentIds.has(b.accountId));
  // Chained returns compound every period, so they run over the latest unbroken proven stretch.
  const p = r.proven.returns.portfolio;
  const older = uniq(r.periods.filter((x) => !p || x.start < p.from).flatMap(blockersOf));
  const bars = r.periods.filter((x) => x.household.portfolioReturn != null && !blockersOf(x).length).map((x) => ({ label: x.label, r: x.household.portfolioReturn! * 100 }));
  const fromLabel = p && r.periods.find((x) => x.start === p.from)?.label;
  return (
    <>
      <BlockedNote what={p ? `returns before ${fromLabel}, so they're chained from there` : "chained returns"} blockers={older} limit={3} />
      <StatGrid cols={3}>
        <StatCell label={p ? `Since ${fromLabel}` : "Cumulative"} value={p ? formatPercentRatio(p.total, 1) : "—"} sub="cumulative, time-weighted" tone={p && p.total < 0 ? "neg" : "neutral"} />
        <StatCell label="Annualized" value={p?.annualized == null ? "—" : formatPercentRatio(p.annualized, 2)} sub="per year (shown after a full year)" />
        <StatCell label="Accounts measured" value={String(r.proven.returns.byAccount.length)} sub="brokerage, IRAs, 401(k)s, 529, HSA" />
      </StatGrid>
      <Card
        title="Monthly portfolio return"
        subtitle="Time-weighted: each month's Modified Dietz return (market change net of fees over average invested capital, so deposits and transfers don't count as performance), chained together. Months with under $1,000 invested are left out."
      >
        <div className="h-[260px] w-full min-w-0">
          <RechartsResponsive>
            <BarChart data={bars} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={24} />
              <YAxis {...ui.yAxis} width={44} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
              <Tooltip {...ui.tooltip} formatter={(v) => [`${Number(v).toFixed(2)}%`, "Portfolio return"]} />
              <ReferenceLine y={0} stroke={chart.axisLine} />
              <Bar dataKey="r" radius={[2, 2, 0, 0]} maxBarSize={18} isAnimationActive={false}>
                {bars.map((b, i) => (
                  <Cell key={i} fill={b.r >= 0 ? chart.series[0] : chart.debt} />
                ))}
              </Bar>
            </BarChart>
          </RechartsResponsive>
        </div>
      </Card>
      <Card
        title="By account"
        subtitle={
          <>
            Year-by-year roll-forwards for each account are on the{" "}
            <Link href="/net-worth?tab=accounts" className={btn.link}>
              Account roll-forwards
            </Link>{" "}
            tab.
          </>
        }
      >
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Account</th>
                <th className={table.th}>Measured</th>
                <th className={table.thR}>Cumulative</th>
                <th className={table.thR}>Annualized</th>
              </tr>
            </thead>
            <tbody>
              {[...r.proven.returns.byAccount]
                .sort((a, b) => (b.annualized ?? b.total) - (a.annualized ?? a.total))
                .map((x) => {
                  const a = names.get(x.accountId);
                  return (
                    <tr key={x.accountId} className={table.trHover}>
                      <td className={table.td}>{a?.name}</td>
                      <td className={`${table.td} num text-xs text-muted`} title={x.limited ? "Earlier periods for this account can't be proven (see Integrity)" : undefined}>
                        {x.from} → {a?.lastDay}
                        {x.limited && <span className="ml-1 text-warn">(earlier history unproven)</span>}
                      </td>
                      <td className={`${table.tdR} ${x.total < 0 ? "text-neg" : ""}`}>{formatPercentRatio(x.total, 1)}</td>
                      <td className={table.tdR}>{x.annualized == null ? "—" : formatPercentRatio(x.annualized, 2)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
