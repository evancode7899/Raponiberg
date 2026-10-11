"use client";

import { Badge, inputCls, type Tone } from "@/components/ui/kit";
import type { Quality } from "@/lib/ledger/timeline";
import type { Api } from "./useApi";

export { buttonDanger, buttonPrimary, buttonSecondary, Card, Segmented, Stat } from "@/components/ui/kit";

/** What each data-quality level means, in plain words (tooltips and legends). */
export const QUALITY_TEXT: Record<Quality, { label: string; help: string }> = {
  EXACT: { label: "Exact", help: "Straight from statements, to the cent." },
  ESTIMATED: {
    label: "Estimated",
    help: "Inside an investment statement's period: market change and quarterly contributions are spread evenly across its days. Exact again at each statement date.",
  },
  DERIVED: {
    label: "Derived",
    help: "No statement for this stretch; worked out from a year-end report minus the statements around it.",
  },
  INTERPOLATED: {
    label: "Gap",
    help: "A statement is missing here; values are interpolated between the statements on either side. Upload the missing statement to make it exact.",
  },
  STALE: {
    label: "Stale",
    help: "Past the latest statement on file; the last known balance is carried forward.",
  },
  UNKNOWN: { label: "Unknown", help: "Before the first statement on file." },
};

const QUALITY_TONE: Record<Quality, Tone> = {
  EXACT: "pos",
  ESTIMATED: "info",
  DERIVED: "info",
  INTERPOLATED: "warn",
  STALE: "neutral",
  UNKNOWN: "neg",
};

export function QualityBadge({ quality, asOf }: { quality: Quality; asOf?: string | null }) {
  if (quality === "EXACT") return null;
  const t = QUALITY_TEXT[quality];
  return (
    <span className="ml-1">
      <Badge tone={QUALITY_TONE[quality]} title={`${t.help}${asOf && quality === "STALE" ? ` Last statement: ${asOf}.` : ""}`}>
        {t.label}
        {asOf && quality === "STALE" ? ` · ${asOf.slice(5)}` : ""}
      </Badge>
    </span>
  );
}

export function QualityLegend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      {(Object.keys(QUALITY_TEXT) as Quality[])
        .filter((q) => q !== "EXACT" && q !== "UNKNOWN")
        .map((q) => (
          <span key={q} className="flex items-center gap-1" title={QUALITY_TEXT[q].help}>
            <Badge tone={QUALITY_TONE[q]}>{QUALITY_TEXT[q].label}</Badge>
            <span className="max-w-[18rem] truncate">{QUALITY_TEXT[q].help.split(";")[0]!.split(".")[0]}</span>
          </span>
        ))}
    </div>
  );
}

/** Shown only when the server requires API_SECRET; remembered for the browser session. */
export function ApiSecretField({ api }: { api: Api }) {
  if (!api.requiresApiSecret) return null;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <label className="flex max-w-md flex-col gap-1 text-xs">
        <span className="font-medium text-fg-2">Access secret</span>
        <input type="password" autoComplete="off" className={inputCls} value={api.secret} onChange={(e) => api.setSecret(e.target.value)} />
        <span className="text-muted">This server requires API_SECRET. It&apos;s kept for this browser session only.</span>
      </label>
    </div>
  );
}
