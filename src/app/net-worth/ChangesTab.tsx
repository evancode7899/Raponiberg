"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import type { ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { btn, Card, EmptyState, Loading, Segmented, selectCls, StatCell, StatGrid, table } from "@/components/ui/kit";
import type { ProofDescriptor } from "@/lib/book/proof";
import type { ChangeMover, NetWorthChange, NetWorthChangesReport } from "@/lib/book/reports/netWorthChanges";
import { axisUsd, formatUsd, usd0, usdDelta } from "@/lib/formatMoney";
import { useMemo, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { unswept } from "@/lib/book/proof/clearance";

type Granularity = NetWorthChangesReport["granularity"];

const proofOf = (descriptor: ProofDescriptor | null, shownCents: number): ProofRef => (descriptor ? { descriptor, shownCents } : unswept("no recipe for this span"));

const UNIT: Record<Granularity, string> = { month: "month", quarter: "quarter", year: "year" };

/** A difference from typical, coloured by whether it helped net worth. */
function Delta({ cents }: { cents: number | null }) {
  if (cents == null) return <span className="text-faint">—</span>;
  return <span className={Math.round(cents / 100) === 0 ? "text-muted" : cents > 0 ? "text-pos" : "text-neg"}>{usdDelta(cents)}</span>;
}

export function ChangesTab({ r, granularity, setGranularity }: { r: NetWorthChangesReport | null; granularity: Granularity; setGranularity: (g: Granularity) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const control = (
    <Segmented
      options={[
        { value: "month", label: "Month" },
        { value: "quarter", label: "Quarter" },
        { value: "year", label: "Year" },
      ]}
      value={granularity}
      onChange={(g) => {
        // A new granularity starts on its latest period.
        setPicked(null);
        setGranularity(g);
      }}
    />
  );
  if (!r || r.granularity !== granularity) return <Loading label="Lining up net worth with cash flow…" />;
  if (!r.periods.length) return <EmptyState title={`No ${UNIT[granularity]} that both net worth and cash flow can prove yet`} />;
  const i = picked ? Math.max(0, r.periods.findIndex((p) => p.start === picked)) : r.periods.length - 1;
  const p = r.periods[i]!;
  const go = (j: number) => setPicked(r.periods[j]!.start);
  const picker = (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={btn.secondary} disabled={i === 0} onClick={() => go(i - 1)} aria-label={`Previous ${UNIT[granularity]}`}>
        ‹
      </button>
      <select className={selectCls} value={p.start} onChange={(e) => setPicked(e.target.value)} aria-label={`Pick a ${UNIT[granularity]}`}>
        {[...r.periods].reverse().map((x) => (
          <option key={x.start} value={x.start}>
            {x.label}
            {x.through ? ` (to ${x.through})` : ""}
          </option>
        ))}
      </select>
      <button type="button" className={btn.secondary} disabled={i === r.periods.length - 1} onClick={() => go(i + 1)} aria-label={`Next ${UNIT[granularity]}`}>
        ›
      </button>
      {control}
    </div>
  );
  return <Period p={p} granularity={granularity} compareWith={r.compareWith} picker={picker} />;
}

function Period({ p, granularity, compareWith, picker }: { p: NetWorthChange; granularity: Granularity; compareWith: number; picker: ReactNode }) {
  const unit = UNIT[granularity];
  const t = p.typical;
  const typicalSub = (cents: number | undefined) => (t && cents != null ? `average ${usd0(cents)}` : undefined);
  const compared = t
    ? `against the average of the ${t.periods === 1 ? `${unit} before` : `${t.periods} ${unit}s before`}${t.periods < compareWith ? ` (all that are proven, of up to ${compareWith})` : ""}`
    : p.through
      ? `cut short at ${p.through}, so it isn't compared with whole ${unit}s`
      : `the first proven ${unit}, so there's nothing before it to compare with`;
  return (
    <>
      <Card
        tone="overview"
        title={
          <>
            {p.label}
            {p.through ? <span className="font-normal text-muted"> · to {p.through}</span> : null}
          </>
        }
        subtitle={`Every ${unit} that both net worth and cash flow can prove, ${compared}.`}
      >
        {/* In the body, not the header's actions, so it wraps on a phone. */}
        <div className="mb-3">{picker}</div>
        <ul className="space-y-1.5 text-sm leading-relaxed text-fg-2">
          {p.highlights.map((h) => (
            <li key={h} className="flex gap-2">
              <span className="text-faint" aria-hidden>
                •
              </span>
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </Card>

      <StatGrid cols={5}>
        <StatCell label="Opening" value={usd0(p.openingCents)} proof={proofOf(p.proofs.opening, p.openingCents)} sub={`end of the day before ${p.start}`} />
        <StatCell label="Change" value={usdDelta(p.changeCents)} proof={proofOf(p.proofs.change, p.changeCents)} tone={p.changeCents >= 0 ? "pos" : "neg"} sub={typicalSub(t?.changeCents)} />
        <StatCell label="…from saving" value={usdDelta(p.savedCents)} proof={proofOf(p.proofs.saved, p.savedCents)} sub={typicalSub(t?.savedCents) ?? "saved & contributed"} />
        <StatCell label="…from markets" value={usdDelta(p.marketsCents)} proof={proofOf(p.proofs.markets, p.marketsCents)} sub={typicalSub(t?.marketsCents) ?? "growth, net of fees"} />
        <StatCell label="Closing" value={usd0(p.closingCents)} proof={proofOf(p.proofs.closing, p.closingCents)} sub={`end of ${p.through ?? p.end}`} />
      </StatGrid>

      <Card title="From opening to closing" subtitle="Each bar starts where the one before it ends; the last is the whole change. Hover a step's name in the table below for what it holds.">
        <Waterfall p={p} />
      </Card>

      <Card title={t ? `Against your average ${unit}` : "Step by step"} subtitle="Click a figure for the rows behind it. Steps without their own proof are parts of the change's proof (click Change above).">
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[34rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Step</th>
                <th className={table.thR}>{p.label}</th>
                {t && <th className={table.thR}>Average</th>}
                {t && <th className={table.thR}>Difference</th>}
              </tr>
            </thead>
            <tbody>
              {p.steps.map((s) => (
                <tr key={s.key} className={table.trHover}>
                  <td className={table.td}>
                    <span title={s.note} className="cursor-help">
                      {s.label}
                    </span>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={proofOf(s.proof, s.key === "spending" ? p.spendingCents : s.cents)}>{s.key === "spending" ? usd0(p.spendingCents) : usd0(s.cents)}</ProofValue>
                  </td>
                  {t && <td className={`${table.tdR} text-muted`}>{s.typicalCents == null ? "—" : s.key === "spending" ? usd0(-s.typicalCents) : usd0(s.typicalCents)}</td>}
                  {t && (
                    <td className={table.tdR}>
                      <Delta cents={s.typicalCents == null ? null : s.cents - s.typicalCents} />
                    </td>
                  )}
                </tr>
              ))}
              <tr className="border-t border-line-strong font-semibold">
                <td className={table.td}>Change</td>
                <td className={table.tdR}>
                  <ProofValue proof={proofOf(p.proofs.change, p.changeCents)}>{usd0(p.changeCents)}</ProofValue>
                </td>
                {t && <td className={`${table.tdR} text-muted`}>{usd0(t.changeCents)}</td>}
                {t && (
                  <td className={table.tdR}>
                    <Delta cents={p.changeCents - t.changeCents} />
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {t && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Movers title="Spending that moved most" empty={`No spending category moved much against its average ${unit}.`} rows={p.spendingMovers} spending />
          <Movers title="Income that moved most" empty={`No income category moved much against its average ${unit}.`} rows={p.incomeMovers} />
        </div>
      )}
    </>
  );
}

function Movers({ title, empty, rows, spending = false }: { title: string; empty: string; rows: ChangeMover[]; spending?: boolean }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">{empty}</p>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Category</th>
                <th className={table.thR}>This period</th>
                <th className={table.thR}>Average</th>
                <th className={table.thR}>Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.category} className={table.trHover}>
                  <td className={table.td}>{m.category}</td>
                  <td className={table.tdR}>
                    <ProofValue proof={proofOf(m.proof, m.cents)}>{usd0(m.cents)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} text-muted`}>{usd0(m.typicalCents)}</td>
                  <td className={table.tdR}>
                    {/* More spending is worse for net worth; more income better. */}
                    <Delta cents={spending ? -m.deltaCents : m.deltaCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Waterfall({ p }: { p: NetWorthChange }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  // Each bar floats from its step's start to its end: an invisible base, then the step's size.
  const rows = useMemo(
    () => [
      ...p.steps.map((s) => ({ label: s.label, base: Math.min(s.fromCents, s.toCents) / 100, size: Math.abs(s.cents) / 100, cents: s.cents, kind: s.cents >= 0 ? "up" : "down" })),
      { label: "Change", base: Math.min(0, p.changeCents) / 100, size: Math.abs(p.changeCents) / 100, cents: p.changeCents, kind: "total" },
    ],
    [p],
  );
  const fill = (kind: string) => (kind === "total" ? chart.lineBalance : kind === "up" ? chart.principal : chart.debt);
  return (
    <div className="h-[300px] w-full min-w-0">
      <RechartsResponsive>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...ui.grid} />
          <XAxis dataKey="label" {...ui.xAxis} interval={0} />
          <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
          <ReferenceLine y={0} stroke={chart.axisLine} />
          <Tooltip
            {...ui.tooltip}
            formatter={(_v, name, item) => (name === "base" ? [null, null] : [formatUsd(Math.round(Number((item.payload as { cents: number }).cents) / 100)), "Change"])}
          />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="size" stackId="w" maxBarSize={56} isAnimationActive={false}>
            {rows.map((row) => (
              <Cell key={row.label} fill={fill(row.kind)} />
            ))}
          </Bar>
        </BarChart>
      </RechartsResponsive>
    </div>
  );
}
