"use client";

import { lastDataStamp } from "@/components/ledger/useApi";
import { Badge, Callout, Drawer, ErrorNote, Loading, table, type Tone } from "@/components/ui/kit";
import type { Proof, ProofBlock, ProofDescriptor, ProofLink } from "@/lib/book/proof";
import type { ChainLine, ProofCheck, ProofGroup, ProofRow, ProofStatement, ProofValue } from "@/lib/book/proof/types";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { formatPercentRatio, formatUsdFromCents, usd0 } from "@/lib/formatMoney";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { ProofEntry } from "./ProofProvider";

const date = (iso: string) => formatDisplayDateFromYmd(iso);
const cents = (c: number) => formatUsdFromCents(Math.round(c));
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const valueText = (v: ProofValue, whole = false) => ("cents" in v ? (whole ? usd0(v.cents) : cents(v.cents)) : "ratio" in v ? formatPercentRatio(v.ratio, 2) : v.text);

/**
 * The proof behind a figure, whatever kind it is: the figure and whether its parts
 * really add up to it, the proof's blocks (rows by statement, breakdowns, derivation
 * chains), the statements, every check over it, and what's estimated. Links open the
 * linked proof on top; Back (or Escape) returns. Read only: findings are fixed on
 * Statements → Issues.
 */
export function ProofPanel({ stack, onFollow, onBack, onClose }: { stack: ProofEntry[]; onFollow: (d: ProofDescriptor) => void; onBack: () => void; onClose: () => void }) {
  const top = stack.at(-1);
  const prev = stack.at(-2);
  const p = top?.proof;
  // Escape steps back through followed links before closing, and is the drawer's alone:
  // a drill-down drawer open underneath stays open.
  const depth = stack.length;
  useEffect(() => {
    if (!depth) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (depth > 1) onBack();
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [depth, onBack, onClose]);

  return (
    <Drawer
      open={!!top}
      onClose={onClose}
      title={p ? p.describes : "How this figure adds up"}
      subtitle={p ? `From statements on file · data runs through ${date(p.through)}` : undefined}
      width="46rem"
    >
      {prev && (
        <button type="button" onClick={onBack} className="mb-3 text-xs font-medium text-accent hover:underline">
          ← Back{prev.proof ? ` to ${prev.proof.describes}` : ""}
        </button>
      )}
      {top?.error && <ErrorNote>{top.error}</ErrorNote>}
      {top && !p && !top.error && <Loading label="Adding up the parts…" />}
      {top && p && <ProofBody key={stack.length} p={p} shownCents={top.target.shownCents} perMonths={top.target.perMonths} onFollow={onFollow} />}
    </Drawer>
  );
}

function ProofBody({ p, shownCents, perMonths, onFollow }: { p: Proof & { stamp?: string }; shownCents: number | null; perMonths?: number; onFollow: (d: ProofDescriptor) => void }) {
  const stamp = p.stamp;
  const statements = uniqueStatements(p.blocks);
  const figureCents = "cents" in p.figure ? p.figure.cents : null;
  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="num text-3xl font-semibold tracking-tight text-fg">{valueText(p.figure, true)}</div>
        {figureCents != null && perMonths && perMonths > 1 ? (
          <div className="mt-0.5 text-xs text-muted">
            Shown as {usd0(figureCents / perMonths)} a month: this total ÷ {perMonths} months.
          </div>
        ) : null}
        {figureCents != null && shownCents != null && Math.round(shownCents) !== figureCents && (
          <div className="mt-2">
            {stamp && stamp === lastDataStamp() ? (
              <Callout tone="bad" title="The page and its proof disagree">
                On the same data, the page shows {cents(Math.round(shownCents))} and the proof works out {cents(figureCents)}. That&apos;s a bug in the app, not in your documents: the page and the proof compute this figure differently.
              </Callout>
            ) : (
              <Callout tone="warn" title="The data changed since this page loaded">
                The page shows {usd0(shownCents)}; the data on file now gives {usd0(figureCents)}. Reload the page to see the new figures.
              </Callout>
            )}
          </div>
        )}
        {p.selfCheck && (
          <div className="mt-3">
            {p.selfCheck.ok ? (
              <Callout tone="good">{p.selfCheck.explain}: exactly the figure shown.</Callout>
            ) : (
              <Callout tone="bad" title="The parts don't add up to the figure">
                {p.selfCheck.explain}, {cents(p.selfCheck.deltaCents)} off the figure. That&apos;s a bug in the app, not in your documents.
              </Callout>
            )}
          </div>
        )}
        {p.withheld && (
          <div className="mt-2">
            <Callout tone="warn" title="Part of this is withheld">
              An open finding covers it (see Checks below); pages withhold a figure until it&apos;s resolved.
            </Callout>
          </div>
        )}
      </section>

      {p.blocks.map((b, i) => (
        <BlockView key={`${b.kind}:${b.title}:${i}`} b={b} onFollow={onFollow} />
      ))}

      {statements.length > 0 && (
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
      )}

      {p.checks.length > 0 && (
        <section>
          <SectionTitle sub="Every check that could withhold this figure, over its dates and accounts">Checks</SectionTitle>
          <ul className="flex flex-col divide-y divide-line">
            {p.checks.map((c) => (
              <CheckRow key={c.id} c={c} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Details and fixes:{" "}
            <Link className="text-accent hover:underline" href="/statements?tab=issues">
              Statements → Issues
            </Link>
            .
          </p>
        </section>
      )}

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

/** A link to another figure's proof, opened on top of this one. */
function FollowLink({ link, onFollow, children, className = "" }: { link?: ProofLink; onFollow: (d: ProofDescriptor) => void; children: ReactNode; className?: string }) {
  if (!link) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() => onFollow(link.descriptor)}
      title={`Open the proof of ${link.label}`}
      className={`rounded-sm text-left underline decoration-line-strong decoration-dotted underline-offset-4 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      {children}
    </button>
  );
}

function BlockView({ b, onFollow }: { b: ProofBlock; onFollow: (d: ProofDescriptor) => void }) {
  if (b.kind === "breakdown")
    return (
      <section>
        <SectionTitle>{b.title}</SectionTitle>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-2">
          {b.items.map((x, i) => (
            <li key={`${x.label}:${i}`} className="flex justify-between gap-2">
              <span className="min-w-0 truncate text-muted">
                <FollowLink link={x.link} onFollow={onFollow}>
                  {x.label}
                </FollowLink>
                {x.sub ? ` (${x.sub})` : ""}
              </span>
              <span className="num shrink-0">{valueText(x.value, true)}</span>
            </li>
          ))}
        </ul>
        {b.note && <p className="mt-1.5 text-xs text-muted">{b.note}</p>}
      </section>
    );
  if (b.kind === "chain")
    return (
      <section>
        <SectionTitle>{b.title}</SectionTitle>
        <ul className="flex flex-col text-[13px]">
          {b.lines.map((l, i) => (
            <ChainRow key={i} l={l} onFollow={onFollow} />
          ))}
        </ul>
        {b.note && <p className="mt-1.5 text-xs text-muted">{b.note}</p>}
      </section>
    );
  return (
    <section>
      <SectionTitle sub={`${usd0(b.figureCents)} · ${b.groups.length} statement${b.groups.length === 1 ? "" : "s"} · largest first`}>{b.title}</SectionTitle>
      {b.groups.length === 0 && <p className="text-[13px] text-muted">No rows: nothing was counted here.</p>}
      <ul className="flex flex-col gap-1">
        {b.groups.map((g) => (
          <GroupView key={g.statement.id} g={g} />
        ))}
      </ul>
      {b.note && <p className="mt-1.5 text-xs text-muted">{b.note}</p>}
    </section>
  );
}

const SOURCE: Record<ChainLine["source"], { tone: Tone; label: string }> = {
  proven: { tone: "pos", label: "Proven" },
  assumption: { tone: "info", label: "Your assumption" },
  law: { tone: "neutral", label: "Tax law" },
  estimate: { tone: "warn", label: "Estimate" },
  derived: { tone: "neutral", label: "Worked out" },
};

function ChainRow({ l, onFollow }: { l: ChainLine; onFollow: (d: ProofDescriptor) => void }) {
  const s = SOURCE[l.source];
  return (
    <li className={`grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-2 py-1 ${l.op === "=" ? "border-t border-line-strong font-semibold" : ""}`}>
      <span className="num text-center text-muted">{l.op ?? ""}</span>
      <span className="min-w-0">
        <FollowLink link={l.link} onFollow={onFollow}>
          {l.label}
        </FollowLink>{" "}
        <Badge tone={s.tone}>{s.label}</Badge>
        {l.note && <div className="text-[11px] font-normal leading-snug text-muted">{l.note}</div>}
      </span>
      <span className="num text-right">{valueText(l.value)}</span>
    </li>
  );
}

function GroupView({ g }: { g: ProofGroup }) {
  const [open, setOpen] = useState(false);
  const showCategory = new Set(g.rows.map((r) => r.category)).size > 1;
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
              ? "Nothing here for it to check."
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

function uniqueStatements(blocks: ProofBlock[]): ProofStatement[] {
  const m = new Map<string, ProofStatement>();
  for (const b of blocks) if (b.kind === "rows") for (const g of b.groups) m.set(g.statement.id, g.statement);
  return [...m.values()].sort((a, b) => a.account.localeCompare(b.account) || a.periodStart.localeCompare(b.periodStart));
}
