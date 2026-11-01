"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { categoryKey, merchantKeyOf, windowKey } from "@/lib/book/derived/cashFlow";
import { chartChrome } from "@/components/shell/chartPalette";
import { Stat, NotFigure } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { useProof } from "@/components/ui/proof/context";
import type { MerchantMonth, SpendingMonth } from "@/lib/book/reports/spending";
import type { CashFlowMetric } from "@/lib/book/proof/cashFlowProof";
import { CATEGORIES } from "@/lib/classifier/taxonomy";
import { axisUsd, formatPercentRatio, formatUsd, formatUsdCents, usd0 } from "@/lib/formatMoney";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { Ctx, Drill } from "./CashFlowClient";
import { categoryCents, KINDS, median, mergeMerchants, monthDrillMerchants, sum } from "./model";
import { categoryColor, Dot, Eyebrow, TxnList } from "./parts";
import type { ProofRef } from "@/components/ui/proof/context";
import { isUnswept } from "@/lib/book/proof/clearance";

function laneOf(category: string): string {
  const def = CATEGORIES.find((c) => c.name === category);
  if (def?.group === "Money movement") return "EXTERNAL_TRANSFER";
  return def?.kind === "INCOME" ? "INCOME" : "EXPENSE";
}

const metricOf: Record<string, CashFlowMetric> = { EXPENSE: "spending", INCOME: "income", EXTERNAL_TRANSFER: "external" };

/** Bars per month of the range; clicking a month opens the rows behind that month's bar. */
function MonthBars({ ctx, values, color, name, proofAt }: { ctx: Ctx; values: number[]; color: string; name: string; proofAt: (m: SpendingMonth, cents: number) => ProofRef }) {
  const ui = chartChrome(ctx.chart);
  const openProof = useProof();
  const data = ctx.slice.months.map((m, i) => ({ label: m.label, v: values[i]! / 100 }));
  const avg = sum(values, (v) => v) / Math.max(1, values.length) / 100;
  return (
    <div className="h-[200px] w-full min-w-0">
      <RechartsResponsive>
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          className="cursor-pointer"
          onClick={(s) => {
            const i = s?.activeTooltipIndex == null ? -1 : Number(s.activeTooltipIndex);
            const m = ctx.slice.months[i];
            const proof = m && proofAt(m, values[i]!);
            if (proof && !isUnswept(proof) && openProof) openProof(proof);
          }}
        >
          <CartesianGrid {...ui.grid} />
          <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
          <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
          <Tooltip {...ui.tooltip} formatter={(v) => [formatUsd(Math.round(Number(v))), name]} />
          <ReferenceLine y={avg} stroke={ctx.chart.axis} strokeDasharray="4 4" label={{ value: "avg", fill: ctx.chart.axis, fontSize: 10, position: "right" }} />
          <Bar dataKey="v" fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </RechartsResponsive>
    </div>
  );
}

export function CategoryDrill({ ctx, category }: { ctx: Ctx; category: string }) {
  const { slice, chart } = ctx;
  const lane = laneOf(category);
  const color = lane === "EXPENSE" ? categoryColor(chart, category) : lane === "INCOME" ? chart.income : chart.series[2]!;
  const values = slice.months.map((m) =>
    lane === "EXPENSE" ? categoryCents(m, category) : ((lane === "INCOME" ? m.incomeByCategory : m.externalByCategory).find((c) => c.category === category)?.cents ?? 0),
  );
  const total = sum(values, (v) => v);
  const spending = sum(slice.months, (m) => m.spendingCents);
  const merchants = useMemo(
    () => (lane === "EXPENSE" ? mergeMerchants(slice.months, (m) => m.merchants.filter((x) => x.category === category)) : []),
    [slice, category, lane],
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total" value={usd0(total)} proof={ctx.proof(metricOf[lane]!, slice.months, { category, shownCents: total })} />
        <Stat label="Per month" value={usd0(total / Math.max(1, values.length))} proof={ctx.proof(metricOf[lane]!, slice.months, { category, perMonth: true, shownCents: total })} />
        <Stat proof={ctx.dp("category-typical", categoryKey(slice.months, lane === "EXTERNAL_TRANSFER" ? "EXTERNAL" : lane === "INCOME" ? "INCOME" : "EXPENSE", category))} label="Typical month" value={usd0(median(values))} />
        <Stat proof={ctx.dp(lane === "EXPENSE" ? "category-share" : "category-months", categoryKey(slice.months, lane === "EXTERNAL_TRANSFER" ? "EXTERNAL" : lane === "INCOME" ? "INCOME" : "EXPENSE", category))} label={lane === "EXPENSE" ? "Share of spending" : "Months"} value={lane === "EXPENSE" ? (spending > 0 ? formatPercentRatio(total / spending, 0) : "—") : values.filter(Boolean).length} />
      </div>
      <p className="-mt-2 text-xs text-muted">
        Click the total for the rows behind it, statement by statement, with every check over them. The transactions below are listed by posting date for editing, so a row near a month&apos;s edge or a rent
        payment may sit in a different month here.
      </p>
      <p className="-mt-3 text-xs text-muted">Click a month&apos;s bar for the rows behind it.</p>
      <MonthBars ctx={ctx} values={values} color={color} name={category} proofAt={(m, cents) => ctx.proof(metricOf[lane]!, [m], { category, shownCents: cents })} />
      {category === "Housing & utilities" && <RentTiming ctx={ctx} />}
      {merchants.length > 0 && (
        <div>
          <Eyebrow>Top merchants</Eyebrow>
          <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {merchants.slice(0, 12).map((m) => (
              <li key={m.key}>
                <button
                  type="button"
                  className="grid w-full grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-2 rounded px-1 py-1 text-left text-[13px] hover:bg-surface-2"
                  onClick={() => ctx.open({ kind: "merchant", key: m.key, name: m.name, lane: "EXPENSE" })}
                  title={m.key}
                >
                  <span className="truncate text-fg-2">{m.name}</span>
                  <span className="num text-right text-xs text-muted">{m.count}×</span>
                  <span className="num text-right font-medium">
                    <ProofValue proof={ctx.proof("spending", slice.months, { merchantKey: m.key, shownCents: m.cents })}>{usd0(m.cents)}</ProofValue>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <Eyebrow>Transactions</Eyebrow>
        <TxnList api={ctx.api} query={{ category, lane, from: slice.months[0]!.start, to: slice.months.at(-1)!.end }} onChanged={ctx.reload} />
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** Each rent payment in the month it pays for, so a month's housing isn't its posting dates. */
function RentTiming({ ctx }: { ctx: Ctx }) {
  const { slice } = ctx;
  const from = slice.months[0]!.start;
  const to = slice.months.at(-1)!.end;
  const rent = ctx.report.rent.filter((p) => p.covers >= from && p.covers <= to);
  if (!rent.length) return null;
  const moved = rent.filter((p) => p.date.slice(0, 7) !== p.covers.slice(0, 7)).length;
  return (
    <div>
      <Eyebrow>Rent, by the month it pays for</Eyebrow>
      <p className="mb-2 text-xs text-muted">
        Rent is counted in the month it covers, not the day it posts: it&apos;s paid for the month ahead, so a payment in the first half of a month pays for that month and one in the
        second half pays early for the next. {moved > 0 && `${moved} of ${rent.length} payments here posted in a different month, so the transactions below list them by posting date.`}
      </p>
      <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {[...rent].reverse().map((p) => (
          <li key={p.rowId} className="grid grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] items-center gap-2 px-1 py-1 text-[13px]" title={p.payee}>
            <span className="text-fg-2">{monthLabel(p.covers)}</span>
            <span className="truncate text-xs text-muted">
              paid {dayLabel(p.date)}
              {p.full ? "" : " · top-up"}
            </span>
            <span className="num text-right font-medium">
              <ProofValue proof={{ descriptor: { report: "row", rowId: p.rowId }, shownCents: null }}>{formatUsdCents(p.cents)}</ProofValue>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MerchantDrill({ ctx, drill }: { ctx: Ctx; drill: Extract<Drill, { kind: "merchant" }> }) {
  const { slice, chart } = ctx;
  const pick = drill.lane === "EXPENSE" ? (m: (typeof slice.months)[number]) => m.merchants : (m: (typeof slice.months)[number]) => m.payers;
  const values = slice.months.map((m) => pick(m).find((x) => x.key === drill.key)?.cents ?? 0);
  const count = sum(slice.months, (m) => pick(m).find((x) => x.key === drill.key)?.count ?? 0);
  const total = sum(values, (v) => v);
  const category = slice.months.flatMap(pick).find((x) => x.key === drill.key)?.category ?? "";
  const recurring = ctx.report.recurring.find((c) => c.key === drill.key);
  const color = drill.lane === "EXPENSE" ? categoryColor(chart, category) : chart.income;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat proof={ctx.proof(drill.lane === "EXPENSE" ? "spending" : "income", slice.months, { merchantKey: drill.key, shownCents: total })} label="Total" value={usd0(total)} sub={category} />
        <Stat proof={ctx.dp("merchant-count", merchantKeyOf(slice.months, drill.lane === "EXPENSE" ? "EXPENSE" : "INCOME", drill.key))} label={drill.lane === "EXPENSE" ? "Charges" : "Deposits"} value={count} sub={`in ${values.filter(Boolean).length} of ${values.length} months`} />
        <Stat proof={ctx.dp("merchant-avg", merchantKeyOf(slice.months, drill.lane === "EXPENSE" ? "EXPENSE" : "INCOME", drill.key))} label="Average" value={usd0(count ? total / count : 0)} sub="per charge" />
        <Stat proof={ctx.dp("merchant-pattern", merchantKeyOf(slice.months, drill.lane === "EXPENSE" ? "EXPENSE" : "INCOME", drill.key))}
          label="Pattern"
          value={recurring ? (recurring.kind === "bill" ? "Bill" : "Habit") : "Irregular"}
          sub={
            recurring ? (
              <>
                {/* A year of it while it's still charged: a bill's usual charge as often as it comes, a habit's last twelve months (Recurring's own figures). */}
                {!recurring.active ? (
                  "stopped"
                ) : recurring.kind === "bill" ? (
                  <>
                    active · <ProofValue proof={ctx.dp("recurring-annual", recurring.key)}>{usd0(recurring.annualCents)}</ProofValue>/yr
                  </>
                ) : (
                  <>
                    active · <ProofValue proof={ctx.proof("spending", ctx.report.months, { merchantKey: recurring.key, charges: true, shownCents: recurring.last12Cents })}>{usd0(recurring.last12Cents)}</ProofValue>/yr
                  </>
                )}
              </>
            ) : undefined
          }
        />
      </div>
      <MonthBars
        ctx={ctx}
        values={values}
        color={color}
        name={drill.name}
        proofAt={(m, cents) => ctx.proof(drill.lane === "EXPENSE" ? "spending" : "income", [m], { merchantKey: drill.key, shownCents: cents })}
      />
      <div>
        <Eyebrow>Transactions</Eyebrow>
        <TxnList api={ctx.api} query={{ q: drill.key, lane: drill.lane, from: slice.months[0]!.start, to: slice.months.at(-1)!.end }} onChanged={ctx.reload} />
      </div>
    </div>
  );
}

/**
 * One month, audited: its income, spending and net, the three bands of spending, every
 * category (a net credit flagged) and the merchants that paid money back, each amount
 * opening the rows behind it. Opened by clicking a month on any of the tab's charts.
 */
export function MonthDrill({ ctx, month: m }: { ctx: Ctx; month: SpendingMonth }) {
  const { chart } = ctx;
  const one = [m];
  const { credits, top } = monthDrillMerchants(m);
  const merchant = (x: MerchantMonth) => (
    <li key={x.key}>
      <button
        type="button"
        className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,9rem)_3rem_6rem] items-center gap-2 rounded px-1 py-1 text-left text-[13px] hover:bg-surface-2"
        onClick={() => ctx.open({ kind: "merchant", key: x.key, name: x.name, lane: "EXPENSE" })}
        title={x.key}
      >
        <span className="truncate text-fg-2">{x.name}</span>
        <span className="truncate text-xs text-muted">{x.category}</span>
        <span className="num text-right text-xs text-muted">{x.count}×</span>
        <span className={`num text-right font-medium ${x.cents < 0 ? "text-pos" : ""}`}>
          <ProofValue proof={ctx.proof("spending", one, { merchantKey: x.key, shownCents: x.cents })}>{usd0(x.cents)}</ProofValue>
        </span>
      </button>
    </li>
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Income" value={usd0(m.incomeCents)} proof={ctx.proof("income", one, { shownCents: m.incomeCents })} />
        <Stat label="Spending" value={usd0(m.spendingCents)} proof={ctx.proof("spending", one, { shownCents: m.spendingCents })} sub="net of merchant refunds; tax refunds are income" />
        <Stat label="Net saved" value={usd0(m.netCents)} proof={ctx.proof("net", one, { shownCents: m.netCents })} />
        <Stat proof={ctx.dp("savings-rate", windowKey(one))} label="Savings rate" value={m.savingsRate == null ? "—" : formatPercentRatio(m.savingsRate, 0)} sub="net ÷ income" />
      </div>
      {(m.through || m.unreviewed.rows > 0) && (
        <p className="-mt-2 text-xs text-muted">
          {m.through ? `The month isn't over: figures run through ${m.through}. ` : ""}
          {m.unreviewed.rows > 0 &&
            `${m.unreviewed.rows} row${m.unreviewed.rows === 1 ? "" : "s"} count as the classifier filed them but still wait for your review (Statements → Review).`}
        </p>
      )}

      <div>
        <Eyebrow>Spending by kind</Eyebrow>
        <ul className="flex flex-col">
          {KINDS.map((k, i) => (
            <li key={k.id} className="grid grid-cols-[minmax(0,1fr)_6rem] items-baseline gap-2 px-1 py-1 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <Dot color={[chart.series[6]!, chart.spending, chart.neutral][i]!} />
                <span className="text-fg-2">{k.label}</span>
                <span className="truncate text-xs text-muted">
                  <NotFigure why="what the kind counts: the app's one-off rule">{k.hint}</NotFigure>
                </span>
              </span>
              <span className={`num text-right font-medium ${m.kinds[k.id] < 0 ? "text-pos" : ""}`}>
                <ProofValue proof={ctx.proof("spending", one, { spendingKind: k.kind, shownCents: m.kinds[k.id] })}>{usd0(m.kinds[k.id])}</ProofValue>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <Eyebrow>Spending by category</Eyebrow>
        <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {m.spendingByCategory.map((c) => (
            <li key={c.category}>
              <button
                type="button"
                className="grid w-full grid-cols-[minmax(0,1fr)_6rem] items-center gap-2 rounded px-1 py-1 text-left text-[13px] hover:bg-surface-2"
                onClick={() => ctx.open({ kind: "category", category: c.category })}
              >
                <span className="flex min-w-0 items-center gap-2 truncate text-fg-2">
                  <Dot color={categoryColor(chart, c.category)} />
                  <span className="truncate">{c.category}</span>
                  {c.cents < 0 && <span className="shrink-0 rounded bg-pos-soft px-1 text-[10px] font-medium text-pos">net credit</span>}
                </span>
                <span className={`num text-right font-medium ${c.cents < 0 ? "text-pos" : ""}`}>
                  <ProofValue proof={ctx.proof("spending", one, { category: c.category, shownCents: c.cents })}>{usd0(c.cents)}</ProofValue>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {credits.length > 0 && (
        <div>
          <Eyebrow>Credits and refunds</Eyebrow>
          <p className="mb-1 text-xs text-muted">
            Merchants that paid back more than they charged this month (a refund, a reimbursement). Each takes spending down (a tax refund never does: it counts as income); check it&apos;s filed under the
            category it pays back.
          </p>
          <ul className="flex flex-col">{credits.map(merchant)}</ul>
        </div>
      )}

      <div>
        <Eyebrow>Largest merchants</Eyebrow>
        <ul className="flex flex-col">{top.map(merchant)}</ul>
      </div>

      <div>
        <Eyebrow>Transactions</Eyebrow>
        <TxnList api={ctx.api} query={{ lane: "EXPENSE", from: m.start, to: m.end }} onChanged={ctx.reload} />
      </div>
    </div>
  );
}
