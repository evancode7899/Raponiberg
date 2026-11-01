"use client";

/**
 * The app's shared building blocks. Everything is styled with the semantic theme
 * utilities from globals.css (bg-surface, text-muted, border-line, text-pos …), so a
 * component looks right in every theme without per-theme overrides.
 */

import { apiSecretHeaders } from "@/components/ledger/useApi";
import type { ProofRef } from "@/components/ui/proof/context";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { ProofValue, type FigureProps } from "@/components/ui/proof/ProofValue";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";

// ---------------------------------------------------------------------------- buttons

const btnBase =
  "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45";

export const btn = {
  primary: `${btnBase} bg-accent text-accent-fg hover:brightness-110`,
  secondary: `${btnBase} border border-line-strong bg-surface text-fg hover:bg-surface-2`,
  ghost: `${btnBase} text-fg-2 hover:bg-surface-2 hover:text-fg`,
  danger: `${btnBase} border border-neg/50 text-neg hover:bg-neg-soft`,
  link: "text-xs font-medium text-accent underline-offset-2 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm",
};

/** Kept for the pages that import the old names. */
export const buttonPrimary = btn.primary;
export const buttonSecondary = btn.secondary;
export const buttonDanger = btn.danger;

// ---------------------------------------------------------------------------- inputs

export const inputCls =
  "rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-focus/40";
/**
 * A masked entry box for the app password that password managers can't latch onto: it is not
 * an <input> at all (iCloud Passwords ignores every opt-out attribute and pops up even over a
 * type="text" field), just a focusable box that takes keystrokes and draws a dot for each.
 * Enter calls `onEnter`, Backspace deletes (Ctrl+Backspace clears), Escape clears, paste works.
 */
export function SecretBox({
  value,
  onChange,
  onEnter,
  autoFocus = false,
  invalid = false,
  labelledBy,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  invalid?: boolean;
  labelledBy?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div
      ref={ref}
      role="textbox"
      tabIndex={0}
      aria-labelledby={labelledBy}
      aria-invalid={invalid}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={() => ref.current?.focus()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter?.();
        } else if (e.key === "Backspace") {
          e.preventDefault();
          onChange(e.ctrlKey || e.metaKey || e.altKey ? "" : value.slice(0, -1));
        } else if (e.key === "Escape") {
          onChange("");
        } else if (e.key.length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey)) {
          // Ctrl+Alt is AltGr on Windows keyboards, which types characters.
          e.preventDefault();
          onChange(value + e.key);
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        onChange(value + e.clipboardData.getData("text").replace(/[\r\n]/g, ""));
      }}
      className={`${inputCls} flex cursor-text items-center select-none font-mono tracking-[0.2em] ${invalid ? "border-neg focus:border-neg" : ""} ${className}`}
    >
      <span aria-hidden>{"•".repeat(value.length) || "​"}</span>
      {focused && <span aria-hidden className="h-4 w-px animate-pulse bg-fg" />}
    </div>
  );
}

export const selectCls =
  "rounded-md border border-line-strong bg-surface px-2 py-1.5 text-xs text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-focus/40";

export function Field({ label, hint, children, className = "" }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-xs ${className}`}>
      <span className="font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-muted">{hint}</span>}
    </label>
  );
}

const fmtDollars = (c: number | null) => (c == null ? "" : Math.round(c / 100).toLocaleString("en-US"));

/**
 * Whole-dollar input bound to cents. With `nullable`, blank means "no figure" (e.g.
 * "use what the statements say", shown as the placeholder) and an entered figure is
 * highlighted as an override. Commits on blur or Enter.
 */
export function MoneyInput({
  cents,
  onChange,
  placeholderCents,
  nullable = false,
  allowNegative = true,
  className = "",
  title,
  size = "sm",
  ariaLabel,
}: {
  cents: number | null;
  onChange: (cents: number | null) => void;
  placeholderCents?: number | null;
  nullable?: boolean;
  allowNegative?: boolean;
  className?: string;
  title?: string;
  size?: "xs" | "sm";
  ariaLabel?: string;
}) {
  // The text being typed while the field has focus; otherwise the field shows `cents`.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? fmtDollars(cents);
  const commit = () => {
    // Whole dollars: "1,234.56" is $1,235 (a dropped decimal point would make it $123,456).
    const n = parseFloat(text.replace(/[^\d.-]/g, "").replace(allowNegative ? /(?!^)-/g : /-/g, ""));
    onChange(Number.isFinite(n) ? Math.round(n) * 100 + 0 : nullable ? null : 0);
  };
  const overridden = nullable && cents != null;
  return (
    <div
      title={title}
      className={`flex min-w-0 items-center rounded-md border px-2 ${
        overridden ? "border-info/60 bg-info-soft" : "border-line-strong bg-surface"
      } focus-within:border-accent ${className}`}
    >
      <span className="select-none text-faint">$</span>
      <input
        inputMode="numeric"
        aria-label={ariaLabel}
        className={`num w-full min-w-0 bg-transparent px-1 text-right outline-none placeholder:text-faint ${size === "xs" ? "py-1 text-xs" : "py-1.5 text-sm"} ${
          overridden ? "text-info" : "text-fg"
        }`}
        placeholder={placeholderCents == null ? (nullable ? "" : "0") : fmtDollars(placeholderCents)}
        value={text}
        onFocus={(e) => {
          setDraft(fmtDollars(cents));
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
    </div>
  );
}

/** A percentage input bound to a ratio (5 → 0.05). */
export function PercentInput({
  value,
  onChange,
  className = "",
  size = "sm",
  ariaLabel,
}: {
  value: number;
  onChange: (ratio: number) => void;
  className?: string;
  size?: "xs" | "sm";
  ariaLabel?: string;
}) {
  // The text being typed while the field has focus; otherwise the field shows `value`.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = String(+(value * 100).toFixed(2));
  return (
    <div className={`flex min-w-0 items-center rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent ${className}`}>
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        className={`num w-full min-w-0 bg-transparent text-right text-fg outline-none ${size === "xs" ? "py-1 text-xs" : "py-1.5 text-sm"}`}
        value={draft ?? shown}
        onFocus={(e) => {
          setDraft(shown);
          e.target.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n / 100);
        }}
        onBlur={() => setDraft(null)}
      />
      <span className="select-none pl-1 text-faint">%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------- surfaces

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClassName = "",
  id,
  tone = "default",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  /** "overview" sets a summary card slightly apart from the detail cards around it. */
  tone?: "default" | "overview";
}) {
  const overview = tone === "overview";
  return (
    <section
      id={id}
      // --card-bg lets sticky table cells inside match the card's background.
      style={overview ? ({ "--card-bg": "var(--surface-2)" } as CSSProperties) : undefined}
      className={`min-w-0 rounded-lg border shadow-[var(--shadow)] ${overview ? "border-line-strong bg-surface-2" : "border-line bg-surface"} ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3.5">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[13px] font-semibold text-fg">{title}</h2>}
            {subtitle && <div className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={`min-w-0 px-4 pb-4 ${title || actions ? "pt-3" : "pt-4"} ${bodyClassName}`}>{children}</div>}
    </section>
  );
}

export type Tone = "neutral" | "pos" | "neg" | "warn" | "info" | "accent";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-fg",
  pos: "text-pos",
  neg: "text-neg",
  warn: "text-warn",
  info: "text-info",
  accent: "text-accent",
};

const TONE_SOFT: Record<Tone, string> = {
  neutral: "bg-surface-3 text-fg-2",
  pos: "bg-pos-soft text-pos",
  neg: "bg-neg-soft text-neg",
  warn: "bg-warn-soft text-warn",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
};

/**
 * A headline figure. Its proof is required (a recipe, unswept(why), or a whole Figure):
 * the value shows only once the proof sweep clears it (ProofValue), and blocked or
 * estimated figures say so themselves.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  size = "md",
  ...figure
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  size?: "md" | "lg";
} & FigureProps) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`num mt-1 font-semibold tracking-tight ${size === "lg" ? "text-3xl" : "text-xl"} ${TONE_TEXT[tone]}`}>
        <ProofValue {...figure}>{value}</ProofValue>
      </div>
      {sub && <div className="mt-0.5 text-xs leading-snug text-muted">{sub}</div>}
    </div>
  );
}

/** A row of headline figures in one card. */
export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 | 6 }) {
  const c = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-3 lg:grid-cols-5",
    6: "sm:grid-cols-3 lg:grid-cols-6",
  }[cols];
  return (
    <div className="rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
      <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line ${c}`}>{children}</div>
    </div>
  );
}

/** One cell of a StatGrid. */
export function StatCell(props: Parameters<typeof Stat>[0]) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <Stat {...props} />
    </div>
  );
}

/**
 * A cell of a StatGrid that holds words, never a figure: a save status, a mode. Its value
 * is a plain string the page chose, not a number read from the data, so it has no proof
 * and isn't withheld. Anything read from the data goes in a StatCell, with its proof.
 */
export function WordsCell({ label, value, sub, tone = "neutral" }: { label: ReactNode; value: string; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3" data-words-cell="">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold tracking-tight ${TONE_TEXT[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs leading-snug text-muted">{sub}</div>}
    </div>
  );
}

/**
 * Text that holds money or a rate but isn't a figure read from the data: a rule's threshold,
 * an example, an input you typed. It says why, so the render audit (scripts/render-audit.ts),
 * which fails on money drawn outside a figure, knows what it is. Anything read from the data
 * is a figure with a proof (ProofValue), never this.
 */
export function NotFigure({ why, children }: { why: string; children: ReactNode }) {
  return <span data-not-figure={why}>{children}</span>;
}

/**
 * A calculator's exploratory grid: what-ifs worked out from the inputs as you move them (a
 * sensitivity table, a stress test, a year-by-year schedule), not figures read from the data.
 * The render audit skips its numbers but counts the region per page, and fails if real data
 * hides in it: a ledger figure drawn inside, or a ledger figure's value drawn bare. The
 * owner's own numbers and a page's headline stay outside, each a ProofValue.
 */
export function WhatIf({ why, children, className, inline }: { why: string; children: ReactNode; className?: string; inline?: boolean }) {
  return inline ? (
    <span data-what-if={why} className={className}>
      {children}
    </span>
  ) : (
    <div data-what-if={why} className={className}>
      {children}
    </div>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide ${TONE_SOFT[tone]} ${
        title ? "cursor-help" : ""
      }`}
    >
      {children}
    </span>
  );
}

const CALLOUT: Record<"info" | "warn" | "good" | "bad", { cls: string; icon: string }> = {
  info: { cls: "border-info/30 bg-info-soft", icon: "i" },
  warn: { cls: "border-warn/35 bg-warn-soft", icon: "!" },
  good: { cls: "border-pos/30 bg-pos-soft", icon: "✓" },
  bad: { cls: "border-neg/35 bg-neg-soft", icon: "×" },
};
const CALLOUT_INK = { info: "text-info", warn: "text-warn", good: "text-pos", bad: "text-neg" };

export function Callout({ tone, title, children, action }: { tone: "info" | "warn" | "good" | "bad"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`flex gap-2.5 rounded-md border px-3 py-2.5 text-sm ${CALLOUT[tone].cls}`} role={tone === "bad" || tone === "warn" ? "alert" : undefined}>
      <span
        aria-hidden
        className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${CALLOUT_INK[tone]} border-current`}
      >
        {CALLOUT[tone].icon}
      </span>
      <div className="min-w-0 flex-1 text-fg-2">
        {title && <div className={`font-semibold ${CALLOUT_INK[tone]}`}>{title}</div>}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      <div className="text-sm font-semibold text-fg">{title}</div>
      {children && <div className="max-w-md text-xs leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <Callout tone="bad">{children}</Callout>;
}

// ---------------------------------------------------------------------------- controls

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
  ariaLabel,
  view = false,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "xs" | "sm";
  ariaLabel?: string;
  /**
   * It picks what the page shows (a range, a year, $ or $k), not an input the page saves:
   * the render audit (scripts/render-audit.ts) clicks every option and holds what each draws.
   * `skip` names options it leaves alone, and why (a custom range the sweep can't enumerate).
   */
  view?: boolean | { skip: T[]; why: string };
}) {
  const audit = view ? { "data-audit-view": typeof view === "object" ? view.skip.join(",") : "", ...(typeof view === "object" ? { "data-audit-skip-why": view.why } : {}) } : {};
  return (
    <div role="radiogroup" aria-label={ariaLabel} {...audit} className="inline-flex rounded-md border border-line-strong bg-surface-2 p-0.5">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`rounded-[5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus ${
              size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"
            } ${on ? "bg-surface text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Sticky tab strip at the top of a page's scroll area. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: ReactNode; count?: number | null }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/80">
      <div role="tablist" className="mx-auto flex w-full max-w-[96rem] gap-1 overflow-x-auto px-4 sm:px-6">
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-tab-id={t.id}
              onClick={() => onChange(t.id)}
              className={`relative flex shrink-0 items-center gap-1.5 px-2.5 py-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
                on ? "text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span className={`num rounded-full px-1.5 text-[10px] font-semibold ${on ? "bg-accent text-accent-fg" : "bg-surface-3 text-fg-2"}`}>{t.count}</span>
              )}
              <span aria-hidden className={`absolute inset-x-1 -bottom-px h-0.5 rounded-full ${on ? "bg-accent" : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Tab state mirrored in the URL (?tab=…), so tabs survive reloads, links can point at
 * a tab, and the browser's back button works. Re-read whenever Next's router changes the
 * query, so a link to another tab of the page you're on (the command bar's INT on
 * Statements) switches tabs. Pages using it are dynamically rendered, so reading the
 * search params needs no Suspense boundary.
 */
export function useTabParam<T extends string>(valid: readonly T[], fallback: T): [T, (t: T) => void] {
  const [tab, setTabState] = useState<T>(fallback);
  const query = useSearchParams().get("tab");
  useEffect(() => {
    const read = () => {
      const t = new URLSearchParams(window.location.search).get("tab") as T | null;
      setTabState(t && valid.includes(t) ? t : fallback);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `valid` is a constant list; `query` only triggers the re-read
  }, [fallback, query]);
  const setTab = (t: T) => {
    setTabState(t);
    const url = new URL(window.location.href);
    if (t === fallback) url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    window.history.pushState(null, "", url);
  };
  return [tab, setTab];
}

/**
 * State remembered in this browser (calculator inputs). Stored values are merged over
 * the defaults, so fields added later still get a value.
 */
export function usePersistentState<T extends object>(key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      // Read after mount on purpose: the server render can't see localStorage, so reading it
      // during render would make the first client render differ (a hydration mismatch).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setValue({ ...initial(), ...(JSON.parse(raw) as Partial<T>) });
    } catch {
      /* storage unavailable or corrupt: keep defaults */
    }
    loaded.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initial` is a factory for defaults
  }, [key]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue];
}

/** A calculator page's inputs saved on the server (lib/pageInputs.ts), or null. */
export async function fetchSavedInputs<T extends object>(key: string): Promise<Partial<T> | null> {
  const res = await fetch(`/api/page-inputs/${encodeURIComponent(key)}`, { headers: apiSecretHeaders() });
  if (!res.ok) throw new Error(`Could not load saved inputs (${res.status})`);
  return ((await res.json()) as { value: Partial<T> | null }).value;
}

/**
 * Calculator inputs saved in the app's data (data/page-inputs.json), so they are backed up
 * and follow the data to a new computer. This browser's copy draws the first frame; the
 * saved copy replaces it once loaded. Inputs only this browser had are saved on first load.
 */
export function useSavedState<T extends object>(key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = usePersistentState<T>(key, initial);
  const [ready, setReady] = useState(false);
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchSavedInputs<T>(key)
      .then((saved) => {
        if (!live) return;
        if (saved) {
          const next = { ...initial(), ...saved };
          lastSaved.current = JSON.stringify(next);
          setValue(next);
        }
        setReady(true);
      })
      .catch(() => {
        /* server unreachable: keep this browser's copy, don't overwrite the saved one */
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initial` is a factory for defaults
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    const json = JSON.stringify(value);
    if (json === lastSaved.current) return;
    const t = setTimeout(() => {
      fetch(`/api/page-inputs/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { ...apiSecretHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      })
        .then((res) => {
          if (res.ok) lastSaved.current = json;
        })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [key, value, ready]);
  return [value, setValue];
}

/** Page body: consistent width and padding under the tabs. */
export function PageBody({ children, width = "wide", className = "" }: { children: ReactNode; width?: "narrow" | "medium" | "wide"; className?: string }) {
  const w = { narrow: "max-w-3xl", medium: "max-w-6xl", wide: "max-w-[96rem]" }[width];
  return <div className={`mx-auto flex w-full min-w-0 flex-col gap-4 px-4 pb-12 pt-4 sm:px-6 ${w} ${className}`}>{children}</div>;
}

// ---------------------------------------------------------------------------- overlays

/** Right-hand panel for details (transactions behind a bar, an account…). */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = "40rem",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default bg-black/45" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="pf-drawer relative flex h-full w-full flex-col border-l border-line bg-surface shadow-2xl outline-none"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={id} className="text-sm font-semibold text-fg">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
          </div>
          <button type="button" className={btn.ghost} onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </header>
        <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- tables

export type TableRow =
  | { kind: "heading"; label: ReactNode; sub?: ReactNode }
  | {
      kind?: "row";
      label: ReactNode;
      help?: string;
      /** Each figure's proof is required, as for any figure (ProofValue). */
      cells: ({ text: ReactNode; title?: string; dim?: boolean; proof: ProofRef; blockers?: BlockerRef[]; drawn?: FigureProps["drawn"] } | null)[];
      strong?: boolean;
      /** A total that closes a section: double rule. */
      total?: boolean;
      indent?: boolean;
      muted?: boolean;
    };

/**
 * Financial-statement table: a sticky label column and right-aligned numeric columns
 * (one per year, scenario…). `highlight` tints columns (e.g. the year in progress);
 * `projected` italicizes them.
 */
export function StatementTable({
  columns,
  rows,
  highlight = [],
  projected = [],
  minWidth = "36rem",
}: {
  columns: ReactNode[];
  rows: TableRow[];
  highlight?: number[];
  projected?: number[];
  minWidth?: string;
}) {
  const colCls = (i: number) => `${highlight.includes(i) ? "bg-surface-2" : ""} ${projected.includes(i) ? "italic text-fg-2" : ""}`;
  return (
    <div className="app-scroll overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line-strong text-[11px] uppercase tracking-wide text-muted">
            <th className="sticky left-0 z-10 bg-[var(--card-bg,var(--surface))] py-1.5 pr-3 text-left font-medium" />
            {columns.map((c, i) => (
              <th key={i} className={`whitespace-nowrap px-2 py-1.5 text-right font-semibold text-fg-2 ${colCls(i)}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) =>
            r.kind === "heading" ? (
              <tr key={i}>
                <td colSpan={columns.length + 1} className="sticky left-0 bg-[var(--card-bg,var(--surface))] pb-1 pt-5 text-left">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">{r.label}</span>
                  {r.sub && <span className="ml-2 text-[11px] font-normal text-muted">{r.sub}</span>}
                </td>
              </tr>
            ) : (
              <tr
                key={i}
                className={`${r.total ? "border-t-[3px] border-double border-line-strong font-semibold" : r.strong ? "border-t border-line-strong font-semibold" : "border-t border-line"} ${
                  r.muted ? "text-muted" : "text-fg"
                }`}
              >
                <td
                  className={`sticky left-0 z-10 whitespace-nowrap bg-[var(--card-bg,var(--surface))] py-1 pr-3 text-left ${r.indent ? "pl-4" : ""} ${r.muted ? "text-[12px]" : ""}`}
                  title={r.help}
                >
                  {r.label}
                  {r.help && <span className="ml-1 cursor-help text-faint">ⓘ</span>}
                </td>
                {r.cells.map((c, j) => (
                  <td
                    key={j}
                    title={c?.title}
                    className={`num whitespace-nowrap px-2 py-1 text-right ${colCls(j)} ${c?.dim ? "text-faint" : ""} ${r.muted ? "text-[12px]" : ""}`}
                  >
                    {c ? (
                      <ProofValue proof={c.proof} blockers={c.blockers} drawn={c.drawn}>
                        {c.text}
                      </ProofValue>
                    ) : (
                      ""
                    )}
                  </td>
                ))}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Class names for ordinary data tables (lists of rows). */
export const table = {
  wrap: "app-scroll overflow-x-auto",
  table: "w-full border-collapse text-[13px]",
  head: "border-b border-line-strong text-[11px] uppercase tracking-wide text-muted",
  th: "whitespace-nowrap px-2 py-1.5 text-left font-medium",
  thR: "whitespace-nowrap px-2 py-1.5 text-right font-medium",
  tr: "border-t border-line",
  trHover: "border-t border-line hover:bg-surface-2",
  td: "px-2 py-1.5 align-middle",
  tdR: "num whitespace-nowrap px-2 py-1.5 text-right align-middle",
};

/** Starts a file download from a fetch Response (CSV exports, database backups). */
export async function downloadResponse(res: Response, fallbackName: string): Promise<string> {
  const blob = await res.blob();
  const name = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoked once the browser has started the download (revoking at once can cancel it in some browsers).
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
