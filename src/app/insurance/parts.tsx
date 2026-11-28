"use client";

import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, Segmented, table } from "@/components/ui/kit";
import { formatPercentRatio, formatUsdFromCents, NA } from "@/lib/formatMoney";
import { compositeOf } from "@/components/ui/proof/context";
import type { CoverPayment, CoverStatus, CoverTerm } from "@/lib/insurance/cover";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { dateLabel } from "@/lib/dates/display";

/** Shared pieces of the Insurance page's tabs. */

export const longDate = (d: string) => dateLabel(d);
export const shortDate = (d: string) => dateLabel(d);
const yearsUntil = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / (365.25 * 86_400_000);
export const until = (from: string, to: string) => {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (days < 0) return null;
  if (days < 62) return days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`;
  const y = yearsUntil(from, to);
  return y < 2 ? `in ${Math.round(y * 12)} months` : `in ${Math.round(y)} years`;
};
export const rowProof = (rowId: string, cents: number) => ({ descriptor: { report: "row" as const, rowId }, shownCents: -cents });

/** A derived figure of the page, drawn as its own text (money as dollars and cents, words as printed). */
/**
 * A home policy's main coverages, by the first letter its declarations use: State Farm's
 * renters print personal property as B and liability as L; the standard (ISO) forms ASI
 * prints use C and E, with A the dwelling. -1 when the policy prints none.
 */
export function mainCoverages(p: { property: { code: string | null }[]; liability: { code: string | null }[] }): { personal: number; liability: number } {
  const first = (list: { code: string | null }[], codes: string[]) => codes.map((code) => list.findIndex((c) => c.code === code)).find((i) => i >= 0) ?? -1;
  return { personal: first(p.property, ["B", "C", "A"]), liability: first(p.liability, ["L", "E"]) };
}

export function Fig({ figs, figure, k, money = "cents" }: { figs: readonly DerivedFigure[]; figure: string; k?: string; money?: "cents" | "dollars" }) {
  const f = figs.find((x) => x.figure === figure && (x.key ?? null) === (k ?? null));
  const v = f?.value;
  const text = !v ? NA : "cents" in v ? (money === "dollars" ? `$${Math.round(v.cents / 100).toLocaleString("en-US")}` : formatUsdFromCents(v.cents)) : "text" in v ? v.text : String(v.ratio);
  // A limit in words can be long: let it wrap; money stays on one line.
  return (
    <ProofValue proof={derivedTarget("insurance", figs, figure, k)} className={v && "text" in v ? "whitespace-normal" : ""}>
      {text}
    </ProofValue>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode | null | undefined][] }) {
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows
        .filter(([, value]) => value != null && value !== "" && value !== false)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-fg">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function CoverStatusBadge({ status, end }: { status: CoverStatus; end: string }) {
  if (status === "NOT_STARTED") return <Badge tone="info">Not yet in force</Badge>;
  if (status === "ENDED") return <Badge tone="neutral">Ended {shortDate(end)}</Badge>;
  return <Badge tone="pos">In force</Badge>;
}

/** The term as people say it: from the first day to the last (coverage ends at 12:01 a.m. on the end date). */
export const termText = (start: string, end: string) => `${shortDate(start)} – ${shortDate(end)}`;

/**
 * The tab's own strip of sections (Coverage, Policy, Payments…), mirrored in the URL
 * (?view=…) so a section survives a reload and can be linked to. Its tabs carry no
 * data-tab-id: the render audit draws each as a view of the page's tab, not a tab of its own.
 */
export function useViewParam<T extends string>(valid: readonly T[], fallback: T): [T, (v: T) => void] {
  const [view, setState] = useState<T>(fallback);
  const query = useSearchParams().get("view");
  useEffect(() => {
    const read = () => {
      const v = new URLSearchParams(window.location.search).get("view") as T | null;
      setState(v && valid.includes(v) ? v : fallback);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `valid` is a constant list; `query` only triggers the re-read
  }, [fallback, query]);
  const set = (v: T) => {
    setState(v);
    const url = new URL(window.location.href);
    if (v === fallback) url.searchParams.delete("view");
    else url.searchParams.set("view", v);
    window.history.replaceState(null, "", url);
  };
  return [view, set];
}

export function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number | null }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" aria-label="Sections" className="flex flex-wrap items-center gap-1 border-b border-line">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus ${on ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {t.label}
            {t.count != null && t.count > 0 && <span className="num rounded-full bg-surface-3 px-1.5 text-[10px] font-semibold text-fg-2">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Pick one policy of a line when there are several. */
export function PolicyPicker({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  if (options.length < 2) return null;
  return <Segmented view options={options} value={value} onChange={onChange} ariaLabel="Policy" />;
}

/** Premiums found in the statements for a home or auto policy, each under the term it paid for. */
export function CoverPayments({ payments, terms, accounts, insurer }: { payments: CoverPayment[]; terms: CoverTerm[]; accounts: Record<string, string>; insurer: string }) {
  if (!payments.length) return <p className="text-sm text-muted">No premium to {insurer} found in the statements yet.</p>;
  const termLabel = (start: string | null) => {
    const t = terms.find((x) => x.start === start);
    return t ? termText(t.start, t.end) : "Before the terms on file";
  };
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr className={table.head}>
            <th className={table.th}>Date</th>
            <th className={table.th}>Term</th>
            <th className={table.th}>Paid from</th>
            <th className={table.th}>As printed</th>
            <th className={table.thR}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {[...payments].reverse().map((x) => (
            <tr key={x.rowId} className={table.tr}>
              <td className={table.td}>{shortDate(x.date)}</td>
              <td className={`${table.td} text-fg-2`}>{termLabel(x.term)}</td>
              <td className={table.td}>{accounts[x.accountId] ?? NA}</td>
              <td className={`${table.td} max-w-[22rem] truncate text-fg-2`} title={x.payee}>
                {x.payee}
              </td>
              <td className={table.tdR}>
                <ProofValue proof={rowProof(x.rowId, x.cents)}>{formatUsdFromCents(x.cents)}</ProofValue>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every term of the policy on file, and where each premium comes from. */
export function TermsOnFile({ line, policyNumber, terms, figs }: { line: "HOME" | "AUTO"; policyNumber: string; terms: CoverTerm[]; figs: readonly DerivedFigure[] }) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr className={table.head}>
            <th className={table.th}>Term</th>
            <th className={table.th}>From</th>
            <th className={table.th}>File</th>
            <th className={table.thR}>Premium</th>
            <th className={table.thR} title="Against the term before it, when both run the same months">Change</th>
          </tr>
        </thead>
        <tbody>
          {terms.map((x) => {
            // The term before it of the same length: a renewal's price change (a six-month term against a year isn't like for like).
            const prev = [...terms].filter((t) => t.start < x.start).sort((a, b) => b.start.localeCompare(a.start))[0];
            const like = prev && prev.months != null && prev.months === x.months;
            const target = (t: CoverTerm) => derivedTarget("insurance", figs, "term-premium", `${line}|${policyNumber}|${t.start}`);
            const d = like ? x.premiumCents - prev.premiumCents : 0;
            return (
            <tr key={x.start} className={table.tr}>
              <td className={table.td}>{termText(x.start, x.end)}</td>
              <td className={`${table.td} text-fg-2`}>{x.from === "DECLARATIONS" ? "Declarations" : "Renewal letter (prior premium)"}</td>
              <td className={`${table.td} max-w-[16rem] truncate text-fg-2`} title={x.file}>
                {x.file}
              </td>
              <td className={table.tdR}>
                <Fig figs={figs} figure="term-premium" k={`${line}|${policyNumber}|${x.start}`} />
              </td>
              <td className={`${table.tdR} ${d > 0 ? "text-neg" : d < 0 ? "text-pos" : "text-muted"}`}>
                {!like ? (
                  "—"
                ) : d ? (
                  <>
                    <ProofValue proof={compositeOf("diff", [target(x), target(prev)], { cents: d })}>{`${d > 0 ? "+" : "−"}${formatUsdFromCents(Math.abs(d))}`}</ProofValue>
                    {prev.premiumCents > 0 && (
                      <span className="ml-1 text-xs">
                        (<ProofValue proof={compositeOf("growth", [target(x), target(prev)], { ratio: d / prev.premiumCents })}>{formatPercentRatio(d / prev.premiumCents, 0)}</ProofValue>)
                      </span>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
