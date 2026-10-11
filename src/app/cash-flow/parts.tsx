"use client";

import { blockedTitle } from "@/components/ledger/Blocked";
import { TransactionTable, type TxnRow } from "@/components/ledger/TransactionTable";
import type { Api } from "@/components/ledger/useApi";
import type { ChartPalette } from "@/components/shell/chartPalette";
import { btn, Loading } from "@/components/ui/kit";
import type { WithheldMonth } from "@/lib/book/reports/spending";
import { formatPercentRatio, usd0 } from "@/lib/formatMoney";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { categorySlot } from "./model";

export const categoryColor = (chart: ChartPalette, category: string) => {
  const s = categorySlot(category);
  return s == null ? chart.neutral : chart.series[s]!;
};

export function Dot({ color, className = "" }: { color: string; className?: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ${className}`} style={{ background: color }} />;
}

/** Tiny trend line; the last point is marked. */
export function Sparkline({ values, color, width = 84, height = 22 }: { values: number[]; color: string; width?: number; height?: number }) {
  if (values.length < 2) return <span className="inline-block" style={{ width, height }} />;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 4);
  const y = (v: number) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0 overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values.at(-1)!)} r={2.25} fill={color} />
    </svg>
  );
}

/**
 * A change between two figures. For spending, up is bad (`goodWhenDown`); the arrow and
 * sign carry the direction so it never rests on color alone.
 */
export function Delta({ now, before, goodWhenDown = false, asPercent = true }: { now: number; before: number | null; goodWhenDown?: boolean; asPercent?: boolean }) {
  if (before == null) return <span className="text-xs text-faint">—</span>;
  const diff = now - before;
  if (Math.abs(diff) < 100 || (before !== 0 && Math.abs(diff / before) < 0.02)) return <span className="text-xs text-muted">≈ same</span>;
  const up = diff > 0;
  const good = goodWhenDown ? !up : up;
  const text = asPercent && before > 0 ? formatPercentRatio(Math.abs(diff / before), 0) : usd0(Math.abs(diff));
  return (
    <span className={`num whitespace-nowrap text-xs font-medium ${good ? "text-pos" : "text-neg"}`}>
      {up ? "▲" : "▼"} {text}
    </span>
  );
}

/** Horizontal share bar. */
export function Bar({ ratio, color, marker }: { ratio: number; color: string; marker?: number | null }) {
  return (
    <span className="relative block h-2 w-full rounded-sm bg-surface-3">
      <span className="block h-full rounded-sm" style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%`, background: color }} />
      {marker != null && marker > 0 && (
        <span aria-hidden className="absolute -top-1 bottom-[-4px] w-0.5 rounded bg-fg" style={{ left: `calc(${Math.min(100, marker * 100)}% - 1px)` }} title="Target" />
      )}
    </span>
  );
}

/** A compact line naming the months that aren't proven yet, and why. */
export function WithheldStrip({ after, before, through }: { after: WithheldMonth[]; before: WithheldMonth | null; through: string | null }) {
  if (!after.length && !before) return null;
  const items: ReactNode[] = [];
  if (after.length) {
    const blockers = [...new Map(after.flatMap((w) => w.blockers).map((b) => [b.id, b])).values()];
    items.push(
      <span key="after" title={blockedTitle(blockers)} className="cursor-help">
        <span className="font-medium text-warn">{after.map((w) => w.label).join(", ")}</span> waiting on {blockers.length} item{blockers.length === 1 ? "" : "s"} (
        {blockers[0]!.title}
        {blockers.length > 1 ? ", …" : ""})
      </span>,
    );
  }
  if (before) {
    items.push(
      <span key="before" title={blockedTitle(before.blockers)} className="cursor-help">
        history before {before.label === "" ? "the window" : nextMonthLabel(before.label)} is withheld ({before.blockers[0]?.title})
      </span>,
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
      <span className="font-medium text-fg-2">Proven through {through ?? "—"}.</span>
      {items.map((x, i) => (
        <span key={i}>
          {i ? "· " : ""}
          {x}
        </span>
      ))}
      <Link href="/statements?tab=issues" className={`${btn.link} ml-auto`}>
        Issues →
      </Link>
    </div>
  );
}

const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function nextMonthLabel(label: string) {
  const [m, y] = label.split(" ");
  const i = NAMES.indexOf(m!);
  return i === 11 ? `Jan ${Number(y) + 1}` : `${NAMES[i + 1]} ${y}`;
}

export type TxnQuery = { from: string; to: string; category?: string; lane?: string; q?: string };

/** The ledger rows behind a figure, editable in place. */
export function TxnList({ api, query, onChanged }: { api: Api; query: TxnQuery; onChanged: () => void }) {
  const [rows, setRows] = useState<TxnRow[] | null>(null);
  const [total, setTotal] = useState<{ count: number; inCents: number; outCents: number } | null>(null);
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]);
  const key = qs.toString();
  const load = useCallback(() => {
    const sp = new URLSearchParams(key);
    sp.set("limit", "2000");
    api
      .call<{ transactions: TxnRow[]; total: { count: number; inCents: number; outCents: number } }>(`/api/transactions?${sp}`)
      .then((r) => {
        setRows(r.transactions);
        setTotal(r.total);
      })
      .catch(() => setRows([]));
  }, [api, key]);
  useEffect(load, [load]);
  if (!rows) return <Loading />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span className="num">
          {total?.count ?? rows.length} transactions · net {usd0((total?.inCents ?? 0) + (total?.outCents ?? 0))}
        </span>
        <Link href={`/transactions?${key}`} className={btn.link}>
          Open in Transactions →
        </Link>
      </div>
      <TransactionTable
        api={api}
        rows={rows}
        maxHeight="60vh"
        onChanged={() => {
          load();
          onChanged();
        }}
      />
    </div>
  );
}

/** Small uppercase heading inside a card. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{children}</div>;
}

/**
 * A bar growing left or right from a center line: increases (bad for spending) to the
 * right in the negative tone, decreases to the left in the positive one.
 */
export function DivergingBar({ value, max, goodWhenDown = true }: { value: number; max: number; goodWhenDown?: boolean }) {
  const w = max > 0 ? Math.min(50, (Math.abs(value) / max) * 50) : 0;
  const bad = goodWhenDown ? value > 0 : value < 0;
  return (
    <span className="relative block h-2.5 w-full min-w-[6rem]">
      <span aria-hidden className="absolute inset-y-[-3px] left-1/2 w-px bg-line-strong" />
      <span
        aria-hidden
        className={`absolute inset-y-0 rounded-sm ${bad ? "bg-neg" : "bg-pos"}`}
        style={value >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
      />
    </span>
  );
}
