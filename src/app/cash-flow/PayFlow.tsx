"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { Card, NotFigure, selectCls, table } from "@/components/ui/kit";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { payFlow, per100, type FlowBand, type PayFlow } from "@/lib/book/reports/payFlow";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import { cachedResponse } from "@/components/ledger/useApi";
import { usd0 } from "@/lib/formatMoney";
import { useEffect, useMemo, useState } from "react";
import { Sankey, Tooltip, type SankeyLinkProps, type SankeyNodeProps } from "recharts";
import type { Ctx } from "./CashFlowClient";

const PROFILE = "/api/profile";

/** A band's proof: the Annual report statement's line for the year ("drawn": saved, turned around). */
function bandProof(f: PayFlow, b: FlowBand): ProofRef {
  const line = b.key === "drawn" ? "saved" : b.key;
  const shown = b.key === "drawn" ? -b.cents : b.cents;
  return { descriptor: { report: "annual", figure: "cash", year: f.year, line }, shownCents: shown };
}

/**
 * Where a year's pay went (reports/payFlow.ts): a flow from what came in to where it went,
 * every band the Annual report statement's own line (click a band, or its row, for the proof),
 * and what $100 of gross pay became.
 */
export function PayFlowCard({ ctx }: { ctx: Ctx }) {
  const [profile, setProfile] = useState(() => cachedResponse<AnnualProfileReport>(PROFILE));
  const [year, setYear] = useState<number | null>(null);
  useEffect(() => {
    if (!ctx.api.ready) return;
    ctx.api.call<AnnualProfileReport>(PROFILE).then(setProfile).catch(() => setProfile(null));
  }, [ctx.api]);
  const flows = useMemo(() => (profile?.years ?? []).map(payFlow).filter((f): f is PayFlow => f != null), [profile]);
  const f = flows.find((x) => x.year === year) ?? flows.at(-1);
  if (!f) return null;
  const gross: ProofRef = { descriptor: { report: "annual", figure: "cash", year: f.year, line: "gross" }, shownCents: f.grossCents };
  const nodes = [...f.inflows.map((b) => ({ name: b.label })), { name: "Came in" }, ...f.outflows.map((b) => ({ name: b.label }))];
  const mid = f.inflows.length;
  const links = [...f.inflows.map((b, i) => ({ source: i, target: mid, value: b.cents / 100, key: b.key })), ...f.outflows.map((b, i) => ({ source: mid, target: mid + 1 + i, value: b.cents / 100, key: b.key }))];
  const openBand = (key: string) => document.querySelector<HTMLElement>(`[data-flow-band="${key}"] [data-proof-key]`)?.click();
  const palette = ctx.chart.series;
  const color = (i: number) => palette[i % palette.length]!;
  return (
    <Card
      title={`Where ${f.year}'s pay went`}
      subtitle={`As the Annual report's statement adds it up${f.asOf.slice(5) !== "12-31" ? `, through ${f.asOf}` : ""}: what came in on the left, where it went on the right, equal to the cent. Click a band for its proof.`}
      actions={
        flows.length > 1 && (
          <select data-audit-view="" aria-label="Year" className={selectCls} value={f.year} onChange={(e) => setYear(Number(e.target.value))}>
            {[...flows].reverse().map((x) => (
              <option key={x.year} value={x.year}>
                {x.year}
              </option>
            ))}
          </select>
        )
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="h-[280px] min-w-0" aria-label="Pay, from where it came to where it went">
          <RechartsResponsive>
            <Sankey
              data={{ nodes, links }}
              nodePadding={18}
              nodeWidth={10}
              margin={{ top: 8, right: 130, bottom: 8, left: 130 }}
              link={(p: SankeyLinkProps) => (
                <path
                  d={`M${p.sourceX},${p.sourceY} C${p.sourceControlX},${p.sourceY} ${p.targetControlX},${p.targetY} ${p.targetX},${p.targetY}`}
                  fill="none"
                  stroke={color(p.index)}
                  strokeOpacity={0.45}
                  strokeWidth={Math.max(1, p.linkWidth)}
                  style={{ cursor: "pointer" }}
                  onClick={() => openBand(String((p.payload as unknown as { key: string }).key))}
                />
              )}
              node={(p: SankeyNodeProps) => (
                <g>
                  <rect x={p.x} y={p.y} width={p.width} height={Math.max(1, p.height)} fill={p.index === mid ? ctx.chart.lineBalance : color(p.index)} />
                  <text x={p.index < mid ? p.x - 6 : p.x + p.width + 6} y={p.y + p.height / 2} dy="0.35em" textAnchor={p.index < mid ? "end" : "start"} fontSize={11} fill={ctx.chart.legend}>
                    {p.payload.name}
                  </text>
                </g>
              )}
            >
              <Tooltip formatter={(v) => usd0(Math.round(Number(v) * 100))} />
            </Sankey>
          </RechartsResponsive>
        </div>
        <div className={table.wrap}>
          <table className={`${table.table} text-[12.5px]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Band</th>
                <th className={table.thR}>{f.year}</th>
                <th className={table.thR} title="Each band per $100 of gross pay and other income">
                  <NotFigure why="a round amount the column is a share of, not a figure of yours">Per $100 of gross</NotFigure>
                </th>
              </tr>
            </thead>
            {[
              ["In", f.inflows],
              ["Out", f.outflows],
            ].map(([side, bands]) => (
              <tbody key={side as string}>
                <tr className="border-t border-line-strong">
                  <td colSpan={3} className={`${table.td} text-[11px] font-semibold uppercase tracking-wide text-muted`}>
                    {side as string}
                  </td>
                </tr>
                {(bands as FlowBand[]).map((b) => {
                  const proof = bandProof(f, b);
                  const share = per100(f, b.cents);
                  return (
                    <tr key={b.key} className={table.trHover} data-flow-band={b.key}>
                      <td className={table.td}>{b.label}</td>
                      <td className={table.tdR}>
                        <ProofValue proof={proof}>{usd0(b.cents)}</ProofValue>
                      </td>
                      <td className={`${table.tdR} text-muted`}>
                        {/* A share of gross, drawn in dollars of each $100. */}
                        <ProofValue proof={compositeOf("share", [proof, gross], { ratio: b.key === "drawn" ? -share : share })} drawn={{ per: 0.01, step: 1 }}>
                          {usd0(Math.round(share * 100) * 100)}
                        </ProofValue>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </Card>
  );
}
