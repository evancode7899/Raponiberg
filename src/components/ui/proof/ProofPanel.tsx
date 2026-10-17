"use client";

import { Badge, Callout, Drawer, ErrorNote, Loading, table, type Tone } from "@/components/ui/kit";
import type { CashFlowProof, ProofCheck, ProofGroup, ProofRow, ProofSection, ProofStatement } from "@/lib/book/proof/cashFlowProof";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { formatPercentRatio, formatUsdFromCents, usd0 } from "@/lib/formatMoney";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { ProofState } from "./ProofProvider";

const date = (iso: string) => formatDisplayDateFromYmd(iso);
const cents = (c: number) => formatUsdFromCents(Math.round(c));
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The proof behind a figure: the figure and whether its rows really add up to it, the
 * rows by statement, the statements, every check over it, and what's estimated. Read
 * only: findings are fixed on Statements → Issues.
 */
export function ProofPanel({ state, onClose }: { state: ProofState | null; onClose: () => void }) {
  const p = state?.proof;
  return (
    <Drawer open={!!state} onClose={onClose} title={p ? p.describes : "How this figure adds up"} subtitle={p ? `From statements on file · cash flow runs through ${date(p.through)}` : undefined} width="46rem">
      {state?.error && <ErrorNote>{state.error}</ErrorNote>}
      {state && !p && !state.error && <Loading label="Adding up the rows…" />}
      {state && p && <ProofBody p={p} shownCents={state.target.shownCents} perMonths={state.target.perMonths} />}
    </Drawer>
  );
}

function ProofBody({ p, shownCents, perMonths }: { p: CashFlowProof; shownCents?: number; perMonths?: number }) {
  const rowCount = p.sections.reduce((t, s) => t + s.groups.reduce((u, g) => u + g.rows.length, 0), 0);
  const statements = uniqueStatements(p.sections);
  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="num text-3xl font-semibold tracking-tight text-fg">{usd0(p.figureCents)}</div>
        {perMonths && perMonths > 1 ? (
          <div className="mt-0.5 text-xs text-muted">
            Shown as {usd0(p.figureCents / perMonths)} a month: this total ÷ {perMonths} months.
          </div>
        ) : null}
        {shownCents != null && shownCents !== p.figureCents && (
          <div className="mt-2">
            <Callout tone="warn" title="The data changed since this page loaded">
              The page shows {usd0(shownCents)}; the statements on file now give {usd0(p.figureCents)}. Reload the page to see the new figures.
            </Callout>
          </div>
        )}
        <div className="mt-3">
          {p.selfCheck.ok ? (
            <Callout tone="good">
              The {rowCount} row{rowCount === 1 ? "" : "s"} below add up to exactly {cents(p.rowsCents)}
              {p.sections.length > 1 ? " (income less spending)" : ""}, the figure shown.
            </Callout>
          ) : (
            <Callout tone="bad" title="The rows don't add up to the figure">
              They come to {cents(p.rowsCents)}, {cents(p.selfCheck.deltaCents)} off. That&apos;s a bug in the app, not in your statements.
            </Callout>
          )}
        </div>
        {p.withheld && (
          <div className="mt-2">
            <Callout tone="warn" title="Part of this is withheld">
              An open finding covers these months (see Checks below); pages withhold a figure until it&apos;s resolved.
            </Callout>
          </div>
        )}
      </section>

      {p.periods.length > 1 && (
        <section>
          <SectionTitle>By {p.descriptor.granularity}</SectionTitle>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-3">
            {p.periods.map((x) => (
              <li key={x.start} className="flex justify-between gap-2">
                <span className="text-muted">
                  {x.label}
                  {x.through ? ` (to ${date(x.through)})` : ""}
                </span>
                <span className="num">{usd0(x.cents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.sections.map((s) => (
        <SectionView key={s.label} s={s} showLabel={p.sections.length > 1} category={p.descriptor.category} />
      ))}

      <section>
        <SectionTitle sub={`${statements.length} statement${statements.length === 1 ? "" : "s"}`}>Statements behind it</SectionTitle>
        <ul className="flex flex-col divide-y divide-line text-[13px]">
          {statements.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
              <span className="min-w-0">
                <span className="font-medium text-fg">{s.account}</span>
                <span className="text-muted">
                  {" "}
                  · {date(s.periodStart)} – {date(s.periodEnd)}
                </span>
              </span>
              <span className="min-w-0 truncate text-xs text-muted" title={s.documentTitle}>
                {s.documentTitle || "—"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <SectionTitle sub="Every check that could withhold this figure, over its months and accounts">Checks</SectionTitle>
        <ul className="flex flex-col divide-y divide-line">
          {p.checks.map((c) => (
            <CheckRow key={c.id} c={c} />
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">
          Details and fixes: <Link className="text-accent hover:underline" href="/statements?tab=issues">Statements → Issues</Link>.
        </p>
      </section>

      {p.estimates.length > 0 && (
        <section>
          <SectionTitle sub="Proven from other sources rather than printed on a statement">Estimated parts</SectionTitle>
          <ul className="flex flex-col gap-2 text-[13px]">
            {p.estimates.map((e) => (
              <li key={e.id}>
                <div className="font-medium text-fg">{e.title}</div>
                <div className="text-xs text-muted">{e.detail}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SectionTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
      {children}
      {sub && <span className="ml-2 font-normal normal-case tracking-normal text-muted">{sub}</span>}
    </h3>
  );
}

function SectionView({ s, showLabel, category }: { s: ProofSection; showLabel: boolean; category?: string }) {
  return (
    <section>
      <SectionTitle sub={`${s.groups.length} statement${s.groups.length === 1 ? "" : "s"} · largest first`}>
        How it adds up{showLabel ? ` · ${s.label} ${usd0(s.figureCents)}` : ""}
      </SectionTitle>
      {s.groups.length === 0 && <p className="text-[13px] text-muted">No rows: nothing was counted here.</p>}
      <ul className="flex flex-col gap-1">
        {s.groups.map((g) => (
          <GroupView key={g.statement.id} g={g} showCategory={!category} />
        ))}
      </ul>
      {!category && s.categoryRoundingCents !== 0 && (
        <p className="mt-1.5 text-xs text-muted">
          The categories on the page add up to {cents(s.figureCents - s.categoryRoundingCents)}: each is rounded to the cent on its own, so they can differ from the total by {cents(Math.abs(s.categoryRoundingCents))}.
        </p>
      )}
    </section>
  );
}

function GroupView({ g, showCategory }: { g: ProofGroup; showCategory: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2">
        <span aria-hidden className="w-3 shrink-0 text-faint">
          {open ? "▾" : "▸"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{g.statement.account}</span>
          <span className="text-muted">
            {" "}
            · statement {date(g.statement.periodStart)} – {date(g.statement.periodEnd)} · {g.rows.length} row{g.rows.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="num shrink-0 font-medium">{cents(g.subtotalCents)}</span>
      </button>
      {open && (
        <div className={`${table.wrap} border-t border-line`}>
          <table className={table.table}>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.id} className={table.tr}>
                  <td className={`${table.td} whitespace-nowrap text-muted`}>{date(r.date)}</td>
                  <td className={table.td}>
                    <div className="text-fg">{r.payee || "—"}</div>
                    <RowNotes r={r} />
                  </td>
                  {showCategory && <td className={`${table.td} text-xs text-muted`}>{r.category}</td>}
                  <td className={table.tdR}>{cents(r.countedCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

/** Why a row counts where, or how much of it, it does. */
function RowNotes({ r }: { r: ProofRow }) {
  const notes: string[] = [];
  if (r.precision === "PERIOD") notes.push(`${formatPercentRatio(r.share, 1)} of a ${cents(Math.abs(r.amountCents))} period total, spread across the statement's days`);
  if (r.movedTo?.why === "rent") notes.push(`rent: counted in ${month(r.movedTo.date)}, the month it pays for`);
  else if (r.movedTo) notes.push(`counted on ${date(r.movedTo.date)}, the bill's own day`);
  else if (r.precision === "EXACT" && r.bookedOn !== r.date) notes.push(`dated before its statement: booked on ${date(r.bookedOn)}`);
  if (r.piece) notes.push("one piece of a bill payment made in several bank payments");
  if (!notes.length) return null;
  return <div className="text-[11px] leading-snug text-muted">{notes.join(" · ")}</div>;
}

const STATE: Record<ProofCheck["state"], { tone: Tone; label: string }> = {
  passed: { tone: "pos", label: "Passed" },
  open: { tone: "neg", label: "Open" },
  accepted: { tone: "info", label: "Accepted" },
  none: { tone: "neutral", label: "Nothing in scope" },
};

function CheckRow({ c }: { c: ProofCheck }) {
  const [open, setOpen] = useState(false);
  const s = STATE[c.state];
  const more = c.subjects.length > 0 || c.open.length > 0 || c.accepted.length > 0;
  return (
    <li className="py-2">
      <div className="flex items-start gap-2">
        <Badge tone={s.tone}>{s.label}</Badge>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg" title={c.description}>
            {c.title}
          </div>
          <div className="text-xs text-muted">
            {c.state === "none"
              ? "No statement, account or month here for it to check."
              : [
                  c.passed ? `passed on ${c.passed} ${c.passed === 1 ? "subject" : "subjects"}` : null,
                  c.open.length ? `${c.open.length} open` : null,
                  c.accepted.length ? `${c.accepted.length} accepted by you` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
            {more && (
              <button type="button" className="ml-2 font-medium text-accent hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                {open ? "Hide" : "Show"}
              </button>
            )}
          </div>
        </div>
      </div>
      {open && (
        <div className="ml-2 mt-1.5 flex flex-col gap-1.5 border-l border-line pl-3 text-xs">
          {c.open.map((f) => (
            <div key={f.id}>
              <div className="font-medium text-neg">{f.title}</div>
              <div className="text-muted">{f.detail}</div>
              <div className="text-fg-2">{f.fix}</div>
            </div>
          ))}
          {c.accepted.map((f) => (
            <div key={f.id}>
              <div className="font-medium text-fg">{f.title}</div>
              <div className="text-muted">
                Accepted {date(f.acceptedAt.slice(0, 10))}: “{f.note}”
              </div>
            </div>
          ))}
          {c.subjects.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-muted">
              {c.subjects.map((x, i) => (
                <li key={i}>✓ {x}</li>
              ))}
              {c.passed > c.subjects.length && <li>… and {c.passed - c.subjects.length} more</li>}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function uniqueStatements(sections: ProofSection[]): ProofStatement[] {
  const m = new Map<string, ProofStatement>();
  for (const s of sections) for (const g of s.groups) m.set(g.statement.id, g.statement);
  return [...m.values()].sort((a, b) => a.account.localeCompare(b.account) || a.periodStart.localeCompare(b.periodStart));
}
