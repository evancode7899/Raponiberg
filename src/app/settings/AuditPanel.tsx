"use client";

import type { Api } from "@/components/ledger/useApi";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { btn, Callout, Card, downloadResponse, Drawer, ErrorNote, inputCls, Loading, NotFigure, table } from "@/components/ui/kit";
import type { ChainCheck } from "@/lib/audit/chain";
import { beforeAfterOf, type Change } from "@/lib/audit/changes";
import { formatDisplayDateTime } from "@/lib/displayTime";
import { NA } from "@/lib/formatMoney";
import { useEffect, useMemo, useState } from "react";

type Event = { id: string; occurredAt: string; action: string; actor: string; payload: unknown; seq: number | null };
type Facet = { value: string; count: number };
type AuditAnswer = { events: Event[]; total: number; matched: number; actions: Facet[]; actors: Facet[]; chain: ChainCheck };
type Filters = { action: string; actor: string; from: string; to: string };

const NO_FILTERS: Filters = { action: "", actor: "", from: "", to: "" };
const when = (iso: string) => formatDisplayDateTime(new Date(iso));
/** What the log wrote, word for word: a record of a change, not a figure the app works out. */
const LOGGED = "the audit log's record of a change, as it was written";
const shown = (v: unknown) => (v === null || v === undefined ? NA : typeof v === "string" ? v : JSON.stringify(v));
const changedText = (payload: unknown) => {
  const ch = beforeAfterOf(payload);
  return ch.length ? `${ch[0]!.path}: ${shown(ch[0]!.before)} → ${shown(ch[0]!.after)}${ch.length > 1 ? ` (+${ch.length - 1})` : ""}` : "";
};

/** The chain's state in a sentence: holds, or what broke and where. */
function ChainNote({ c }: { c: ChainCheck }) {
  if (!c.chained)
    return <p className="text-xs text-muted">No event is on the chain yet: the next change starts it. {c.unchained ? `${c.unchained.toLocaleString()} older events were written before it.` : ""}</p>;
  if (c.ok)
    return (
      <p className="text-xs text-muted" data-audit-chain="ok">
        <span className="font-medium text-pos">Chain holds:</span> {c.chained.toLocaleString()} events linked{c.startedAt ? ` since ${when(c.startedAt)}` : ""}, none changed, removed or reordered since they were written
        {c.unchained ? `; ${c.unchained.toLocaleString()} older events came before the chain` : ""}
        {c.restarts.length ? `; started again ${c.restarts.length} time${c.restarts.length === 1 ? "" : "s"} (from ${when(c.restarts.at(-1)!.at)})` : ""}.
      </p>
    );
  return (
    <Callout tone="bad" title="The audit log was changed outside the app">
      <ul className="flex flex-col gap-0.5" data-audit-chain="broken">
        {c.problems.slice(0, 8).map((p, i) => (
          <li key={i}>{p.detail}</li>
        ))}
        {c.problems.length > 8 && <li>…and {c.problems.length - 8} more.</li>}
      </ul>
    </Callout>
  );
}

function BeforeAfter({ changes }: { changes: Change[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 pr-3 font-medium">What</th>
          <th className="py-1 pr-3 font-medium">Before</th>
          <th className="py-1 font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c, i) => (
          <tr key={i} className="border-t border-line align-top">
            <td className="py-1 pr-3 font-mono text-fg-2">{c.path}</td>
            <td className="break-all py-1 pr-3 font-mono text-neg">{shown(c.before)}</td>
            <td className="break-all py-1 font-mono text-pos">{shown(c.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Everything the app has changed: imports, corrections, settings, exports. Filtered by what,
 * who and when on the server (the whole log, not only what's loaded); each event opens with
 * the values it changed, before and after. Every event is linked into a hash chain, so the
 * page says whether any was changed, removed or reordered since (lib/audit/chain.ts).
 */
export function AuditPanel({ api }: { api: Api }) {
  const [data, setData] = useState<AuditAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState<Event | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ limit: "1000", ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
    api
      .call<AuditAnswer>(`/api/audit?${q}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api, filters]);

  const columns = useMemo<Column<Event>[]>(
    () => [
      { id: "when", label: "When", text: (e) => when(e.occurredAt), sort: (e) => e.occurredAt, className: `${table.td} whitespace-nowrap text-xs text-muted` },
      { id: "action", label: "Action", text: (e) => e.action, sort: (e) => e.action, className: `${table.td} whitespace-nowrap font-mono text-xs text-fg` },
      { id: "actor", label: "By", text: (e) => e.actor, sort: (e) => e.actor, className: `${table.td} whitespace-nowrap text-xs text-muted` },
      {
        id: "changes",
        label: "Changed",
        help: "What the change replaced and what it saved (open the event for all of it)",
        text: (e) => changedText(e.payload),
        cell: (e) => <NotFigure why={LOGGED}>{changedText(e.payload)}</NotFigure>,
        className: `${table.td} max-w-[24rem] truncate font-mono text-[11px] text-fg-2`,
      },
      { id: "details", label: "Details", text: (e) => (e.payload == null ? "" : JSON.stringify(e.payload)), cell: (e) => <NotFigure why={LOGGED}>{e.payload == null ? "" : JSON.stringify(e.payload)}</NotFigure>, className: `${table.td} w-full max-w-0 truncate font-mono text-[11px] text-muted` },
      { id: "seq", label: "Link", help: "The event's place in the hash chain (blank: written before the chain began)", optional: true, align: "right", text: (e) => (e.seq == null ? "" : String(e.seq)), sort: (e) => e.seq ?? -1 },
    ],
    [],
  );

  const download = async () => {
    const headers: Record<string, string> = api.requiresApiSecret && api.secret.trim() ? { "x-api-secret": api.secret.trim() } : {};
    setError(null);
    try {
      const res = await fetch("/api/export/audit", { headers });
      if (res.ok) await downloadResponse(res, "audit_log.csv");
      else setError(`Download failed (${res.status})`);
    } catch {
      setError("Download failed: the app didn't answer.");
    }
  };

  // A failed download leaves the log on screen; only a failed load has nothing to show.
  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const filtered = Object.values(filters).some(Boolean);
  const changes = open ? beforeAfterOf(open.payload) : [];
  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Card
        title={`Audit log (${data.total.toLocaleString()} events)`}
        subtitle={`Newest first, times in Eastern. ${filtered ? `${data.matched.toLocaleString()} match the filters` : "All events"}; showing the latest ${data.events.length.toLocaleString()}. Open an event for what it changed. Download the CSV for everything.`}
        actions={
          <button type="button" className={btn.secondary} onClick={() => void download()}>
            Download CSV
          </button>
        }
      >
        <div className="mb-3">
          <ChainNote c={data.chain} />
        </div>
        <DataTable
          id="audit-log"
          label="Audit log"
          rows={data.events}
          columns={columns}
          rowKey={(e) => e.id}
          maxHeight="36rem"
          filterPlaceholder="Words in the events shown…"
          onOpen={setOpen}
          toolbar={
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select aria-label="Action" className={`${inputCls} !w-auto !py-1 !text-xs`} value={filters.action} onChange={set("action")}>
                <option value="">Every action</option>
                {data.actions.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.value} ({a.count.toLocaleString()})
                  </option>
                ))}
              </select>
              <select aria-label="By" className={`${inputCls} !w-auto !py-1 !text-xs`} value={filters.actor} onChange={set("actor")}>
                <option value="">Anyone</option>
                {data.actors.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.value} ({a.count.toLocaleString()})
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-muted">
                From <input type="date" className={`${inputCls} !w-auto !py-1 !text-xs`} value={filters.from} onChange={set("from")} />
              </label>
              <label className="flex items-center gap-1 text-muted">
                to <input type="date" className={`${inputCls} !w-auto !py-1 !text-xs`} value={filters.to} onChange={set("to")} />
              </label>
              {filtered && (
                <button type="button" className={btn.link} onClick={() => setFilters(NO_FILTERS)}>
                  Clear
                </button>
              )}
            </div>
          }
          empty={<p className="p-3 text-xs text-muted">No event matches.</p>}
        />
      </Card>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `${open.action} · ${when(open.occurredAt)}` : ""} subtitle={open ? `By ${open.actor}${open.seq != null ? ` · link ${open.seq} in the chain` : " · written before the chain began"}` : undefined}>
        {open && (
          <div className="flex flex-col gap-4">
            {changes.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Before and after</h3>
                <BeforeAfter changes={changes} />
              </section>
            )}
            <section>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Everything it recorded</h3>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-fg-2"><NotFigure why={LOGGED}>{open.payload == null ? NA : JSON.stringify(open.payload, null, 2)}</NotFigure></pre>
            </section>
          </div>
        )}
      </Drawer>
    </>
  );
}
