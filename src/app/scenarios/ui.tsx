"use client";

import { EM_DASH, NA, usdCompact } from "@/lib/formatMoney";
import { useState, type ReactNode } from "react";

/** Small, dense controls and formats for the Scenarios page (Terminal density first). */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2027-03" → "Mar 2027". */
export const monthLabel = (key: string | null | undefined) => (key ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : NA);
/** "2026-06-30" → "Jun 30, 2026". */
export const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

/** Money as the page draws it: compact, zero a dash, missing n.a. */
export const money = (c: number | null | undefined) => (c == null ? NA : Math.round(c / 100) === 0 ? EM_DASH : usdCompact(c));
/** A difference: signed, zero a dash. */
export const delta = (c: number | null | undefined) => {
  if (c == null) return NA;
  if (Math.round(c / 100) === 0) return EM_DASH;
  return `${c > 0 ? "+" : "−"}${usdCompact(Math.abs(c))}`;
};
export const pct = (r: number | null | undefined, digits = 1) => (r == null ? NA : Math.abs(r) < 0.0005 ? EM_DASH : `${(r * 100).toFixed(digits)}%`);
export const pctDelta = (r: number | null | undefined) => (r == null ? NA : Math.abs(r) < 0.0005 ? EM_DASH : `${r > 0 ? "+" : "−"}${(Math.abs(r) * 100).toFixed(1)} pts`);
/** A shift in months: "+5 mo", "−1 yr 2 mo". */
export const monthsShift = (n: number | null) => {
  if (n == null) return NA;
  if (n === 0) return EM_DASH;
  const a = Math.abs(n);
  const y = Math.floor(a / 12);
  const m = a % 12;
  return `${n > 0 ? "+" : "−"}${y ? `${y} yr` : ""}${y && m ? " " : ""}${m ? `${m} mo` : ""}`;
};

const field = "rounded border border-line-strong bg-surface px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent focus-visible:ring-1 focus-visible:ring-focus/50 placeholder:text-faint";

/** A month (YYYY-MM); blank = not set. */
export function MonthField({ value, onChange, label, className = "" }: { value: string | null; onChange: (v: string | null) => void; label: string; className?: string }) {
  return (
    <input
      type="month"
      aria-label={label}
      title={label}
      value={value ?? ""}
      onChange={(e) => onChange(/^\d{4}-\d{2}$/.test(e.target.value) ? e.target.value : null)}
      className={`${field} num w-[8.5rem] ${className}`}
    />
  );
}

/** A number typed as text, committed on blur or Enter; blank = null (shows `placeholder`). */
function NumberText({
  value,
  placeholder,
  onChange,
  label,
  suffix,
  prefix,
  className = "",
  toText,
  fromText,
  plain = false,
}: {
  value: number | null;
  placeholder?: string;
  onChange: (v: number | null) => void;
  label: string;
  suffix?: string;
  prefix?: string;
  className?: string;
  toText: (v: number) => string;
  fromText: (t: string) => number | null;
  /** Not an override of anything: drawn without the typed-in highlight. */
  plain?: boolean;
}) {
  const typed = !plain && value != null;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value == null ? "" : toText(value);
  const commit = () => {
    if (draft == null) return;
    const t = draft.trim();
    onChange(t === "" ? null : fromText(t));
    setDraft(null);
  };
  return (
    <span className={`inline-flex items-center rounded border px-1 focus-within:border-accent ${typed ? "border-info/60 bg-info-soft" : "border-line-strong bg-surface"} ${className}`}>
      {prefix && <span className="select-none text-[11px] text-faint">{prefix}</span>}
      <input
        inputMode="decimal"
        aria-label={label}
        title={label}
        className={`num w-full min-w-0 bg-transparent px-0.5 py-0.5 text-right text-xs outline-none placeholder:text-faint ${typed ? "text-info" : "text-fg"}`}
        placeholder={placeholder}
        value={draft ?? shown}
        onFocus={(e) => {
          setDraft(shown);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix && <span className="select-none pl-0.5 text-[11px] text-faint">{suffix}</span>}
    </span>
  );
}

const parseNum = (t: string) => {
  const n = Number(t.replace(/[$,\s%]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** A rate as a percent (5 → 0.05); blank = the placeholder (the forecast's). */
export function Pct({ value, placeholder, onChange, label, className = "w-[4.5rem]", plain }: { value: number | null; placeholder?: number | null; onChange: (v: number | null) => void; label: string; className?: string; plain?: boolean }) {
  return (
    <NumberText
      plain={plain}
      value={value}
      placeholder={placeholder == null ? "" : String(+(placeholder * 100).toFixed(2))}
      onChange={(v) => onChange(v == null ? null : v / 100)}
      label={label}
      suffix="%"
      className={className}
      toText={(v) => String(+(v * 100).toFixed(2))}
      fromText={parseNum}
    />
  );
}

/** Dollars bound to cents; blank = the placeholder. */
export function Dollars({ value, placeholder, onChange, label, className = "w-[6.5rem]", plain }: { value: number | null; placeholder?: number | null; onChange: (v: number | null) => void; label: string; className?: string; plain?: boolean }) {
  return (
    <NumberText
      plain={plain}
      value={value}
      placeholder={placeholder == null ? "" : Math.round(placeholder / 100).toLocaleString("en-US")}
      onChange={(v) => onChange(v == null ? null : Math.round(v * 100))}
      label={label}
      prefix="$"
      className={className}
      toText={(v) => Math.round(v / 100).toLocaleString("en-US")}
      fromText={parseNum}
    />
  );
}

/** A whole number (years, ages). */
export function Whole({ value, onChange, label, suffix, className = "w-[3.5rem]" }: { value: number; onChange: (v: number) => void; label: string; suffix?: string; className?: string }) {
  return (
    <NumberText
      value={value}
      plain
      onChange={(v) => v != null && onChange(Math.round(v))}
      label={label}
      suffix={suffix}
      className={className}
      toText={String}
      fromText={parseNum}
    />
  );
}

/** One labelled line of the editor. */
export function Line({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-0.5 py-[3px]" title={hint}>
      <span className="truncate text-[11px] text-muted">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

/** A titled block of the editor. */
export function Block({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line px-3 py-2 first:border-t-0">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-2">{title}</h3>
        <span className="ml-auto flex items-center gap-1">{right}</span>
      </div>
      {children}
    </section>
  );
}

export const tiny = "rounded px-1.5 py-0.5 text-[11px] font-medium text-fg-2 outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40";
