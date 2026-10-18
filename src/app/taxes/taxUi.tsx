"use client";

import { MoneyInput } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { EstimateBasis, EstimateKey } from "@/lib/tax/estimateLines";

export { Callout } from "@/components/ui/kit";
import { formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import type { ReactNode } from "react";

/** Whole dollars from cents; exact zero shows an em dash. */
export const usd = (cents: number | null | undefined) => (cents == null ? "—" : formatUsd(Math.round(cents / 100)));
export const pct = (r: number, digits = 1) => formatPercentRatio(r, digits);

/** "Refund $1,234" / "Owe $1,234" for a balance-due figure (positive = owe). */
export function balanceText(cents: number): string {
  if (Math.abs(cents) < 100) return "About even";
  return cents > 0 ? `Owe ${usd(cents)}` : `Refund ${usd(-cents)}`;
}

export function BalanceBadge({ cents }: { cents: number }) {
  const owe = cents >= 100;
  const even = Math.abs(cents) < 100;
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
        even ? "bg-surface-3 text-fg-2" : owe ? "bg-warn-soft text-warn" : "bg-pos-soft text-pos"
      }`}
    >
      {balanceText(cents)}
    </span>
  );
}

export type Row = {
  label: ReactNode;
  values: ReactNode[];
  /** Visual weight: subtotal rows are bold with a rule above. */
  strong?: boolean;
  indent?: boolean;
  help?: string;
  /** Section heading spanning the table; values are ignored. */
  heading?: boolean;
  /** Muted styling for derived ratios and notes. */
  muted?: boolean;
};

/** Label column + right-aligned numeric columns; scrolls horizontally on narrow screens. */
export function NumberTable({ columns, rows, className = "", compact = false }: { columns: ReactNode[]; rows: Row[]; className?: string; compact?: boolean }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className={`w-full border-collapse text-sm ${compact ? "" : "min-w-[28rem]"}`}>
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="py-1.5 pr-3 font-medium" />
            {columns.map((c, i) => (
              <th key={i} className="py-1.5 pl-3 text-right font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) =>
            r.heading ? (
              <tr key={i}>
                <td colSpan={columns.length + 1} className="pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {r.label}
                </td>
              </tr>
            ) : (
            <tr key={i} className={`${r.strong ? "border-t border-line-strong font-semibold" : "border-t border-line"} ${r.muted ? "text-muted" : ""}`}>
              <td className={`py-1.5 pr-3 text-fg ${r.indent ? "pl-4 text-muted" : ""}`} title={r.help}>
                {r.label}
                {r.help && <span className="ml-1 cursor-help text-faint">ⓘ</span>}
              </td>
              {r.values.map((v, j) => (
                <td key={j} className="py-1.5 pl-3 text-right tabular-nums text-fg">
                  {v}
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

/** Dollar input bound to a cents value. */
export function MoneyField({
  label,
  cents,
  onChange,
  help,
  allowNegative = false,
}: {
  label: string;
  cents: number;
  onChange: (cents: number) => void;
  help?: string;
  allowNegative?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span className="font-medium text-fg-2" title={help}>
        {label}
        {help && <span className="ml-1 cursor-help text-faint">ⓘ</span>}
      </span>
      <MoneyInput cents={cents} allowNegative={allowNegative} onChange={(c) => onChange(c ?? 0)} />
    </label>
  );
}

export function NullableMoneyField({
  label,
  cents,
  onChange,
  help,
}: {
  label: string;
  cents: number | null;
  onChange: (cents: number | null) => void;
  help?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span className="font-medium text-fg-2" title={help}>
        {label}
        {help && <span className="ml-1 cursor-help text-faint">ⓘ</span>}
      </span>
      <MoneyInput nullable cents={cents} onChange={onChange} />
    </label>
  );
}


/**
 * A tax estimate figure that opens its proof (book/proof/taxEstimateProof): the line's key
 * in lib/tax/estimateLines, for the joint return unless a filer is given. `cents` is the
 * figure as the page computed it, before any sign flip for display.
 */
export function EstimateValue({ year, k, cents, basis = "projected", filer, children }: { year: number; k: EstimateKey | "found.FEDERAL" | "found.CT"; cents: number; basis?: EstimateBasis | "filed"; filer?: string; children: ReactNode }) {
  return <ProofValue proof={{ descriptor: { report: "tax-estimate", year, basis, ...(filer ? { filer } : {}), key: k }, shownCents: cents }}>{children}</ProofValue>;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
