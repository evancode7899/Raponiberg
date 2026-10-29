"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Badge, Card, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { Reconciliation, RewardsPool } from "@/lib/cardPerks/types";
import { usd0 } from "@/lib/formatMoney";
import { Area, AreaChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { fmtCpp, fmtDate, fmtMonth, fmtRewards, SectionTitle, shortName, SourceTag } from "./parts";

const BASIS = {
  PRINTED: { label: "Printed", tone: "pos" as const, hint: "The statement prints what this cycle earned." },
  BALANCES: { label: "From balances", tone: "info" as const, hint: "What the printed balance rose by, plus any rewards cashed in on the statements." },
  INFERRED: { label: "Balance fell", tone: "warn" as const, hint: "Rewards left the balance (a transfer or redemption), so what was earned is the estimate and the rest is what left." },
};

export function RewardsTab({ r }: { r: CardPerksPage }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const pooled = new Set(r.pools.flatMap((p) => p.accountIds));
  const estimated = r.cards.filter((c) => c.program.kind !== "NONE" && !pooled.has(c.accountId));
  const noRewards = r.cards.filter((c) => c.program.kind === "NONE");

  const mixMax = Math.max(1, ...r.rewardsMix.map((x) => x.valueCents));

  return (
    <>
      {r.pools.map((p) => (
        <PoolCard key={p.key} p={p} r={r} ui={ui} color={chart.series[p.program.kind === "CASH" ? 2 : 0]!} />
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        {r.rewardsMix.length > 0 && (
          <Card title={`Where ${r.year}'s rewards came from`} subtitle="Expected rewards by what the spending was, valued in dollars at each program's point value.">
            <ul className="space-y-1.5">
              {r.rewardsMix.map(({ label, valueCents: v }) => (
                <li key={label} className="grid grid-cols-[minmax(0,10rem)_1fr_4.5rem] items-center gap-2 text-xs">
                  <span className="truncate text-fg-2" title={label}>
                    {label}
                  </span>
                  <span className="h-2 overflow-hidden rounded-full bg-surface-3">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${(v / mixMax) * 100}%` }} />
                  </span>
                  <span className="num text-right font-medium">{usd0(v)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {(estimated.length > 0 || noRewards.length > 0) && (
          <Card title="Cards without a printed balance" subtitle="Their statements don't print a rewards balance for this year, so their rewards are what the spending earns at the card's rates.">
            <ul className="divide-y divide-line text-xs">
              {estimated.map((c) => (
                <li key={c.accountId} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-fg">{shortName(c)}</span>
                    <span className="block truncate text-[11px] text-muted">{c.program.statementNote}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="num block font-medium">{fmtRewards(c.rewards.kind, c.rewards.earned, true)}</span>
                    <SourceTag source={c.rewards.source} />
                  </span>
                </li>
              ))}
              {noRewards.map((c) => (
                <li key={c.accountId} className="flex items-center justify-between gap-3 py-2 text-muted">
                  <span>{shortName(c)}</span>
                  <span>No rewards</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

function PoolCard({ p, r, ui, color }: { p: RewardsPool; r: CardPerksPage; ui: ReturnType<typeof chartChrome>; color: string }) {
  const kind = p.program.kind;
  const names = p.accountIds.map((id) => r.cards.find((c) => c.accountId === id)).filter((c) => !!c);
  const stretches = p.stretches.filter((s) => s.to.startsWith(`${r.year}-`)).reverse();
  const last = p.balances.filter((b) => b.date <= `${r.year}-12-31`).at(-1);
  const { posted, expected, redeemed } = p.year;
  const valueOf = (n: number) => (kind === "CASH" ? n : n * p.centsPerPoint);
  const data = p.balances.map((b) => ({ date: b.date, label: fmtMonth(b.date), balance: kind === "CASH" ? b.balance / 100 : b.balance }));
  const fmtAxis = (v: number) => (kind === "CASH" ? `$${v}` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {p.program.name}
          <span className="text-xs font-normal text-muted">{names.length ? names.map((c) => shortName(c)).join(" + ") : "cards not shown this year"}</span>
        </span>
      }
      subtitle={p.program.statementNote}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted">Balance {last ? `on ${fmtDate(last.date)}` : ""}</dt>
              <dd className="num text-lg font-semibold">
                {last ? (
                  <ProofValue proof={{ descriptor: { report: "statement", statementId: last.statementId }, shownCents: null }}>{fmtRewards(kind, last.balance, kind !== "CASH")}</ProofValue>
                ) : (
                  "—"
                )}
              </dd>
              {last && kind === "POINTS" && (
                <dd className="text-[11px] text-muted">
                  ≈ {usd0(valueOf(last.balance))} at {fmtCpp(p.centsPerPoint)}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-muted">Posted in {r.year}</dt>
              <dd className="num text-lg font-semibold text-accent">{fmtRewards(kind, posted, kind !== "CASH")}</dd>
              <dd className="text-[11px] text-muted">
                expected {fmtRewards(kind, expected, kind !== "CASH")}
                {expected > 0 && ` · ${posted >= expected ? "+" : ""}${Math.round(((posted - expected) / expected) * 100)}%`}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Left the balance in {r.year}</dt>
              <dd className="num font-medium">{redeemed ? fmtRewards(kind, redeemed, kind !== "CASH") : "—"}</dd>
              <dd className="text-[11px] text-muted">transfers, redemptions, cash-outs</dd>
            </div>
            <div>
              <dt className="text-muted">Printed balances on file</dt>
              <dd className="num font-medium">{p.balances.length}</dd>
              <dd className="text-[11px] text-muted">
                {fmtMonth(p.balances[0]!.date)} – {fmtMonth(p.balances.at(-1)!.date)}
              </dd>
            </div>
          </dl>
          <div className="h-44 w-full min-w-0">
            <RechartsResponsive>
              <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid {...ui.grid} />
                <XAxis dataKey="label" {...ui.xAxis} minTickGap={24} />
                <YAxis {...ui.yAxis} tickFormatter={fmtAxis} width={44} />
                <Tooltip {...ui.tooltip} formatter={(v) => [kind === "CASH" ? `$${Number(v).toFixed(2)}` : Math.round(Number(v)).toLocaleString("en-US"), "Balance"]} />
                {data.some((x) => x.date.startsWith(`${r.year}-`)) && <ReferenceLine x={data.find((x) => x.date.startsWith(`${r.year}-`))!.label} stroke={ui.grid.stroke} strokeDasharray="3 3" />}
                <Area type="stepAfter" dataKey="balance" stroke={color} fill={color} fillOpacity={0.18} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </RechartsResponsive>
          </div>
        </div>

        <div className="min-w-0">
          <SectionTitle>Reconciliation, {r.year}</SectionTitle>
          {stretches.length ? (
            <div className={table.wrap}>
              <table className={table.table} style={{ minWidth: "34rem" }}>
                <thead>
                  <tr className={table.head}>
                    <th className={table.th}>Through</th>
                    <th className={table.thR}>Expected</th>
                    <th className={table.thR}>Posted</th>
                    <th className={table.thR}>Difference</th>
                    <th className={table.thR}>Left</th>
                    <th className={table.thR}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {stretches.map((s) => (
                    <StretchRow key={`${s.from}|${s.to}`} s={s} kind={kind} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-muted">No two printed balances fall in {r.year}.</p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Each row runs from one printed balance to the next. Expected is what the cycles that closed in between should have earned at the card&apos;s rates; posted is what the
            balance shows. A positive difference is a welcome offer, a referral or a bonus category the estimate can&apos;t see.
          </p>
        </div>
      </div>
    </Card>
  );
}

function StretchRow({ s, kind }: { s: Reconciliation; kind: "POINTS" | "CASH" | "NONE" }) {
  const b = BASIS[s.basis];
  const whole = kind !== "CASH";
  const big = Math.abs(s.difference) > Math.max(500, s.expected * 0.1);
  return (
    <tr className={table.tr}>
      <td className={table.td}>
        <div className="num">{fmtDate(s.to)}</div>
        <Badge tone={b.tone} title={b.hint}>
          {b.label}
        </Badge>
      </td>
      <td className={table.tdR}>{fmtRewards(kind, s.expected, whole)}</td>
      <td className={`${table.tdR} font-medium`}>{fmtRewards(kind, s.posted, whole)}</td>
      <td className={`${table.tdR} ${big ? (s.difference > 0 ? "text-pos" : "text-warn") : "text-muted"}`}>
        {s.difference === 0 ? "—" : `${s.difference > 0 ? "+" : "−"}${fmtRewards(kind, Math.abs(s.difference), whole)}`}
      </td>
      <td className={`${table.tdR} text-muted`}>{s.redeemed ? fmtRewards(kind, s.redeemed, whole) : "—"}</td>
      <td className={table.tdR}>
        <ProofValue proof={{ descriptor: { report: "statement", statementId: s.closingStatementId }, shownCents: null }}>{fmtRewards(kind, s.closing, whole)}</ProofValue>
      </td>
    </tr>
  );
}
