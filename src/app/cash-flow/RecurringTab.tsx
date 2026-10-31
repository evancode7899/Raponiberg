"use client";

import { Badge, Card, Segmented, StatCell, StatGrid, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { RecurringCharge } from "@/lib/book/reports/spending";
import { usd0, usdDelta } from "@/lib/formatMoney";
import { useState } from "react";
import type { Ctx } from "./CashFlowClient";
import { sum } from "./model";
import { categoryColor, Dot } from "./parts";
import { unswept } from "@/lib/book/proof/clearance";

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
        <StatCell proof={unswept("Bills & subscriptions")} label="Bills & subscriptions" value={`${usd0(sum(active, (c) => c.annualCents) / 12)}/mo`} sub={`${active.length} active · ${usd0(sum(active, (c) => c.annualCents))} a year`} />
        <StatCell proof={unswept("Price changes")} label="Price changes" value={raised.length} tone={raised.length ? "warn" : "neutral"} sub={raised.length ? `+${usd0(sum(raised, (c) => c.changeCents!))} per charge` : "latest charges match"} />
        <StatCell proof={unswept("Habits")} label="Habits" value={`${usd0(sum(activeHabits, (c) => c.last12Cents) / 12)}/mo`} sub={`${activeHabits.length} places you go often`} />
        <StatCell proof={unswept("Stopped")} label="Stopped" value={stopped.length} sub={stopped.length ? `${usd0(sum(stopped, (c) => c.annualCents) / 12)}/mo no longer charged` : "none"} />
      </StatGrid>

      <Card
        title="Bills & subscriptions"
        subtitle={`Charges from the same merchant on a steady schedule for a steady amount, found in every proven month through ${end}. Totals are the last 12 months. A bill is "stopped" when its next charge is overdue — cancelled, moved to another card, or replaced (like rent moving to Bilt).`}
        actions={
          <Segmented
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
                  <td className={`${table.tdR} text-muted`}>{usd0(c.typicalCents)}</td>
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
                {CADENCE[c.cadence ?? ""] ?? "—"} · {c.count}×
              </td>
              <td className={table.tdR}>{usd0(c.typicalCents)}</td>
              <td className={`${table.tdR} font-medium`}>{c.active ? usd0(c.annualCents) : <span className="text-muted">—</span>}</td>
              <td className={`${table.tdR} text-xs text-muted`}>
                {usd0(c.lastCents)} · {c.lastDate}
              </td>
              <td className={table.tdR}>
                {c.changeCents ? (
                  <span className={`num text-xs font-medium ${c.changeCents > 0 ? "text-neg" : "text-pos"}`}>
                    {c.changeCents > 0 ? "▲" : "▼"} {usdDelta(c.changeCents)}
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
