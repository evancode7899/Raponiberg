"use client";

import type { ChartPalette } from "@/components/shell/chartPalette";
import { EM_DASH } from "@/lib/formatMoney";
import type { CostLine } from "@/lib/car/report";
import { useState } from "react";

/**
 * Chart buckets: the cost lines folded into seven, each with a fixed palette slot, so a
 * cost keeps its color on every chart. Tables list every line.
 */
export type Bucket = "DEPRECIATION" | "FUEL" | "UPKEEP" | "INSURANCE" | "PARKING" | "TAX_REG" | "OTHER";

export const BUCKETS: { id: Bucket; label: string; lines: CostLine[] }[] = [
  { id: "DEPRECIATION", label: "Depreciation", lines: ["DEPRECIATION"] },
  { id: "INSURANCE", label: "Insurance", lines: ["INSURANCE"] },
  { id: "PARKING", label: "Parking", lines: ["PARKING"] },
  { id: "FUEL", label: "Fuel", lines: ["FUEL"] },
  { id: "UPKEEP", label: "Maintenance, repairs & care", lines: ["MAINTENANCE", "REPAIR", "CARE"] },
  { id: "TAX_REG", label: "Taxes & registration", lines: ["TAX_REG"] },
  { id: "OTHER", label: "Interest, tolls & other", lines: ["INTEREST", "TOLLS", "EQUIPMENT", "OTHER"] },
];

const SLOT: Record<Bucket, number | null> = { DEPRECIATION: 6, INSURANCE: 0, PARKING: 3, FUEL: 1, UPKEEP: 2, TAX_REG: 4, OTHER: null };

export function bucketColor(p: ChartPalette, b: Bucket): string {
  const s = SLOT[b];
  return s == null ? p.neutral : p.series[s]!;
}

export function bucketOf(line: CostLine): Bucket {
  return BUCKETS.find((b) => b.lines.includes(line))!.id;
}

export function byBucket(lines: Partial<Record<CostLine, number>>): Record<Bucket, number> {
  const out = Object.fromEntries(BUCKETS.map((b) => [b.id, 0])) as Record<Bucket, number>;
  for (const [l, c] of Object.entries(lines) as [CostLine, number][]) out[bucketOf(l)] += c ?? 0;
  return out;
}

/** Cents per mile as "$0.17". */
export function perMile(cents: number | null | undefined, digits = 2): string {
  if (cents == null || !Number.isFinite(cents)) return EM_DASH;
  return `$${(cents / 100).toFixed(digits)}`;
}

/** Cents with exactly two decimals, no accounting parentheses: "$26.25". */
export function usd2(cents: number | null | undefined): string {
  if (cents == null) return EM_DASH;
  const s = `$${Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return cents < 0 ? `−${s}` : s;
}

export function fmtDate(iso: string | null | undefined, style: "short" | "long" = "long"): string {
  if (!iso) return EM_DASH;
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", style === "long" ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", year: "numeric" });
}

export const miles = (n: number | null | undefined, digits = 0) => (n == null || !Number.isFinite(n) ? EM_DASH : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));

/** Months between today and a date, as words ("in 3 months", "2 months ago"). */
export function relative(iso: string | null, today: string): string {
  if (!iso) return "";
  const days = Math.round((Date.parse(iso) - Date.parse(today)) / 86_400_000);
  const abs = Math.abs(days);
  const body = abs < 45 ? `${abs} day${abs === 1 ? "" : "s"}` : abs < 600 ? `${Math.round(abs / 30.4)} months` : `${(abs / 365.25).toFixed(1)} years`;
  return days === 0 ? "today" : days > 0 ? `in ${body}` : `${body} ago`;
}

/**
 * When the odometer reaches a mileage at the current pace. A date already behind us means
 * the last reading is old: the car has probably passed it.
 */
export function etaText(eta: string | null, today: string): string {
  if (!eta) return "";
  return eta < today ? `probably reached around ${fmtDate(eta)} (log an odometer reading)` : `around ${fmtDate(eta)} (${relative(eta, today)})`;
}

/** Dollars-and-cents input bound to cents (blank → null). Commits on blur or Enter. */
export function CentsInput({ cents, onChange, className = "", ariaLabel, placeholder }: { cents: number | null; onChange: (c: number | null) => void; className?: string; ariaLabel?: string; placeholder?: string }) {
  const show = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
  // The text being typed while the field has focus; otherwise the field shows `cents`.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? show(cents);
  return (
    <div className={`flex min-w-0 items-center rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent ${className}`}>
      <span className="select-none text-faint">$</span>
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="num w-full min-w-0 bg-transparent px-1 py-1.5 text-right text-sm text-fg outline-none placeholder:text-faint"
        value={text}
        onFocus={(e) => {
          setDraft(show(cents));
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(text.replace(/[^\d.-]/g, ""));
          onChange(text.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100));
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

/** Plain number input (odometer, gallons); blank → null. */
export function NumInput({ value, onChange, className = "", step, ariaLabel, placeholder, suffix }: { value: number | null; onChange: (n: number | null) => void; className?: string; step?: number; ariaLabel?: string; placeholder?: string; suffix?: string }) {
  return (
    <div className={`flex min-w-0 items-center rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent ${className}`}>
      <input
        type="number"
        step={step ?? "any"}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="num w-full min-w-0 bg-transparent py-1.5 text-right text-sm text-fg outline-none placeholder:text-faint [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {suffix && <span className="select-none pl-1 text-xs text-faint">{suffix}</span>}
    </div>
  );
}

export function Swatch({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} aria-hidden />;
}
