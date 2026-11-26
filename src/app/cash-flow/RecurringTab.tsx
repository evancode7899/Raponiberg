"use client";

import { Badge, Card, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import { compositeOf } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { RecurringCharge } from "@/lib/book/reports/spending";
import { NA, usd0, usdDelta } from "@/lib/formatMoney";
import { useMemo, useState } from "react";
import { personalInflation } from "@/lib/book/reports/personalInflation";
import { formatPercentRatio } from "@/lib/formatMoney";
import type { Ctx } from "./CashFlowClient";
import { sum } from "./model";
import { categoryColor, Dot } from "./parts";

const CADENCE: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", quarterly: "Quarterly", annual: "Yearly" };

export function RecurringTab({ ctx }: { ctx: Ctx }) {
  const { report } = ctx;
  const [show, setShow] = useState<"active" | "stopped">("active");
  const bills = report.recurring.filter((c) => c.kind === "bill");
  const habits = report.recurring.filter((c) => c.kind === "habit");
  const active = bills.filter((c) => c.active);
  const stopped = bills.filter((c) => !c.active);
  const raised = active.filter((c) => (c.changeCents ?? 0) > 0);
  const activeHabits = habits.filter((c) => c.active);
  const end = report.window?.to ?? "";

  return (
    <>
      <StatGrid cols={4}>
        <StatCell proof={ctx.dp("bills-monthly")} label="Bills & subscriptions" value={`${usd0(sum(active, (c) => c.annualCents) / 12)}/mo`} sub={<>{active.length} active · <ProofValue proof={ctx.dp("bills-yearly")}>{usd0(sum(active, (c) => c.annualCents))}</ProofValue> a year</>} />
        <StatCell proof={ctx.dp("price-changes")} label="Price changes" value={raised.length} tone={raised.length ? "warn" : "neutral"} sub={raised.length ? <>+<ProofValue proof={raised.length === 1 ? ctx.dp("recurring-change", raised[0]!.key) : compositeOf("sum", raised.map((c) => ctx.dp("recurring-change", c.key)), { cents: sum(raised, (c) => c.changeCents!) })}>{usd0(sum(raised, (c) => c.changeCents!))}</ProofValue> per charge</> : "latest charges match"} />
        <StatCell proof={ctx.dp("habits-monthly")} label="Habits" value={`${usd0(sum(activeHabits, (c) => c.last12Cents) / 12)}/mo`} sub={`${activeHabits.length} places you go often`} />
        <StatCell proof={ctx.dp("stopped")} label="Stopped" value={stopped.length} sub={stopped.length ? <><ProofValue proof={ctx.dp("stopped-monthly")}>{usd0(sum(stopped, (c) => c.annualCents) / 12)}</ProofValue>/mo no longer charged</> : "none"} />
      </StatGrid>

      <Card
        title="Bills & subscriptions"
        subtitle={`Charges from the same merchant on a steady schedule for a steady amount, found in every proven month through ${end}. Totals are the last 12 months. A bill is "stopped" when its next charge is overdue — cancelled, moved to another card, or replaced (like rent moving to Bilt).`}
        actions={
          <Segmented view
            size="xs"
            ariaLabel="Which bills"
            options={[
              { value: "active", label: `Active (${active.length})` },
              { value: "stopped", label: `Stopped (${stopped.length})` },
            ]}
            value={show}
            onChange={setShow}
          />
        }
      >
        <BillTable ctx={ctx} list={show === "active" ? active : stopped} />
      </Card>

      <Prices ctx={ctx} />

      <Card title="Habits" subtitle="Merchants you return to often for varying amounts — coffee, lunch, rides, groceries. Small charges that add up; the yearly figure is the last 12 months.">
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[48rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Merchant</th>
                <th className={table.th}>Category</th>
                <th className={table.thR}>Visits</th>
                <th className={table.thR}>Typical visit</th>
                <th className={table.thR}>Last 12 months</th>
                <th className={table.thR}>Last visit</th>
                <th className={table.thR}>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...habits].sort((a, b) => b.last12Cents - a.last12Cents).map((c) => (
                <tr key={c.key} className={`${table.trHover} cursor-pointer`} onClick={() => ctx.open({ kind: "merchant", key: c.key, name: c.name, lane: "EXPENSE" })}>
                  <td className={`${table.td} font-medium`}>{c.name}</td>
                  <td className={`${table.td} text-xs text-fg-2`}>
                    <span className="flex items-center gap-1.5">
                      <Dot color={categoryColor(ctx.chart, c.category)} className="!h-2 !w-2" />
                      {c.category}
                    </span>
                  </td>
                  <td className={table.tdR}>
                    {c.count}
                    <span className="text-xs text-muted"> in {c.monthsSeen} mo</span>
                  </td>
                  <td className={`${table.tdR} text-muted`}>
                    <ProofValue proof={ctx.dp("recurring-typical", c.key)}>{usd0(c.typicalCents)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} font-medium`}>
                    <ProofValue proof={ctx.proof("spending", report.months, { merchantKey: c.key, charges: true, shownCents: c.last12Cents })}>{usd0(c.last12Cents)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} text-xs text-muted`}>{c.lastDate}</td>
                  <td className={table.tdR}>{c.active ? <Badge tone="info">active</Badge> : <Badge>lapsed</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function BillTable({ ctx, list }: { ctx: Ctx; list: RecurringCharge[] }) {
  if (!list.length) return <p className="text-sm text-muted">None.</p>;
  return (
    <div className={table.wrap}>
      <table className={`${table.table} min-w-[52rem]`}>
        <thead className={table.head}>
          <tr>
            <th className={table.th}>Merchant</th>
            <th className={table.th}>Category</th>
            <th className={table.th}>Schedule</th>
            <th className={table.thR}>Typical charge</th>
            <th className={table.thR}>Per year</th>
            <th className={table.thR}>Last charge</th>
            <th className={table.thR}>Change</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.key} className={`${table.trHover} cursor-pointer`} onClick={() => ctx.open({ kind: "merchant", key: c.key, name: c.name, lane: "EXPENSE" })}>
              <td className={`${table.td} font-medium`}>{c.name}</td>
              <td className={`${table.td} text-xs text-fg-2`}>
                <span className="flex items-center gap-1.5">
                  <Dot color={categoryColor(ctx.chart, c.category)} className="!h-2 !w-2" />
                  {c.category}
                </span>
              </td>
              <td className={`${table.td} text-xs text-muted`}>
                {CADENCE[c.cadence ?? ""] ?? NA} · {c.count}×
              </td>
              <td className={table.tdR}>
                <ProofValue proof={ctx.dp("recurring-typical", c.key)}>{usd0(c.typicalCents)}</ProofValue>
              </td>
              <td className={`${table.tdR} font-medium`}>{c.active ? <ProofValue proof={ctx.dp("recurring-annual", c.key)}>{usd0(c.annualCents)}</ProofValue> : <span className="text-muted">—</span>}</td>
              <td className={`${table.tdR} text-xs text-muted`}>
                <ProofValue proof={ctx.dp("recurring-last", c.key)}>{usd0(c.lastCents)}</ProofValue> · {c.lastDate}
              </td>
              <td className={table.tdR}>
                {c.changeCents ? (
                  <span className={`num text-xs font-medium ${c.changeCents > 0 ? "text-neg" : "text-pos"}`}>
                    {c.changeCents > 0 ? "▲" : "▼"} <ProofValue proof={ctx.dp("recurring-change", c.key)}>{usdDelta(c.changeCents)}</ProofValue>
                  </span>
                ) : (
                  <span className="text-xs text-faint">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Your prices, a year on (reports/personalInflation.ts): each bill's latest charge against the
 * same bill's a year before, by category and in all, weighted by cost. Like for like: the same
 * bill twice, so buying more or less never reads as a price change.
 */
function Prices({ ctx }: { ctx: Ctx }) {
  const p = useMemo(() => personalInflation(ctx.report.recurring), [ctx.report.recurring]);
  if (!p.all) return null;
  const pct = (x: number) => `${x > 0 ? "+" : ""}${formatPercentRatio(x, 1)}`;
  const row = (x: { rowId: string; cents: number }) => ({ descriptor: { report: "row" as const, rowId: x.rowId }, shownCents: -x.cents });
  return (
    <Card
      title={<>Your prices, a year on: <ProofValue proof={ctx.dp("price-all")}>{pct(p.all.change)}</ProofValue></>}
      subtitle="Each bill for a set amount (subscriptions, rent, premiums, tuition) against the same bill a year before, weighted by what the bills cost: a price change, never a change in how much you used or bought. Metered bills and tax payments aren't prices. Spending that varies (groceries, dining) has no like-for-like price; Year over year shows how its dollars moved."
    >
      <div className={table.wrap}>
        <table className={`${table.table} min-w-[40rem]`}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>Bill</th>
              <th className={table.thR}>A year before</th>
              <th className={table.thR}>Latest</th>
              <th className={table.thR}>Change</th>
            </tr>
          </thead>
          {p.categories.map((g) => (
            <tbody key={g.category}>
              <tr className="border-t border-line-strong bg-surface-2 font-semibold">
                <td className={table.td}>
                  <span className="flex items-center gap-2">
                    <Dot color={categoryColor(ctx.chart, g.category)} />
                    {g.category}
                  </span>
                </td>
                <td className={table.tdR} />
                <td className={table.tdR} />
                <td className={`${table.tdR} ${g.change > 0.0005 ? "text-neg" : g.change < -0.0005 ? "text-pos" : "text-muted"}`}>
                  <ProofValue proof={ctx.dp("price-category", g.category)}>{pct(g.change)}</ProofValue>
                </td>
              </tr>
              {g.bills.map((b) => (
                <tr key={b.key} className={table.trHover}>
                  <td className={`${table.td} pl-6`}>{b.name}</td>
                  <td className={`${table.tdR} text-muted`}>
                    <ProofValue proof={row(b.then)}>{usd0(b.then.cents)}</ProofValue> <span className="text-[11px] text-faint">{b.then.date}</span>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={row(b.now)}>{usd0(b.now.cents)}</ProofValue> <span className="text-[11px] text-faint">{b.now.date}</span>
                  </td>
                  <td className={`${table.tdR} ${b.change > 0.0005 ? "text-neg" : b.change < -0.0005 ? "text-pos" : "text-muted"}`}>
                    <ProofValue proof={ctx.dp("price-bill", b.key)}>{pct(b.change)}</ProofValue>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </Card>
  );
}
