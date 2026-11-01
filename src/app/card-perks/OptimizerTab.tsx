"use client";

import { Card, NotFigure, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import { SPLIT_SHOWN } from "@/lib/book/derived/cardPerks";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { CardScore } from "@/lib/cardPerks/types";
import { usd0 } from "@/lib/formatMoney";
import { CardFace, fmtCpp, fmtRate, shortName, TERMS, useCardFigures } from "./parts";

export function OptimizerTab({ r }: { r: CardPerksPage }) {
  const byId = new Map(r.cards.map((c) => [c.accountId, c]));
  const o = r.optimizer;
  const points = r.cards.filter((c) => c.program.kind === "POINTS");
  const cf = useCardFigures(r);
  return (
    <>
      {o.tips.length > 0 && (
        <Card
          tone="overview"
          title="Which card to reach for"
          subtitle={`The open card that earns the most on each kind of purchase${points.length ? `, with points at ${[...new Set(points.map((c) => `${c.program.name} ${fmtCpp(c.centsPerPoint)}`))].join(", ")}` : ""} (change point values on Setup).`}
        >
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            {o.tips.map((t) => {
              const c = byId.get(t.accountId);
              const second = t.runnerUp ? byId.get(t.runnerUp.accountId) : undefined;
              if (!c) return null;
              return (
                <li key={t.key} className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2">
                  <CardFace c={c} small />
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t.label}</div>
                    <div className="truncate text-[13px] font-medium text-fg">{shortName(c)}</div>
                    <div className="num text-[11px] text-fg-2" title={second ? `Next best: ${shortName(second)}, ${+t.runnerUp!.centsPerDollar.toFixed(2)}¢ a dollar` : undefined}>
                      <NotFigure why={TERMS}>{fmtRate(c.rewards.kind, t.rate)}</NotFigure> · {+t.centsPerDollar.toFixed(2)}¢ a dollar
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card
        title={`What ${r.year}'s spending earned, and could have`}
        subtitle={
          <>
            Each purchase valued on the card that paid and on the best card held that day. <ProofValue proof={cf.opt("all", "spend")}>{usd0(o.spendCents)}</ProofValue> of spending earned <ProofValue proof={cf.opt("all", "actual")}>{usd0(o.actualCents)}</ProofValue>; the best card every time would have added{" "}
            <ProofValue proof={cf.opt("all", "missed")}>{usd0(o.missedCents)}</ProofValue> (spending caps aside). Rent through Bilt stays with Bilt.
          </>
        }
      >
        <div className={table.wrap}>
          <table className={table.table} style={{ minWidth: "48rem" }}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Purchases</th>
                <th className={table.thR}>Spending</th>
                <th className={table.th}>Paid with</th>
                <th className={table.thR}>Earned</th>
                <th className={table.thR}>Best possible</th>
                <th className={table.thR}>Left on the table</th>
                <th className={table.th}>Best card</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => {
                const gap = l.bestCents - l.actualCents;
                const best = l.best ? byId.get(l.best.accountId) : undefined;
                return (
                  <tr key={l.key} className={table.tr}>
                    <td className={`${table.td} font-medium`}>{l.label}</td>
                    <td className={table.tdR}><ProofValue proof={cf.opt(l.key, "spend")}>{usd0(l.spendCents)}</ProofValue></td>
                    <td className={`${table.td} w-56`}>
                      <SplitBar parts={l.byCard} byId={byId} total={l.spendCents} share={(accountId, cents) => compositeOf("share", [cf.opt(`${l.key}|${accountId}`, "spend"), cf.opt(l.key, "spend")], { ratio: cents / l.spendCents })} />
                    </td>
                    <td className={table.tdR}><ProofValue proof={cf.opt(l.key, "actual")}>{usd0(l.actualCents)}</ProofValue></td>
                    <td className={table.tdR}><ProofValue proof={cf.opt(l.key, "best")}>{usd0(l.bestCents)}</ProofValue></td>
                    <td className={`${table.tdR} font-semibold ${gap >= 1000 ? "text-warn" : "text-muted"}`}>{gap >= 100 ? <ProofValue proof={compositeOf("diff", [cf.opt(l.key, "best"), cf.opt(l.key, "actual")], { cents: gap })}>{usd0(gap)}</ProofValue> : "—"}</td>
                    <td className={table.td}>{best && gap >= 100 ? shortName(best) : <span className="text-muted">Already on it</span>}</td>
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

const COLORS = ["bg-accent", "bg-pos", "bg-info", "bg-warn", "bg-neg", "bg-fg-2"];

function SplitBar({ parts, byId, total, share }: { parts: { accountId: string; spendCents: number }[]; byId: Map<string, CardScore>; total: number; share: (accountId: string, cents: number) => ProofRef }) {
  const ids = [...byId.keys()];
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-3">
        {parts.map((p) => (
          <div key={p.accountId} className={`h-full ${COLORS[ids.indexOf(p.accountId) % COLORS.length]}`} style={{ width: `${(p.spendCents / Math.max(total, 1)) * 100}%` }} title={`${byId.get(p.accountId) ? shortName(byId.get(p.accountId)!) : "Card"}: ${usd0(p.spendCents)}`} />
        ))}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted">
        {parts.slice(0, SPLIT_SHOWN).map((p, i) => (
          <span key={p.accountId}>
            {i ? " · " : ""}
            {byId.get(p.accountId) ? shortName(byId.get(p.accountId)!) : "Card"} <ProofValue proof={share(p.accountId, p.spendCents)}>{`${Math.round((p.spendCents / Math.max(total, 1)) * 100)}%`}</ProofValue>
          </span>
        ))}
      </div>
    </div>
  );
}
