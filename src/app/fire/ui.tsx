"use client";

import { Segmented } from "@/components/ui/kit";
import type { FireAnalysis } from "@/lib/fire/fire";
import { formatPercentRatio, formatUsd, usd0 } from "@/lib/formatMoney";
import type { OutlookPlan } from "@/lib/profile/outlook";

/** Whole dollars from cents. */
export const usd = usd0;
export const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : formatPercentRatio(r, digits));
/** $1.25M / $480k / $900 from cents. */
export function short(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const d = cents / 100;
  const a = Math.abs(d);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}k` : `$${Math.round(a)}`;
  return d < 0 ? `−${s}` : s;
}
/** Tooltip formatter: whole dollars. */
export const tipUsd = (v: unknown) => formatUsd(Math.round(Number(v)));

export type Dollars = "nominal" | "real";

/** Divisor turning a future (nominal) amount on Jan 1 of `year` into start-year dollars. */
export const deflator = (plan: OutlookPlan, dollars: Dollars, year: number) => (dollars === "real" ? (1 + plan.inflation) ** (year - plan.start.year) : 1);

export function DollarsToggle({ value, onChange }: { value: Dollars; onChange: (d: Dollars) => void }) {
  return (
    <Segmented
      size="xs"
      ariaLabel="Dollars"
      options={[
        { value: "nominal", label: "Future $" },
        { value: "real", label: "Today's $" },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** "2034 (age 41)" or "2034". */
export const yearAge = (year: number | null | undefined, plan: OutlookPlan) =>
  year == null ? "—" : plan.birthYear != null ? `${year} (age ${year - plan.birthYear})` : String(year);

/** "in 8 years" relative to the plan's first year. */
export const yearsFrom = (year: number | null | undefined, plan: OutlookPlan) => {
  if (year == null) return "not within 60 years";
  const n = year - plan.start.year;
  return n <= 0 ? "already there" : `in ${n} year${n === 1 ? "" : "s"}`;
};

export type FireProps = { f: FireAnalysis; dollars: Dollars; setDollars: (d: Dollars) => void };
