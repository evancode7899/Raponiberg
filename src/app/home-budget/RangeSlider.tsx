"use client";

import { Badge, type Tone } from "@/components/ui/kit";
import { formatUsd } from "@/lib/formatMoney";
import { useId, useState, type ReactNode } from "react";

/** How a value is shown and typed. */
export type Unit = "usd" | "pct" | "years";

/**
 * A slider's scale: hard limits, the typical band (shaded), and what lies on each side of
 * it ("Aggressive" / "Conservative", or "Favors buying" / "Favors renting").
 */
export type SliderSpec = {
  min: number;
  max: number;
  step: number;
  unit: Unit;
  /** Decimal places for percents (default 1). */
  digits?: number;
  /** Typical range [lo, hi]; omitted for facts (salary, HOA) that have no "reasonable" range. */
  band?: [number, number];
  /** What a value below / above the band means. */
  sides?: [string, string];
};

const SIDE_TONE: Record<string, Tone> = {
  Aggressive: "warn",
  Conservative: "info",
  Optimistic: "warn",
  "Favors buying": "accent",
  "Favors renting": "info",
};

const TONE_BG: Partial<Record<Tone, string>> = { warn: "bg-warn/30", info: "bg-info/25", accent: "bg-accent/25" };
const sideBg = (side: string) => TONE_BG[SIDE_TONE[side] ?? "neutral"] ?? "bg-fg/10";

export function fmtValue(v: number, unit: Unit, digits = 1): string {
  if (unit === "usd") return v === 0 ? "$0" : formatUsd(v);
  if (unit === "years") return `${Math.round(v)} yr`;
  return `${(v * 100).toFixed(digits)}%`;
}

/** Short tick label: $1.2M, $450k, 6%. */
function tick(v: number, unit: Unit, digits = 1): string {
  if (unit === "usd") {
    const a = Math.abs(v);
    if (a >= 1_000_000) return `$${+(v / 1_000_000).toFixed(2)}M`;
    if (a >= 1000) return `$${+(v / 1000).toFixed(a >= 100_000 ? 0 : 1)}k`;
    return `$${Math.round(v)}`;
  }
  if (unit === "years") return `${Math.round(v)}y`;
  return `${+(v * 100).toFixed(digits)}%`;
}

/** "250k", "1.2m", "$4,500", "6.25" (percent) → number in the slider's unit. */
export function parseTyped(raw: string, unit: Unit): number | null {
  const t = raw.trim().toLowerCase().replace(/[$,%\s]/g, "").replace(/yrs?|years?$/, "");
  const m = /^(-?\d*\.?\d+)([km]?)$/.exec(t);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2] === "k") n *= 1000;
  if (m[2] === "m") n *= 1_000_000;
  if (!Number.isFinite(n)) return null;
  return unit === "pct" ? n / 100 : n;
}

export function zoneOf(v: number, spec: SliderSpec): { label: string; tone: Tone } | null {
  if (!spec.band) return null;
  const [lo, hi] = spec.band;
  const eps = spec.step / 2;
  if (v < lo - eps) return spec.sides ? { label: spec.sides[0], tone: SIDE_TONE[spec.sides[0]] ?? "neutral" } : null;
  if (v > hi + eps) return spec.sides ? { label: spec.sides[1], tone: SIDE_TONE[spec.sides[1]] ?? "neutral" } : null;
  return { label: "Typical", tone: "pos" };
}

export function RangeSlider({
  label,
  hint,
  value,
  onChange,
  spec,
  defaultValue,
  markers = [],
  extra,
  disabled,
  compact,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  spec: SliderSpec;
  /** Shown as a tick on the track; a reset button appears when the value differs. */
  defaultValue?: number;
  /** Extra reference ticks (e.g. "max" price). */
  markers?: { value: number; label: string }[];
  extra?: ReactNode;
  disabled?: boolean;
  /** Dense layout for the inputs panel: no scale labels, the hint moves into a tooltip. */
  compact?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const digits = spec.digits ?? 1;
  // A typed value can go past the track; the track stretches to show it.
  const min = Math.min(spec.min, value);
  const max = Math.max(spec.max, value);
  const pos = (v: number) => (max > min ? ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100 : 0);
  const zone = zoneOf(value, spec);
  const changed = defaultValue !== undefined && Math.abs(value - defaultValue) > spec.step / 2;
  const commit = (raw: string) => {
    setDraft(null);
    const n = parseTyped(raw, spec.unit);
    if (n !== null) onChange(Math.max(0, spec.unit === "years" ? Math.round(n) : n));
  };

  return (
    <div className={`min-w-0 ${compact ? "py-1" : "py-2"} ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-2">
        <label
          htmlFor={id}
          title={compact && typeof hint === "string" ? hint : undefined}
          className={`min-w-0 flex-1 truncate text-xs font-medium text-fg-2 ${compact && hint ? "cursor-help underline decoration-line-strong decoration-dotted underline-offset-2" : ""}`}
        >
          {label}
        </label>
        {zone && <Badge tone={zone.tone}>{zone.label}</Badge>}
        {changed && (
          <button
            type="button"
            onClick={() => onChange(defaultValue!)}
            title={`Back to the default (${fmtValue(defaultValue!, spec.unit, digits)})`}
            className="rounded px-1 text-[11px] text-faint hover:bg-surface-3 hover:text-fg"
          >
            ↺
          </button>
        )}
        <input
          aria-label={typeof label === "string" ? `${label} value` : "Value"}
          disabled={disabled}
          className="num w-[6.75rem] shrink-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-right text-sm font-semibold text-fg outline-none hover:border-line-strong focus:border-accent focus:bg-surface"
          value={draft ?? fmtValue(value, spec.unit, digits)}
          onFocus={(e) => {
            setDraft(spec.unit === "pct" ? String(+(value * 100).toFixed(digits + 2)) : String(Math.round(value)));
            const el = e.target;
            requestAnimationFrame(() => el.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>

      <div className="relative mt-1 h-5">
        {/* Drawn track, inset by half the thumb so positions line up with the native thumb. */}
        <div className="pointer-events-none absolute inset-x-2 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--slider-track)]">
          {spec.band && (
            <>
              {spec.sides && <div className={`absolute inset-y-0 left-0 ${sideBg(spec.sides[0])}`} style={{ width: `${pos(spec.band[0])}%` }} />}
              {spec.sides && <div className={`absolute inset-y-0 right-0 ${sideBg(spec.sides[1])}`} style={{ left: `${pos(spec.band[1])}%` }} />}
              <div className="absolute inset-y-0 bg-pos/45" style={{ left: `${pos(spec.band[0])}%`, width: `${pos(spec.band[1]) - pos(spec.band[0])}%` }} />
            </>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-2 inset-y-0">
          {defaultValue !== undefined && (
            <span title="Default" className="absolute top-0 h-5 w-0.5 -translate-x-1/2 rounded bg-fg-2/60" style={{ left: `${pos(defaultValue)}%` }} />
          )}
          {markers.map((m) => (
            <span key={m.label} title={`${m.label}: ${fmtValue(m.value, spec.unit, digits)}`} className="absolute top-0 h-5 w-0.5 -translate-x-1/2 rounded bg-accent" style={{ left: `${pos(m.value)}%` }} />
          ))}
        </div>
        <input
          id={id}
          type="range"
          disabled={disabled}
          className="range-over relative"
          min={min}
          max={max}
          step={spec.step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>

      {compact ? (
        extra && <div className="mt-0.5 text-[11px] leading-snug text-muted">{extra}</div>
      ) : (
        <ScaleNotes spec={spec} min={min} max={max} pos={pos} hint={hint} markers={markers} extra={extra} />
      )}
    </div>
  );
}

function ScaleNotes({
  spec,
  min,
  max,
  pos,
  hint,
  markers,
  extra,
}: {
  spec: SliderSpec;
  min: number;
  max: number;
  pos: (v: number) => number;
  hint?: ReactNode;
  markers: { value: number; label: string }[];
  extra?: ReactNode;
}) {
  const digits = spec.digits ?? 1;
  return (
    <>
      <div className="relative mx-2 mt-0.5 h-3.5 text-[10px] leading-none text-faint">
        <span className="absolute left-0 -translate-x-1/2">{tick(min, spec.unit, digits)}</span>
        {spec.band && (
          <>
            <span className="absolute -translate-x-1/2 text-pos" style={{ left: `${pos(spec.band[0])}%` }}>
              {tick(spec.band[0], spec.unit, digits)}
            </span>
            <span className="absolute -translate-x-1/2 text-pos" style={{ left: `${pos(spec.band[1])}%` }}>
              {tick(spec.band[1], spec.unit, digits)}
            </span>
          </>
        )}
        <span className="absolute right-0 translate-x-1/2">{tick(max, spec.unit, digits)}</span>
      </div>
      {spec.sides && (
        <div className="mx-0.5 mt-0.5 flex justify-between text-[10px] text-faint">
          <span>← {spec.sides[0]}</span>
          <span>{spec.sides[1]} →</span>
        </div>
      )}
      {(hint || markers.length > 0 || extra) && (
        <div className="mt-1 text-[11px] leading-snug text-muted">
          {hint}
          {markers.map((m) => (
            <span key={m.label} className="ml-1 whitespace-nowrap">
              <span className="inline-block h-2 w-0.5 bg-accent align-middle" /> {m.label} {fmtValue(m.value, spec.unit, digits)}
            </span>
          ))}
          {extra}
        </div>
      )}
    </>
  );
}
