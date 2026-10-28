"use client";

import { inputCls } from "@/components/ui/kit";
import type { PeriodStatus } from "@/lib/cardPerks/report";
import type { CardPerksSettings } from "@/lib/cardPerks/settings";
import { formatUsdCents } from "@/lib/formatMoney";
import { useState } from "react";

/** Saves the whole setup; the page reloads the report after it. */
export type Save = (next: CardPerksSettings) => Promise<boolean>;

export const fmtPoints = (n: number) => `${Math.round(n).toLocaleString("en-US")} pts`;
export const fmtCpp = (cpp: number) => `${+cpp.toFixed(2)}¢`;
/** A perk amount: dollars for a USD perk, points for a POINTS perk. */
export const fmtAmount = (unit: "USD" | "POINTS", n: number) => (unit === "USD" ? formatUsdCents(n) : fmtPoints(n));

export const STATUS: Record<PeriodStatus, { label: string; cls: string }> = {
  USED: { label: "Used", cls: "bg-pos-soft text-pos border-pos/40" },
  PARTIAL: { label: "Partly used", cls: "bg-warn-soft text-warn border-warn/40" },
  MISSED: { label: "Missed", cls: "bg-neg-soft text-neg border-neg/40" },
  OPEN: { label: "Available now", cls: "bg-accent text-accent-fg border-accent" },
  AWAITING: { label: "Awaiting statement", cls: "bg-info-soft text-info border-info/40" },
  FUTURE: { label: "Coming up", cls: "bg-surface-2 text-faint border-line" },
  NOT_HELD: { label: "Card not held", cls: "border-dashed border-line text-faint" },
};

/** Used out of available, as a thin bar. */
export function Meter({ used, of, tone = "pos" }: { used: number; of: number; tone?: "pos" | "warn" | "neg" }) {
  const pct = of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 0;
  const bar = { pos: "bg-pos", warn: "bg-warn", neg: "bg-neg" }[tone];
  return (
    <div className="h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * A number typed freely and committed on blur or Enter: dollars and cents (scale 100, so
 * $12.95 is 1295) or plain numbers (scale 1). Blank commits null.
 */
export function NumberInput({
  value,
  onChange,
  scale = 1,
  prefix,
  suffix,
  placeholder,
  ariaLabel,
  className = "",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  scale?: number;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const shown = value == null ? "" : String(+(value / scale).toFixed(scale === 100 ? 2 : 4));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const t = (draft ?? shown).replace(/[$,\s]/g, "");
    const n = Number(t);
    onChange(t === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n * scale * 10_000) / 10_000);
  };
  return (
    <div className={`flex min-w-0 items-center rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent ${className}`}>
      {prefix && <span className="select-none text-faint">{prefix}</span>}
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        className="num w-full min-w-0 bg-transparent px-1 py-1 text-right text-xs text-fg outline-none placeholder:text-faint"
        value={draft ?? shown}
        placeholder={placeholder}
        onFocus={(e) => {
          setDraft(shown);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          commit();
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {suffix && <span className="select-none pl-1 text-faint">{suffix}</span>}
    </div>
  );
}

export const textCls = `${inputCls} w-full py-1 text-xs`;
