"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { MAP_TOP, merchantKeyOf, windowKey } from "@/lib/book/derived/cashFlow";
import { sumOf } from "@/components/ui/proof/context";
import { Card, inputCls, selectCls, StatCell, StatGrid, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { SpendingMonth } from "@/lib/book/reports/spending";
import { formatPercentRatio, usd0, usdCompact } from "@/lib/formatMoney";
import { Treemap, type TreemapNode } from "recharts";
import { useMemo, useState } from "react";
import type { Ctx } from "./CashFlowClient";
import { mergeMerchants, quietMerchants, sliceStart, SPEND_CATEGORIES, sum, totals, type MerchantTotal } from "./model";
import { categoryColor, Dot, Sparkline } from "./parts";

type SortKey = "cents" | "count" | "avg" | "months" | "name";

export function MerchantsTab({ ctx }: { ctx: Ctx }) {
  const { slice, chart } = ctx;
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cents", desc: true });
  const [limit, setLimit] = useState(50);
  const all = useMemo(() => mergeMerchants(slice.months), [slice]);
  const t = totals(slice.months);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const val = (m: MerchantTotal): number | string =>
      sort.key === "avg" ? m.cents / m.count : sort.key === "name" ? m.name.toLowerCase() : sort.key === "months" ? m.months : m[sort.key];
    return all
      .filter((m) => (!category || m.category === category) && (!needle || m.name.toLowerCase().includes(needle) || m.key.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const x = val(a);
        const y = val(b);
        const c = x < y ? -1 : x > y ? 1 : 0;
        return sort.desc ? -c : c;
      });
  }, [all, q, category, sort]);

  const top10 = sum(all.slice(0, 10), (m) => m.cents);
  const visits = sum(all, (m) => m.count);
  const max = Math.max(1, ...list.map((m) => m.cents));
  const head = (key: SortKey, label: string, right = true) => (
    <th className={right ? table.thR : table.th} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button type="button" className="uppercase tracking-wide hover:text-fg" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  const mid = all[Math.floor(all.length / 2)];
  return (
    <>
      <StatGrid cols={4}>
        <StatCell proof={ctx.dp("merchants", windowKey(slice.months))} label="Merchants" value={all.length.toLocaleString("en-US")} sub={`${visits.toLocaleString("en-US")} charges in ${slice.label}`} />
        <StatCell proof={ctx.dp("top10-share", windowKey(slice.months))} label="Top 10 merchants" value={t.spending > 0 ? formatPercentRatio(top10 / t.spending, 0) : "—"} sub={<>of spending · <ProofValue proof={sumOf(all.slice(0, 10).map((m) => ctx.proof("spending", slice.months, { merchantKey: m.key, shownCents: m.cents })), top10)}>{usd0(top10)}</ProofValue></>} />
        <StatCell proof={ctx.dp("avg-charge", windowKey(slice.months))} label="Average charge" value={usd0(visits ? sum(all, (m) => m.cents) / visits : 0)} sub={mid ? <>half of merchants got under <ProofValue proof={ctx.proof("spending", slice.months, { merchantKey: mid.key, shownCents: mid.cents })}>{usd0(mid.cents)}</ProofValue> in total</> : undefined} />
        <StatCell proof={ctx.dp("charges-per-month", windowKey(slice.months))} label="Charges / month" value={Math.round(visits / Math.max(1, t.n)).toLocaleString("en-US")} sub={`${(visits / Math.max(1, t.n) / 30).toFixed(1)} a day`} />
      </StatGrid>

      <MerchantMap ctx={ctx} merchants={all} total={t.spending} />
      <NewAndQuiet ctx={ctx} />

      <Card
        title="Merchants"
        subtitle="Spending net of merchant refunds, grouped by merchant (tax refunds count as income). Click a merchant for its charges and month-by-month trend."
        actions={
          <>
            <input className={`${inputCls} !py-1 !text-xs w-48`} placeholder="Search merchants…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search merchants" />
            <select data-audit-view="" className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {SPEND_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </>
        }
      >
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[58rem]`}>
            <thead className={table.head}>
              <tr>
                {head("name", "Merchant", false)}
                <th className={table.th}>Category</th>
                <th className={table.th}>Trend</th>
                {head("cents", "Total")}
                <th className={table.th} />
                {head("count", "Charges")}
                {head("avg", "Avg charge")}
                {head("months", "Months")}
                <th className={table.th}>Pattern</th>
                <th className={table.thR}>Last</th>
              </tr>
            </thead>
            <tbody>
              {/* The render audit opens the first few merchants' drawers: every row's figures are in the table. */}
              {list.slice(0, limit).map((m, i) => (
                <tr key={m.key} className={`${table.trHover} cursor-pointer`} onClick={() => ctx.open({ kind: "merchant", key: m.key, name: m.name, lane: "EXPENSE" })}>
                  <td className={`${table.td} max-w-[16rem] truncate font-medium`} title={m.key} {...(i < 3 ? { "data-audit-drill": m.name } : {})}>
                    {m.name}
                  </td>
                  <td className={`${table.td} whitespace-nowrap text-xs text-fg-2`}>
                    <span className="flex items-center gap-1.5">
                      <Dot color={categoryColor(chart, m.category)} className="!h-2 !w-2" />
                      {m.category}
                    </span>
                  </td>
                  <td className={table.td}>
                    <Sparkline values={m.series} color={categoryColor(chart, m.category)} width={72} height={18} />
                  </td>
                  <td className={`${table.tdR} font-medium`}>
                    <ProofValue proof={ctx.proof("spending", slice.months, { merchantKey: m.key, shownCents: m.cents })}>{usd0(m.cents)}</ProofValue>
                  </td>
                  <td className={`${table.td} w-28`}>
                    <span className="block h-1.5 rounded-sm bg-surface-3">
                      <span className="block h-full rounded-sm" style={{ width: `${(m.cents / max) * 100}%`, background: categoryColor(chart, m.category) }} />
                    </span>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={ctx.dp("merchant-count", merchantKeyOf(slice.months, "EXPENSE", m.key))}>{m.count}</ProofValue>
                  </td>
                  <td className={`${table.tdR} text-muted`}>
                    <ProofValue proof={ctx.dp("merchant-avg", merchantKeyOf(slice.months, "EXPENSE", m.key))}>{usd0(m.cents / m.count)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} text-muted`}>
                    {m.months}/{t.n}
                  </td>
                  <td className={`${table.td} text-xs text-muted`}>
                    <ProofValue proof={ctx.dp("merchant-pattern", merchantKeyOf(slice.months, "EXPENSE", m.key))}>{ctx.words("merchant-pattern", merchantKeyOf(slice.months, "EXPENSE", m.key))}</ProofValue>
                  </td>
                  <td className={`${table.tdR} whitespace-nowrap text-xs text-muted`}>{m.lastMonth}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <p className="py-4 text-sm text-muted">No merchant matches.</p>}
          {list.length > limit && (
            <button type="button" className="mt-2 text-xs font-medium text-accent hover:underline" onClick={() => setLimit((l) => l + 100)} data-audit-more="">
              Show more ({list.length - limit} left)
            </button>
          )}
        </div>
      </Card>
    </>
  );
}

type Tile = { name: string; key: string; size: number; color: string; category: string };

/** The biggest merchants as tiles sized by spending and colored by category. */
function MerchantMap({ ctx, merchants, total }: { ctx: Ctx; merchants: MerchantTotal[]; total: number }) {
  const { chart } = ctx;
  const top = merchants.slice(0, MAP_TOP);
  const rest = sum(merchants.slice(MAP_TOP), (m) => m.cents);
  const data: Tile[] = top.map((m) => ({ name: m.name, key: m.key, size: m.cents, color: categoryColor(chart, m.category), category: m.category }));
  const Content = (p: TreemapNode) => {
    const t = p as unknown as TreemapNode & Tile;
    if (p.depth !== 1) return <g />;
    const big = p.width > 70 && p.height > 34;
    return (
      <g style={{ cursor: "pointer" }}>
        <rect x={p.x} y={p.y} width={p.width} height={p.height} rx={3} fill={t.color} fillOpacity={0.88} stroke={chart.tooltipBg} strokeWidth={2} />
        {big && (
          <>
            <text x={p.x + 6} y={p.y + 15} fill="#fff" fontSize={11} fontWeight={600}>
              {t.name.length * 6.2 > p.width - 10 ? `${t.name.slice(0, Math.max(3, Math.floor((p.width - 16) / 6.2)))}…` : t.name}
            </text>
            <text x={p.x + 6} y={p.y + 29} fill="#fff" fillOpacity={0.85} fontSize={10}>
              {usdCompact(t.size)}
            </text>
          </>
        )}
        <title>{`${t.name} · ${t.category} · ${usd0(t.size)}${total > 0 ? ` (${formatPercentRatio(t.size / total, 1)})` : ""}`}</title>
      </g>
    );
  };
  return (
    <Card
      title="Where it goes"
      subtitle={
        <>
          The {top.length} biggest merchants, sized by spending and colored by category — {total > 0 ? <ProofValue proof={ctx.dp("map-share", windowKey(ctx.slice.months))}>{formatPercentRatio(sum(top, (m) => m.cents) / total, 0)}</ProofValue> : "—"} of all spending
          {rest > 0 ? (
            <>
              ; <ProofValue proof={ctx.dp("map-rest", windowKey(ctx.slice.months))}>{usd0(rest)}</ProofValue> more across {merchants.length - top.length} others
            </>
          ) : null}
          . Click a tile for its charges.
        </>
      }
    >
      <div className="h-[340px] w-full min-w-0">
        <RechartsResponsive>
          <Treemap
            data={data}
            dataKey="size"
            nameKey="name"
            aspectRatio={1.6}
            isAnimationActive={false}
            content={Content}
            onClick={(n) => {
              const t = n as unknown as Tile;
              if (t.key) ctx.open({ kind: "merchant", key: t.key, name: t.name, lane: "EXPENSE" });
            }}
          />
        </RechartsResponsive>
      </div>
    </Card>
  );
}

/**
 * Merchants that are new in the range (never charged in any proven month before it) and
 * ones that went quiet (charged in at least three of the twelve months before, none since).
 */
function NewAndQuiet({ ctx }: { ctx: Ctx }) {
  const { report, slice, chart } = ctx;
  const lo = sliceStart(report, slice);
  const earlier = report.months.slice(0, lo);
  const recent = report.months.slice(Math.max(0, lo - 12), lo);
  const inSlice = mergeMerchants(slice.months);
  const seenBefore = new Set(earlier.flatMap((m) => m.merchants.map((x) => x.key)));
  const fresh = earlier.length >= 6 ? inSlice.filter((m) => !seenBefore.has(m.key)) : [];
  // The ten biggest (quietMerchants: the list the proof sweep enumerates too).
  const quiet = quietMerchants(recent, slice.months);
  // Each figure is the merchant's total over the months it was summed over, per month.
  const list = (rows: MerchantTotal[], months: SpendingMonth[], empty: string) =>
    rows.length === 0 ? (
      <p className="text-xs text-muted">{empty}</p>
    ) : (
      <ul className="flex flex-col divide-y divide-line text-[13px]">
        {rows.slice(0, 10).map((m) => (
          <li key={m.key} className="flex items-center justify-between gap-3 py-1.5">
            <button type="button" className="flex min-w-0 items-center gap-2 text-left hover:text-accent" onClick={() => ctx.open({ kind: "merchant", key: m.key, name: m.name, lane: "EXPENSE" })}>
              <Dot color={categoryColor(chart, m.category)} className="!h-2 !w-2" />
              <span className="truncate">{m.name}</span>
            </button>
            <span className="num shrink-0 text-xs text-muted">
              <ProofValue proof={ctx.proof("spending", months, { merchantKey: m.key, perMonth: true, shownCents: m.cents })} className="text-fg">
                {usd0(m.cents / Math.max(1, months.length))}
              </ProofValue>
              /mo · {m.count}× · last {m.lastMonth}
            </span>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
      <Card
        title={`New in ${slice.label}`}
        subtitle={
          earlier.length >= 6
            ? (
                <>
                  {fresh.length} merchant{fresh.length === 1 ? "" : "s"} never charged in the {earlier.length} proven months before —{" "}
                  <ProofValue proof={sumOf(fresh.map((m) => ctx.proof("spending", slice.months, { merchantKey: m.key, shownCents: m.cents })), sum(fresh, (m) => m.cents))}>{usd0(sum(fresh, (m) => m.cents))}</ProofValue> in all. New habits and subscriptions start here.
                </>
              )
            : "Needs six proven months before the range starts. Pick a shorter range."
        }
      >
        {earlier.length >= 6 && list(fresh, slice.months, "No new merchants.")}
      </Card>
      <Card
        title="Gone quiet"
        subtitle={
          recent.length >= 3
            ? `Charged in 3+ of the ${recent.length} months before ${slice.months[0]!.label}, and not once since. Cancelled, moved to an untracked card, or just stopped going.`
            : "Needs proven months before the range starts. Pick a shorter range."
        }
      >
        {recent.length >= 3 && list(quiet, recent, "Nothing went quiet.")}
      </Card>
    </div>
  );
}
