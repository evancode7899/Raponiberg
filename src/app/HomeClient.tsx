"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { QualityBadge, ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { chartChrome, groupColor, useChartPalette } from "@/components/shell/chartPalette";
import { btn, Card, ErrorNote, Loading, PageBody, StatCell, StatGrid } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofTarget, ProofRef } from "@/components/ui/proof/context";
import type { ProofDescriptor } from "@/lib/book/proof";
import type { HomeSummary } from "@/lib/dashboard/homeSummary";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { axisUsd, formatPercentRatio, formatUsd, usd0, usdCompact, usdDelta } from "@/lib/formatMoney";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
import { unswept } from "@/lib/book/proof/clearance";

/** Every figure is null when it can't be proven; its blockers say why. Each figure shown carries its proof's descriptor. */
type Summary = HomeSummary;
type Change = Summary["netWorth"]["change"]["month"];

/** A figure's proof, as the page shows it (cents before any per-month split). */
const proofOf = (descriptor: ProofDescriptor | null | undefined, shownCents: number | null | undefined): ProofRef =>
  descriptor && shownCents != null ? { descriptor, shownCents } : unswept("Home has no recipe for this figure");

const date = (iso: string | null | undefined) => (iso ? formatDisplayDateFromYmd(iso) : "—");
const deltaTone = (c: number | null) => (c == null || c === 0 ? "text-muted" : c > 0 ? "text-pos" : "text-neg");

export function HomeClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [data, setData] = useState(() => cachedResponse<Summary>("/api/dashboard/home-summary"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<Summary>("/api/dashboard/home-summary")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  return (
    <PageBody>
      <div className="flex flex-wrap items-end justify-between gap-2 pt-1">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          {data?.hasStatements && (
            <p className="text-[13px] text-muted">
              Balances proven through {date(data.netWorth.asOf)} · bank &amp; card activity through {date(data.cashFlow.through)}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Link href="/statements" className={btn.secondary}>
            Import statements
          </Link>
          <Link href="/transactions" className={btn.secondary}>
            Search transactions
          </Link>
        </div>
      </div>
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        api.ready && !error ? <Loading label="Reading the ledger…" /> : null
      ) : !data.hasStatements ? (
        <Card title="Welcome">
          <p className="text-sm text-muted">No statements on file yet.</p>
          <Link href="/statements" className={`${btn.primary} mt-3`}>
            Import your first statements
          </Link>
        </Card>
      ) : (
        <Dashboard d={data} />
      )}
    </PageBody>
  );
}

function Dashboard({ d }: { d: Summary }) {
  const nw = d.netWorth;
  const cf = d.cashFlow;
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-3">
        <NetWorthHero nw={nw} />
        <Composition nw={nw} />
      </div>

      <StatGrid cols={5}>
        <StatCell label="Income · 12 mo" proof={proofOf(cf.last12?.proofs.income, cf.last12?.incomeCents)} value={cf.last12 ? usdCompact(cf.last12.incomeCents) : <BlockedValue blockers={cf.blockers} />} sub={cf.last12 ? `${usdCompact(cf.last12.incomeCents / cf.last12.months)} a month` : undefined} />
        <StatCell label="Spending · 12 mo" proof={proofOf(cf.last12?.proofs.spending, cf.last12?.spendingCents)} value={cf.last12 ? usdCompact(cf.last12.spendingCents) : <BlockedValue blockers={cf.blockers} />} sub={cf.last12 ? `${usdCompact(cf.last12.spendingCents / cf.last12.months)} a month` : undefined} />
        <StatCell
          label="Saved from take-home"
          proof={proofOf(cf.last12?.proofs.net, cf.last12?.netCents)}
          value={cf.last12 ? usdCompact(cf.last12.netCents) : <BlockedValue blockers={cf.blockers} />}
          tone={cf.last12 ? (cf.last12.netCents >= 0 ? "pos" : "neg") : undefined}
          sub={cf.last12?.savingsRate == null ? undefined : `${formatPercentRatio(cf.last12.savingsRate, 0)} savings rate`}
        />
        <StatCell
          label="From saving · 12 mo"
          proof={proofOf(nw.drivers?.proofs.principal, nw.drivers?.principalCents)}
          value={nw.drivers ? usdDelta(nw.drivers.principalCents) : <BlockedValue blockers={nw.driversBlockers} />}
          sub="income − spending + retirement contributions"
        />
        <StatCell label="From markets · 12 mo" proof={proofOf(nw.drivers?.proofs.growth, nw.drivers?.growthCents)} value={nw.drivers ? usdDelta(nw.drivers.growthCents) : <BlockedValue blockers={nw.driversBlockers} />} sub="investment growth, net of fees" />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <CashFlowChart cf={cf} />
        </div>
        <Attention d={d} />
      </div>

      <SpendingVsAverage cf={cf} />

      <figure className="mx-auto max-w-2xl py-4 text-center">
        <blockquote className="text-sm font-medium italic text-fg-2">“{d.encouragement.headline}”</blockquote>
        <figcaption className="mt-1 text-xs text-muted">{d.encouragement.body}</figcaption>
      </figure>
    </>
  );
}

function NetWorthHero({ nw }: { nw: Summary["netWorth"] }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const rows = nw.series.map((p) => ({ label: p.label, value: p.cents == null ? null : p.cents / 100, quality: p.quality }));
  const chips: [string, Change][] = [
    ["1 month", nw.change.month],
    [nw.change.ytdYear ? `${nw.change.ytdYear} YTD` : "YTD", nw.change.ytd],
    ["12 months", nw.change.year],
  ];
  return (
    <Card className="xl:col-span-2" bodyClassName="!pt-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Net worth</div>
          <div className="num mt-1 text-4xl font-semibold tracking-tight">{nw.totalCents == null ? <BlockedValue blockers={nw.blockers} className="!text-base" /> : <ProofValue proof={proofOf(nw.proofs?.total, nw.totalCents)}>{usd0(nw.totalCents)}</ProofValue>}</div>
          <div className="mt-1 text-xs text-muted">
            as of {date(nw.asOf)}
            {nw.totalCents != null && <QualityBadge quality={nw.quality} asOf={nw.asOf} />}
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {chips.map(([label, c]) => (
            <div key={label}>
              <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
              <dd className={`num text-base font-semibold ${deltaTone(c.cents)}`}>{c.cents == null ? <BlockedValue blockers={c.blockers} /> : <ProofValue proof={proofOf(c.proof, c.cents)}>{usdDelta(c.cents)}</ProofValue>}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="mt-4 h-[220px] w-full min-w-0">
        <RechartsResponsive>
          <AreaChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chart.series[0]} stopOpacity={0.28} />
                <stop offset="100%" stopColor={chart.series[0]} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="label" {...ui.xAxis} minTickGap={36} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} domain={["auto", "auto"]} />
            <Tooltip {...ui.tooltip} formatter={(v) => [formatUsd(Math.round(Number(v))), "Net worth"]} />
            <Area type="monotone" dataKey="value" stroke={chart.series[0]} strokeWidth={2} fill="url(#nwFill)" isAnimationActive={false} activeDot={{ r: 4 }} />
          </AreaChart>
        </RechartsResponsive>
      </div>
      <div className="mt-2 flex justify-between text-xs">
        <span className="text-muted">Month-end net worth, last {rows.length} months (gaps can&apos;t be proven yet)</span>
        <Link href="/net-worth" className={btn.link}>
          Net worth details →
        </Link>
      </div>
    </Card>
  );
}

function Composition({ nw }: { nw: Summary["netWorth"] }) {
  const chart = useChartPalette();
  if (nw.totalCents == null)
    return (
      <Card title="What it's made of">
        <BlockedNote what="today's balances" blockers={nw.blockers} limit={4} />
      </Card>
    );
  const assets = nw.groups.filter((g) => g.cents > 0);
  const debts = nw.groups.filter((g) => g.cents < 0);
  const total = assets.reduce((s, g) => s + g.cents, 0) || 1;
  const color = (g: string) => groupColor(chart, g);
  return (
    <Card title="What it's made of" subtitle={
        <>
          Liquid <ProofValue proof={proofOf(nw.proofs?.liquid, nw.liquidCents)}>{usd0(nw.liquidCents)}</ProofValue> · assets{" "}
          <ProofValue proof={proofOf(nw.proofs?.assets, nw.assetsCents)}>{usd0(nw.assetsCents)}</ProofValue> · debts{" "}
          <ProofValue proof={proofOf(nw.proofs?.debts, nw.debtsCents)}>{usd0(nw.debtsCents)}</ProofValue>
        </>
      }>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {assets.map((g) => (
          <div key={g.group} style={{ width: `${(g.cents / total) * 100}%`, background: color(g.group) }} />
        ))}
      </div>
      <ul className="mt-4 flex flex-col gap-2">
        {assets.map((g) => (
          <li key={g.group} className="flex items-center gap-2 text-[13px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color(g.group) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-fg-2">{g.group}</span>
            <span className="num text-muted">{formatPercentRatio(g.cents / total, 0)}</span>
            <span className="num w-24 text-right font-medium">
              <ProofValue proof={proofOf(g.proof, g.cents)}>{usd0(g.cents)}</ProofValue>
            </span>
          </li>
        ))}
        {debts.map((g) => (
          <li key={g.group} className="flex items-center gap-2 border-t border-line pt-2 text-[13px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-neg" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-fg-2">{g.group}</span>
            <span className="num w-24 text-right font-medium text-neg">
              <ProofValue proof={proofOf(g.proof, g.cents)}>{usd0(g.cents)}</ProofValue>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CashFlowChart({ cf }: { cf: Summary["cashFlow"] }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const rows = cf.months.map((m) => ({
    label: `${m.label.replace(/ (\d{2})(\d{2})$/, " ’$2")}${m.blocked ? " ⚠" : ""}`,
    income: m.incomeCents == null ? null : m.incomeCents / 100,
    spending: m.spendingCents == null ? null : m.spendingCents / 100,
    net: m.netCents == null ? null : m.netCents / 100,
  }));
  return (
    <Card
      title="Cash flow, last 12 months"
      subtitle="Income and spending from bank and card statements. Transfers between your own accounts never count. ⚠ = can't be proven yet (no bars)."
      actions={
        <Link href="/cash-flow" className={btn.link}>
          Cash flow →
        </Link>
      }
    >
      <div className="h-[260px] w-full min-w-0">
        <RechartsResponsive>
          <ComposedChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="label" {...ui.xAxis} interval="preserveStartEnd" minTickGap={8} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip {...ui.tooltip} formatter={(v, n) => [formatUsd(Math.round(Number(v))), String(n)]} />
            <Legend {...ui.legend} />
            <Bar dataKey="income" name="Income" fill={chart.income} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            <Bar dataKey="spending" name="Spending" fill={chart.spending} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            <Line dataKey="net" name="Net" stroke={chart.lineBalance} strokeWidth={2} dot={{ r: 2.5 }} type="linear" isAnimationActive={false} />
          </ComposedChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

function Attention({ d }: { d: Summary }) {
  const i = d.integrity;
  const items: { key: string; tone: "warn" | "info" | "neg"; title: string; body?: string; href: string; cta: string }[] = [];
  if (i.failing > 0)
    items.push({ key: "fail", tone: "neg", title: `${i.failing} integrity check${i.failing === 1 ? "" : "s"} failing`, body: "Data that contradicts itself — fix these first.", href: "/statements?tab=issues", cta: "Fix" });
  // Missing and awaited statements are listed on the Statements tab only.
  if (i.toReview > 0)
    items.push({
      key: "exceptions",
      tone: "info",
      title: `${i.toReview} accepted exception${i.toReview === 1 ? "" : "s"} to review`,
      body: "Their finding no longer arises. They stay until you approve retiring them.",
      href: "/statements?tab=issues",
      cta: "Review",
    });
  if (d.attention.needsReview > 0)
    items.push({
      key: "review",
      tone: "info",
      title: `${d.attention.needsReview.toLocaleString()} transactions to categorize`,
      body: "The classifier wasn't sure. One answer per merchant teaches every past and future row.",
      href: "/review",
      cta: "Review",
    });
  return (
    <Card
      title="Needs your attention"
      subtitle={
        <>
          {i.checksPassing} of {i.checksTotal} checks fully passing{i.accepted ? ` · ${i.accepted} accepted exception${i.accepted === 1 ? "" : "s"}` : ""}
        </>
      }
    >
      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{i.missing + i.awaiting > 0 ? "Nothing needs you right now." : "Every check passes. All figures are proven."}</p>
      ) : (
        <ul className="-mx-1 flex flex-col">
          {items.map((x) => (
            <li key={x.key}>
              <Link href={x.href} className="group flex items-start gap-3 rounded-md px-1 py-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${x.tone === "warn" ? "bg-warn" : x.tone === "neg" ? "bg-neg" : "bg-info"}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{x.title}</span>
                  {x.body && <span className="block text-xs leading-snug text-muted">{x.body}</span>}
                </span>
                <span className="shrink-0 pt-0.5 text-xs font-medium text-accent group-hover:underline">{x.cta} →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SpendingVsAverage({ cf }: { cf: Summary["cashFlow"] }) {
  const chart = useChartPalette();
  const lm = cf.lastMonth;
  const max = useMemo(() => Math.max(1, ...cf.categories.flatMap((c) => [c.lastMonthCents, c.avgCents])), [cf]);
  if (!lm || !cf.last12 || cf.categories.length === 0) return null;
  // The twelve months' spending ÷ its months, as the Spending tile works it out (its proof is that total).
  const avgTotal = Math.round(cf.last12.spendingCents / cf.last12.months);
  const avgProof: ProofTarget = { descriptor: cf.last12.proofs.spending, shownCents: cf.last12.spendingCents, perMonths: cf.last12.months };
  const diff = lm.spendingCents - avgTotal;
  return (
    <Card
      title={`Spending in ${lm.label} vs your 12-month average`}
      subtitle={
        <>
          <ProofValue proof={proofOf(lm.proof, lm.spendingCents)}>{usd0(lm.spendingCents)}</ProofValue> spent, {diff >= 0 ? "above" : "below"} the <ProofValue proof={avgProof}>{usd0(avgTotal)}</ProofValue> monthly average by{" "}
          <span className={diff > 0 ? "text-neg" : "text-pos"}>{usd0(Math.abs(diff))}</span>. Click a category for its transactions.
        </>
      }
      actions={
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm" style={{ background: chart.spending }} /> {lm.label}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-3 w-0.5 bg-fg" /> 12-mo average
          </span>
        </div>
      }
    >
      <ul className="grid gap-x-8 gap-y-1 md:grid-cols-2">
        {cf.categories.map((c) => {
          const over = c.lastMonthCents - c.avgCents;
          return (
            <li
              key={c.category}
              className="group grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 rounded px-1 text-[13px] focus-within:ring-2 focus-within:ring-focus hover:bg-surface-2"
            >
              {/* The row opens the month's transactions; its amount opens the amount's proof. */}
              <Link
                href={`/transactions?category=${encodeURIComponent(c.category)}&from=${lm.start}&to=${lm.end}`}
                className="grid grid-cols-[minmax(0,11.5rem)_1fr] items-center gap-3 py-1.5 outline-none"
              >
                <span className="truncate text-fg-2 group-hover:text-fg">{c.category}</span>
                <span className="relative h-2.5 rounded-sm bg-surface-3">
                  <span className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${(c.lastMonthCents / max) * 100}%`, background: chart.spending }} />
                  <span className="absolute -inset-y-1 w-0.5 bg-fg" style={{ left: `${(c.avgCents / max) * 100}%` }} title={`Average ${usd0(c.avgCents)}`} />
                </span>
              </Link>
              <span className="num text-right font-medium">
                <ProofValue proof={proofOf(c.proof, c.lastMonthCents)}>{usd0(c.lastMonthCents)}</ProofValue>
              </span>
              <span className={`num text-right text-xs ${Math.abs(over) < 2500 ? "text-muted" : over > 0 ? "text-neg" : "text-pos"}`}>
                {Math.abs(over) < 100 ? "—" : usdDelta(over)}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
