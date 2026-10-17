"use client";

import { formatUsd } from "@/lib/formatMoney";
import type { ReactNode } from "react";

export type Segment = { key: string; label: string; value: number; color: string };

/**
 * One horizontal bar split into segments, with an optional marker (a cap or a budget)
 * and a legend listing each segment's amount and share.
 */
export function StackBar({
  segments,
  marker,
  scale,
  legend = true,
  overLabel,
}: {
  segments: Segment[];
  marker?: { value: number; label: string };
  /** Full width of the bar; default: the larger of the total and the marker. */
  scale?: number;
  legend?: boolean;
  /** Shown when the total runs past the marker. */
  overLabel?: (over: number) => ReactNode;
}) {
  const shown = segments.filter((s) => s.value > 0.5);
  const total = shown.reduce((s, x) => s + x.value, 0);
  const full = scale ?? Math.max(total, marker?.value ?? 0) * 1.04;
  const pct = (v: number) => (full > 0 ? (v / full) * 100 : 0);
  const over = marker ? total - marker.value : 0;
  return (
    <div className="min-w-0">
      <div className="relative pt-5">
        {marker && (
          // Anchor the label on whichever side keeps it inside the bar.
          <div
            className={`absolute top-0 whitespace-nowrap text-[10px] font-medium text-fg-2 ${pct(marker.value) > 70 ? "-translate-x-full pr-1" : pct(marker.value) < 30 ? "pl-1" : "-translate-x-1/2"}`}
            style={{ left: `${pct(marker.value)}%` }}
          >
            {marker.label}
          </div>
        )}
        <div className="flex h-7 w-full overflow-hidden rounded-md bg-surface-3">
          {shown.map((s) => (
            <div key={s.key} title={`${s.label}: ${formatUsd(s.value)}`} className="h-full border-r border-surface last:border-r-0" style={{ width: `${pct(s.value)}%`, background: s.color }} />
          ))}
        </div>
        {marker && <div className="pointer-events-none absolute bottom-[-4px] top-4 w-0.5 -translate-x-1/2 rounded bg-fg" style={{ left: `${pct(marker.value)}%` }} />}
      </div>
      {marker && overLabel && over > 0.5 && <div className="mt-2 text-xs font-medium text-neg">{overLabel(over)}</div>}
      {legend && (
        <ul className="mt-3 grid gap-x-6 gap-y-1 text-xs [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
          {shown.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-fg-2">{s.label}</span>
              <span className="num font-medium text-fg">{formatUsd(s.value)}</span>
              <span className="num w-10 text-right text-faint">{total > 0 ? `${Math.round((s.value / total) * 100)}%` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** All-in housing as a share of gross pay: the comfort tiers either side of your own limit (lender rules live in the Lender view). */
export const COMFORTABLE_SHARE = 0.28;
export const STRETCH_SHARE = 0.43;

export type TierKey = "comfortable" | "limit" | "stretch";
export type Tier = { key: TierKey; label: string; share: number; note: string };

/** Affordability tiers around the household's own housing limit. */
export function tiersFor(cap: number): Tier[] {
  const out: Tier[] = [];
  if (COMFORTABLE_SHARE < cap - 0.0025) out.push({ key: "comfortable", label: "Comfortable", share: COMFORTABLE_SHARE, note: "all-in" });
  out.push({ key: "limit", label: "Your limit", share: cap, note: "your setting" });
  if (STRETCH_SHARE > cap + 0.0025) out.push({ key: "stretch", label: "Stretch", share: STRETCH_SHARE, note: "all-in" });
  return out;
}

export type Stress = { label: string; tone: "pos" | "accent" | "warn" | "neg"; zone: string };

/** Where a housing share of gross falls against the tiers. */
export function stressOf(share: number, cap: number): Stress {
  const comfy = Math.min(COMFORTABLE_SHARE, cap);
  const stretch = Math.max(STRETCH_SHARE, cap);
  // Half a tenth of a point of slack so a price rounded to the dollar still reads as on its tier.
  const eps = 0.0005;
  if (share <= comfy + eps) return { label: "Comfortable", tone: "pos", zone: "bg-pos" };
  if (share <= cap + eps) return { label: "Within your limit", tone: "accent", zone: "bg-accent" };
  if (share <= stretch + eps) return { label: "Stretch", tone: "warn", zone: "bg-warn" };
  return { label: "Over the ceiling", tone: "neg", zone: "bg-neg" };
}

export type SpendingFit = { label: string; tone: "pos" | "warn" | "neg" };

/**
 * Does what's left after tax, housing and the savings target cover what the household
 * spends today outside housing? `left` and `spend` are dollars a month; `spend` is the
 * average of the latest proven months with one-offs and housing & utilities left out.
 */
export function spendingFit(left: number, spend: number): SpendingFit {
  // A 10% cushion over today's spending reads as covered; within 10% under it, tight.
  if (left >= spend * (1 + SPEND_CUSHION)) return { label: "Covers it", tone: "pos" };
  if (left >= spend * (1 - SPEND_CUSHION)) return { label: "Tight", tone: "warn" };
  return { label: "Short", tone: "neg" };
}

/** Months vary, so a verdict needs slack either side of today's average spending. */
const SPEND_CUSHION = 0.1;

/**
 * Housing as a share of gross pay on a zoned scale (comfortable / your limit / stretch /
 * over). Below each threshold, the home price that would land on it.
 */
export function StressGauge({ share, cap, priceAt, youLabel }: { share: number; cap: number; priceAt?: (share: number) => number; youLabel: string }) {
  const comfy = Math.min(COMFORTABLE_SHARE, cap);
  const stretch = Math.max(STRETCH_SHARE, cap);
  const full = Math.max(0.55, share * 1.08);
  const pos = (v: number) => `${(Math.min(full, Math.max(0, v)) / full) * 100}%`;
  const zones = [
    { from: 0, to: comfy, cls: "bg-pos/40" },
    { from: comfy, to: cap, cls: "bg-accent/35" },
    { from: cap, to: stretch, cls: "bg-warn/40" },
    { from: stretch, to: full, cls: "bg-neg/30" },
  ].filter((z) => z.to - z.from > 1e-6);
  const ticks = [...new Set([comfy, cap, stretch])];
  const pctLabel = (v: number) => `${+(v * 100).toFixed(1)}%`;
  const k = (v: number) => (v >= 1_000_000 ? `$${+(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}k`);
  return (
    <div className="min-w-0 px-1">
      <div className="relative h-6">
        <div className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-fg" style={{ left: pos(share) }}>
          {youLabel} ▾
        </div>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-surface-3">
        {zones.map((z) => (
          <div key={z.from} className={`absolute inset-y-0 ${z.cls}`} style={{ left: pos(z.from), width: `calc(${pos(z.to)} - ${pos(z.from)})` }} />
        ))}
        <div className="absolute inset-y-0 left-0 bg-fg/15" style={{ width: pos(share) }} />
      </div>
      <div className="relative">
        <div className="absolute -top-4 h-5 w-1 -translate-x-1/2 rounded-full bg-fg shadow" style={{ left: pos(share) }} />
      </div>
      <div className="relative mt-1.5 h-8 text-[10px] leading-tight">
        {ticks.map((t) => (
          <div key={t} className="absolute -translate-x-1/2 text-center" style={{ left: pos(t) }}>
            <div className="mx-auto mb-0.5 h-1.5 w-px bg-line-strong" />
            <div className="num font-medium text-fg-2">{pctLabel(t)}</div>
            {priceAt && <div className="num text-faint">{k(priceAt(t))}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A label / value line in a figures list. */
export function Row({ label, value, strong, tone, sub }: { label: ReactNode; value: ReactNode; strong?: boolean; tone?: "pos" | "neg" | "muted"; sub?: ReactNode }) {
  const toneCls = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "muted" ? "text-muted" : "text-fg";
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 text-xs ${strong ? "border-t border-line-strong pt-2" : ""}`}>
      <span className={`min-w-0 ${strong ? "font-semibold text-fg" : "text-fg-2"}`}>
        {label}
        {sub && <span className="block text-[11px] text-faint">{sub}</span>}
      </span>
      <span className={`num shrink-0 ${strong ? "text-sm font-semibold" : "font-medium"} ${toneCls}`}>{value}</span>
    </div>
  );
}

/** Small group heading inside a controls card. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-line pt-2 first:border-t-0 first:pt-0">
      <div className="pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-accent">{title}</div>
      <div className="divide-y divide-line/60">{children}</div>
    </div>
  );
}
