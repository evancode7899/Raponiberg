"use client";

export { pct, short, usd } from "@/app/fire/ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const monthName = (m: number) => MONTHS[(m - 1 + 12) % 12]!;
/** "Jul ’26" */
/** A forecast derived figure's proof (book/derived/forecast.ts), withheld while the drivers have unsaved edits. */
export type Dp = (figure: string, key?: string) => import("@/components/ui/proof/context").ProofRef;

export const monthLabel = (year: number, month: number) => `${monthName(month)} ’${String(year).slice(2)}`;

const YEAR_CLS = "num w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-right text-xs text-fg outline-none focus:border-accent";

/**
 * A year typed in; blank (or out of range) = null. Commits on blur or Enter. With
 * `required`, a blank or out-of-range entry is dropped and the field shows its year again.
 */
export function YearInput({
  value,
  onChange,
  min = 1900,
  max = 2200,
  ariaLabel,
  className = YEAR_CLS,
  required = false,
  disabled = false,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  ariaLabel?: string;
  className?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      inputMode="numeric"
      aria-label={ariaLabel}
      disabled={disabled}
      className={className}
      defaultValue={value ?? ""}
      key={String(value)}
      onBlur={(e) => {
        const n = Math.round(Number(e.target.value));
        const year = e.target.value.trim() && n >= min && n <= max ? n : null;
        if (year == null && required) e.target.value = value == null ? "" : String(value);
        else onChange(year);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
