"use client";

import { formatPercentRatio, usd0 } from "@/lib/formatMoney";

export type ShareSegment = { id: string; label: string; cents: number; color: string };

/**
 * One 100% bar split into segments (an allocation), with a 2px surface gap between
 * them and a hover title on each. Always shown next to a labelled list or table, so
 * no segment is identified by color alone. Negative amounts (a short option) are left
 * out of the bar but stay in the list.
 */
export function ShareBar({ segments, height = 14, label }: { segments: ShareSegment[]; height?: number; label: string }) {
  const positive = segments.filter((s) => s.cents > 0);
  const total = positive.reduce((s, x) => s + x.cents, 0);
  if (!total) return null;
  return (
    <div role="img" aria-label={label} className="flex w-full gap-[2px] overflow-hidden rounded" style={{ height }}>
      {positive.map((s) => (
        <div
          key={s.id}
          title={`${s.label}: ${usd0(s.cents)} (${formatPercentRatio(s.cents / total, 1)})`}
          className="h-full min-w-[2px] transition-opacity hover:opacity-80"
          style={{ width: `${(s.cents / total) * 100}%`, background: s.color }}
        />
      ))}
    </div>
  );
}

/** Legend row for a ShareBar: swatch, label, amount and share, in text colors. */
export function ShareLegend({ segments }: { segments: ShareSegment[] }) {
  const total = segments.filter((s) => s.cents > 0).reduce((s, x) => s + x.cents, 0);
  return (
    <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      {segments.map((s) => (
        <li key={s.id} className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-fg-2">{s.label}</span>
          <span className="num text-fg">{usd0(s.cents)}</span>
          <span className="num w-12 text-right text-muted">{total ? formatPercentRatio(s.cents / total, 1) : "—"}</span>
        </li>
      ))}
    </ul>
  );
}
