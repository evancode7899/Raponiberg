"use client";

import { Card, EmptyState, ErrorNote, Loading, NotFigure, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { anomalyProof, anomalyRowProof as rowProof, RULES, type AnomaliesReport, type AnomalyKind } from "@/lib/book/reports/anomalies";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { usd0 } from "@/lib/formatMoney";
import { useEffect, useState } from "react";
import { cachedResponse } from "@/components/ledger/useApi";
import type { Ctx } from "./CashFlowClient";

const ANOMALIES = "/api/cash-flow/anomalies";
const ORDER: AnomalyKind[] = ["duplicate", "missing-bill", "missing-credit", "price-creep", "new-merchant"];

const day = (iso: string) => formatDisplayDateFromYmd(iso);

/**
 * Cash flow › Unusual: what looks unusual in the proven months (reports/anomalies.ts), each
 * rule saying how it decides. Nothing here changes a figure; each amount opens the row or the
 * figure it is.
 */
export function UnusualTab({ ctx }: { ctx: Ctx }) {
  const [r, setR] = useState(() => cachedResponse<AnomaliesReport>(ANOMALIES));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ctx.api.ready) return;
    ctx.api.call<AnomaliesReport>(ANOMALIES).then(setR).catch((e: Error) => setError(e.message));
  }, [ctx.api]);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!r) return <Loading label="Looking for what's unusual…" />;
  if (!r.through) return <EmptyState title="No proven month to look through yet" />;
  return (
    <>
      <p className="text-xs text-muted">
        The proven months, {day(r.from!)} through {day(r.through)}. A month still waiting on a statement is the Statements page&apos;s to name, never a missing bill here. {r.explained > 0 && `${r.explained} you've already explained (answered on Categorize, or paid back) ${r.explained === 1 ? "is" : "are"} left out.`}
      </p>
      {ORDER.map((kind) => {
        const items = r.items.filter((i) => i.kind === kind);
        return (
          <Card key={kind} title={`${RULES[kind].title} (${items.length})`} subtitle={<NotFigure why="the rule's thresholds, not figures of yours">{RULES[kind].how}</NotFigure>}>
            {items.length === 0 ? (
              <p className="text-xs text-muted">None.</p>
            ) : (
              <div className={table.wrap}>
                <table className={`${table.table} min-w-[36rem]`}>
                  <thead className={table.head}>
                    <tr>
                      <th className={table.th}>Merchant</th>
                      <th className={table.th}>{kind === "missing-bill" ? "Was due" : kind === "missing-credit" ? "Missing in" : "Date"}</th>
                      <th className={table.th}>What</th>
                      <th className={table.thR}>{kind === "price-creep" ? "Up by" : kind === "missing-bill" ? "Usual charge" : kind === "missing-credit" ? "Last credit" : "Amount"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((a) => (
                      <tr key={a.id} className={table.trHover}>
                        <td className={table.td}>
                          <button type="button" className="text-left hover:text-accent hover:underline" onClick={() => ctx.open({ kind: "merchant", key: a.merchantKey, name: a.merchant, lane: "EXPENSE" })}>
                            {a.merchant}
                          </button>
                        </td>
                        <td className={`${table.td} num whitespace-nowrap text-muted`}>{kind === "missing-credit" ? a.date.slice(0, 7) : day(a.date)}</td>
                        <td className={`${table.td} text-xs text-muted`}>
                          {a.kind === "price-creep" ? (
                            <>
                              <ProofValue proof={rowProof(a.rows[0]!)}>{usd0(-a.rows[0]!.cents)}</ProofValue> → <ProofValue proof={rowProof(a.rows[1]!)}>{usd0(-a.rows[1]!.cents)}</ProofValue>, {a.detail}
                            </>
                          ) : a.kind === "duplicate" ? (
                            <>
                              <ProofValue proof={rowProof(a.rows[0]!)}>{usd0(-a.rows[0]!.cents)}</ProofValue> on {day(a.rows[0]!.date)} and again on {day(a.rows[1]!.date)}
                            </>
                          ) : (
                            a.detail
                          )}
                        </td>
                        <td className={`${table.tdR} font-medium`}>
                          <ProofValue proof={anomalyProof(a, ctx.dp)}>{usd0(a.cents)}</ProofValue>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}
