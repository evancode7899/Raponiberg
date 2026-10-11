"use client";

export { pct, short, usd } from "@/app/fire/ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const monthName = (m: number) => MONTHS[(m - 1 + 12) % 12]!;
/** "Jul ’26" */
export const monthLabel = (year: number, month: number) => `${monthName(month)} ’${String(year).slice(2)}`;

/** A year typed in; blank (or out of range) = null. Commits on blur or Enter. */
export function YearInput({ value, onChange, min = 1900, max = 2200 }: { value: number | null; onChange: (v: number | null) => void; min?: number; max?: number }) {
  return (
    <input
      inputMode="numeric"
      className="num w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-right text-xs text-fg outline-none focus:border-accent"
      defaultValue={value ?? ""}
      key={String(value)}
      onBlur={(e) => {
        const n = Math.round(Number(e.target.value));
        onChange(e.target.value.trim() && n >= min && n <= max ? n : null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
