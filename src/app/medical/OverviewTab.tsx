"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";

import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, Card, NotFigure, StatCell, StatGrid, table } from "@/components/ui/kit";
import { BALANCE_LABEL, balanceKey, sliceKey, yearKey } from "@/lib/book/derived/medical";

import { axisUsd, formatPercentRatio } from "@/lib/formatMoney";
import { compositeOf } from "@/components/ui/proof/context";

import type { Slice, YearView } from "@/lib/medical/report";
import type { EobBalance } from "@/lib/medical/types";
import { Fragment } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";

import { COVERAGE_LABEL, money, shortDate, monthLabel, plural, SHORT_KIND, Fig, Amt } from "./parts";

// ---------------------------------------------------------------------------- overview

export function Meter({ used, limit, pace }: { used: number; limit: number; pace?: number | null }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="relative mt-2 h-1.5 w-full rounded-full bg-surface-3" aria-hidden>
      <div className={`h-full rounded-full ${share >= 1 ? "bg-pos" : "bg-accent"}`} style={{ width: `${share * 100}%` }} />
      {/* How much of the plan year had gone by the EOB the balances are from. */}
      {pace != null && <span className="absolute -top-1 h-3.5 w-px bg-fg" style={{ left: `${pace * 100}%` }} />}
    </div>
  );
}

/** How much of the balances' plan year had gone by the EOB they're from (0–1), by day. */
export function yearGone(b: NonNullable<YearView["balances"]>): number | null {
  const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  const span = day(b.to) - day(b.from);
  return span > 0 ? Math.min(1, Math.max(0, (day(b.asOf) - day(b.from)) / span)) : null;
}

export function BalanceCell({ y, row, fig, label }: { y: YearView; row: EobBalance; fig: Fig; label: string }) {
  const k = balanceKey(y, row);
  const met = row.usedCents >= row.limitCents;
  const done = row.kind === "ANNUAL_MAXIMUM" ? " · used up" : " · met";
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="num mt-1 text-xl font-semibold tracking-tight">
        <Amt fig={fig} figure="balance-used" k={k} cents={row.usedCents} />
      </div>
      <div className="mt-0.5 text-xs text-muted">
        of <Amt fig={fig} figure="balance-limit" k={k} cents={row.limitCents} />
        {met ? done : (
          <>
            {" · "}
            <Amt fig={fig} figure="balance-left" k={k} cents={row.remainingCents} /> left
          </>
        )}
      </div>
      <Meter used={row.usedCents} limit={row.limitCents} pace={y.balances && row.kind !== "ANNUAL_MAXIMUM" ? yearGone(y.balances) : null} />
      {y.balances && !met && row.limitCents > 0 && yearGone(y.balances) != null && (
        <div className="mt-1 text-[11px] text-muted">
          <ProofValue proof={compositeOf("share", [fig("balance-used", k), fig("balance-limit", k)], { ratio: row.usedCents / row.limitCents })}>{formatPercentRatio(row.usedCents / row.limitCents, 0)}</ProofValue> met,{" "}
          <NotFigure why="the share of the plan year gone by the EOB's date, a calendar fact">{`${Math.round(yearGone(y.balances)! * 100)}% of the plan year gone`}</NotFigure>
        </div>
      )}
    </div>
  );
}

export function Overview({ y, fig }: { y: YearView; fig: Fig }) {
  const k = yearKey(y);
  const T = y.totals;
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const inNet = y.balances?.rows.filter((r) => r.inNetwork) ?? [];
  const family = inNet.filter((r) => r.person == null);
  const people = [...new Set(inNet.filter((r) => r.person).map((r) => r.person!))];
  const outNetUsed = y.balances?.rows.some((r) => !r.inNetwork && r.usedCents > 0);
  return (
    <>
      <Card
        tone="overview"
        title={`${y.year} ${COVERAGE_LABEL[y.coverage].toLowerCase()} care`}
        subtitle={[y.plan?.name, y.plan?.sponsor && `through ${y.plan.sponsor}`].filter(Boolean).join(" · ") || "From the insurer's explanations of benefits"}
        actions={y.plan?.hsaEligible ? <Badge tone="info" title="A high-deductible plan: you can contribute to a Health Savings Account while covered.">HSA-eligible</Badge> : undefined}
      >
        <p className="text-sm text-fg-2">
          {plural(T.claims, "claim")} for {y.people.length === 1 ? "1 person" : `${y.people.length} people`} across {plural(y.providers.length, "provider")}
          {y.balances ? `, with the plan's balances as of the EOB of ${shortDate(y.balances.asOf)}.` : "."} What you owe is what each EOB says you owe the provider; check it against the provider&apos;s bill before paying, and pay from the HSA if you like.
        </p>
      </Card>
      <StatGrid cols={5}>
        <StatCell proof={fig("you-owe", k)} label="You owe" value={money(T.yourShareCents)} sub="Your share on every claim" />
        <StatCell proof={fig("plan-paid", k)} label="Plan paid" value={money(T.planCents)} sub="To your providers" />
        <StatCell proof={fig("billed", k)} label="Billed" value={money(T.billedCents)} sub="What providers charged" />
        <StatCell proof={fig("write-off", k)} label="Discounts & not owed" value={money(T.writeOffCents)} sub="Network rates and charges you don't owe" />
        {T.otherPlanCents ? <StatCell proof={fig("other-paid", k)} label="Other plan paid" value={money(T.otherPlanCents)} sub="Paid first (coordination of benefits)" /> : <StatCell proof={fig("claims", k)} label="Claims" value={String(T.claims)} sub="An adjusted claim counts once" />}
      </StatGrid>

      {(y.money.premiumCents > 0 || T.yourShareCents > 0) && (
        <Card
          title="Paying for it"
          subtitle="Premiums are the pay stubs' pre-tax deductions for this cover. What you owe is matched to the card, bank or HSA payments for it: a bill of that amount (or several claims' together), or what was paid at the desk on the day of care and the balance after, from a payee that names the provider, the office its care is billed under, or plainly medical care."
        >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line">
            <StatCell proof={fig("premiums", k)} label="Premiums from pay" value={money(y.money.premiumCents)} sub={y.money.premiums.length ? plural(y.money.premiums.length, "paycheck deduction") : "None on the year's stubs"} />
            <StatCell proof={fig("cost", k)} label="Cost of care" value={money(y.money.costCents)} sub="Premiums plus what you owe" />
            <StatCell proof={fig("owed-card", k)} label="Paid by card or bank" value={money(y.money.paidCents)} sub="Of what you owe" />
            <StatCell proof={fig("owed-hsa", k)} label="Paid by the HSA" value={money(y.money.fromHsaCents)} sub="Its card or bill pay, to the provider" />
            <StatCell
              proof={fig("owed-unfound", k)}
              label="No payment found"
              value={money(y.money.notFoundCents)}
              sub={
                y.money.notFound
                  ? `${plural(y.money.notFound, "claim")}${y.money.awaiting ? `, ${y.money.awaiting} waiting on statements not in yet` : ""}: paid in cash, from an account not imported, or still due`
                  : "Every claim's share is paid"
              }
            />
          </div>
        </Card>
      )}

      {y.balances && (
        <Card
          title={[...new Set(inNet.map((r) => BALANCE_LABEL[r.kind]))].join(" and ").replace(/^./, (c) => c.toUpperCase())}
          subtitle={`${y.coverage === "MEDICAL" ? "In network, as the insurer counted them" : "As the insurer printed them, each person on their latest statement"}, through the EOB of ${shortDate(y.balances.asOf)} (${shortDate(y.balances.from)} – ${shortDate(y.balances.to)})${inNet.some((r) => r.includesPharmacy) ? "; both count medical and pharmacy" : ""}.`}
        >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line">
            {family.map((r) => (
              <BalanceCell key={r.kind} y={y} row={r} fig={fig} label={`Family ${SHORT_KIND[r.kind]}`} />
            ))}
            {people.flatMap((p) =>
              inNet.filter((r) => r.person === p).map((r) => <BalanceCell key={`${p}${r.kind}`} y={y} row={r} fig={fig} label={`${p} · ${SHORT_KIND[r.kind]}`} />),
            )}
          </div>
          <p className="mt-2 text-xs text-muted">
            {y.coverage === "MEDICAL" && (outNetUsed ? "Some out-of-network care counted too: see Documents for the EOB's full balances." : "No out-of-network care counted this year.")}{inNet.some((r) => r.kind === "OUT_OF_POCKET") && " Once the family out-of-pocket limit is met, covered in-network care is paid in full for the rest of the year."}
            {inNet.some((r) => r.kind === "ANNUAL_MAXIMUM") && " The annual maximum is the most the plan pays for each person in a year, in network or out; care beyond it is yours."}
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="By month" subtitle="Who paid for each month's care, by the first day of each claim">
          <div className="h-56">
          <RechartsResponsive tableTitle="Care by month: you owe and plan paid" cellProof={(row, key) => fig(key === "you" ? "month-you" : "month-plan", sliceKey(y, row.month as string))}>
            <BarChart data={y.months.map((m) => ({ month: m.month, label: monthLabel(m.month), you: m.yourShareCents / 100, plan: m.planCents / 100 }))}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} />
              <YAxis {...ui.yAxis} tickFormatter={(n: number) => axisUsd(n)} />
              <Tooltip {...ui.tooltip} formatter={(v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
              <Legend {...ui.legend} />
              <Bar dataKey="you" name="You owe" stackId="a" fill={chart.series[0]} isAnimationActive={false} />
              <Bar dataKey="plan" name="Plan paid" stackId="a" fill={chart.series[1]} isAnimationActive={false} />
            </BarChart>
          </RechartsResponsive>
          </div>
        </Card>
        <Card title="By person" subtitle="Visits are days with care from a provider">
          <SliceTable y={y} rows={y.people} kind="person" fig={fig} name="Person" />
        </Card>
      </div>
    </>
  );
}

export function SliceTable({ y, rows, kind, fig, name }: { y: YearView; rows: Slice[]; kind: "person" | "provider" | "kind"; fig: Fig; name: string }) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr className={table.head}>
            <th className={table.th}>{name}</th>
            {kind !== "kind" && <th className={table.thR}>Visits</th>}
            <th className={table.thR}>Claims</th>
            {kind !== "person" && <th className={table.thR}>Billed</th>}
            {kind !== "kind" && <th className={table.thR}>Plan paid</th>}
            <th className={table.thR}>You owe</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const k = sliceKey(y, s.key);
            return (
              <tr key={s.key} className={table.tr}>
                <td className={`${table.td} max-w-[18rem] truncate`} title={s.key}>
                  {s.key}
                </td>
                {kind !== "kind" && <td className={table.tdR}>{s.visits}</td>}
                <td className={table.tdR}>{s.claims}</td>
                {kind !== "person" && (
                  <td className={table.tdR}>
                    <Amt fig={fig} figure={`${kind}-billed`} k={k} cents={s.billedCents} />
                  </td>
                )}
                {kind !== "kind" && (
                  <td className={table.tdR}>
                    <Amt fig={fig} figure={`${kind}-plan`} k={k} cents={s.planCents} />
                  </td>
                )}
                <td className={table.tdR}>
                  <Amt fig={fig} figure={`${kind}-you`} k={k} cents={s.yourShareCents} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
