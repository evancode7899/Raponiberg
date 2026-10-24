"use client";

import { LaneBadge } from "@/components/ledger/TransactionTable";
import { cachedResponse, type Api } from "@/components/ledger/useApi";
import { Badge, btn, Card, EmptyState, ErrorNote, inputCls, Loading, Segmented, table, type Tone } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { sortRows, SortTh, useSort } from "@/components/ui/sort";
import type { Lane } from "@/lib/classifier/taxonomy";
import { formatUsdFromCents } from "@/lib/formatMoney";
import { useCallback, useEffect, useMemo, useState } from "react";

type Section = {
  id: string;
  status: "PENDING_REVIEW" | "COMMITTED" | "DISCREPANT";
  isSummary: boolean;
  periodStart: string;
  periodEnd: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  growthCents: number;
  feesCents: number;
  reconciliationDeltaCents: number;
  checksJson: { label: string; expectedCents: number; actualCents: number; passed: boolean }[] | null;
  account: { id: string; name: string };
  _count: { transactions: number };
};

type Doc = {
  id: string;
  title: string;
  institution: string;
  kind: string;
  parserId: string;
  originalFileName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  warningsJson: string[] | null;
  _count: { payStubs: number };
  statementImports: Section[];
};

type Row = {
  id: string;
  date: string;
  amountCents: number;
  payee: string | null;
  section: string | null;
  detail: string | null;
  lane: Lane | null;
  datePrecision: string;
  needsReview: boolean;
  classifiedBy: string | null;
  category: { name: string } | null;
  transferLeg: { matchId: string } | null;
};

const STATUS: Record<Section["status"], { tone: Tone; label: string }> = {
  COMMITTED: { tone: "pos", label: "Committed" },
  PENDING_REVIEW: { tone: "warn", label: "Awaiting commit" },
  DISCREPANT: { tone: "neg", label: "Doesn't tie out" },
};

const d10 = (s: string | null) => (s ? s.slice(0, 10) : "—");

export function DocumentsPanel({ api, version, onChanged }: { api: Api; version: number; onChanged: () => void }) {
  const [docs, setDocs] = useState(() => cachedResponse<{ documents: Doc[] }>("/api/statements")?.documents ?? null);
  const [filter, setFilter] = useState<"all" | "attention">("all");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .call<{ documents: Doc[] }>(`/api/statements${filter === "attention" ? "?status=attention" : ""}`)
      .then((r) => setDocs(r.documents))
      .catch((e: Error) => setError(e.message));
  }, [api, version, filter]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!docs || !n) return docs;
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(n) ||
        (d.originalFileName ?? "").toLowerCase().includes(n) ||
        d.institution.toLowerCase().includes(n) ||
        d.statementImports.some((s) => s.account.name.toLowerCase().includes(n)),
    );
  }, [docs, q]);

  return (
    <Card
      title={docs ? `Documents (${docs.length})` : "Documents"}
      subtitle="Every imported file and what it contributed. Delete a document to remove everything it added — e.g. to replace it with a corrected statement."
      actions={
        <>
          <input type="search" className={`${inputCls} w-52 !py-1 !text-xs`} placeholder="Filter by name or account…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Segmented
            options={[
              { value: "all", label: "All" },
              { value: "attention", label: "Needs attention" },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {!shown ? (
        <Loading />
      ) : shown.length === 0 ? (
        <EmptyState title={filter === "attention" ? "Everything is committed" : "No documents"}>
          {filter === "attention" ? "No statement is waiting on a decision." : q ? "Nothing matches the filter." : "Import statements on the Import tab."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((d) => (
            <li key={d.id} className="rounded-md border border-line">
              <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-fg">{d.title}</div>
                  <div className="num text-xs text-muted">
                    {d.originalFileName ?? "—"} · {d10(d.periodStart)} → {d10(d.periodEnd)} · {d.parserId === "manual" ? "hand-parsed" : d.parserId}
                    {d.kind === "PERIOD_SUMMARY" && " · summary (fills gaps only)"}
                    {d.kind === "SUPPORTING" && " · supporting document (no ledger rows)"}
                    {d._count.payStubs > 0 && ` · ${d._count.payStubs} pay stubs`}
                  </div>
                  {d.warningsJson?.map((w, i) => (
                    <div key={i} className="mt-0.5 text-xs text-warn">
                      {w}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className={btn.danger}
                  disabled={busy === d.id}
                  onClick={() => {
                    if (confirm(`Delete "${d.title}" and everything it added to the ledger?`)) void run(d.id, () => api.call(`/api/documents/${d.id}`, { method: "DELETE" }));
                  }}
                >
                  Delete
                </button>
              </div>
              {d.statementImports.length > 0 && (
                <ul className="flex flex-col border-t border-line">
                  {d.statementImports.map((s) => (
                    <SectionRow
                      key={s.id}
                      s={s}
                      api={api}
                      busy={busy === s.id}
                      onCommit={(force) => void run(s.id, () => api.call(`/api/statements/${s.id}/commit`, { method: "POST", json: { force } }))}
                    />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SectionRow({ s, api, busy, onCommit }: { s: Section; api: Api; busy: boolean; onCommit: (force: boolean) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState(false);
  // Statement order until a header is clicked.
  const { sort, toggle: toggleSort } = useSort(null);
  const failed = s.checksJson?.filter((c) => !c.passed) ?? [];
  // Only a committed statement is in the Book: it (and its rows) open their proofs.
  const inBook = s.status === "COMMITTED";

  const toggle = async () => {
    setOpen(!open);
    if (!rows) {
      const r = await api.call<{ statement: { transactions: Row[] } }>(`/api/statements/${s.id}`);
      setRows(r.statement.transactions);
    }
  };

  return (
    <li className="bg-surface-2 px-3 py-2 text-xs [&:not(:first-child)]:border-t [&:not(:first-child)]:border-line">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
        <span className="font-medium text-fg">{s.account.name}</span>
        <span className="num text-muted">
          {d10(s.periodStart)} → {d10(s.periodEnd)} · {formatUsdFromCents(s.openingBalanceCents)} →{" "}
          <ProofValue proof={inBook ? { descriptor: { report: "statement", statementId: s.id }, shownCents: s.closingBalanceCents } : undefined}>{formatUsdFromCents(s.closingBalanceCents)}</ProofValue>
          {(s.growthCents !== 0 || s.feesCents !== 0) && ` · market ${formatUsdFromCents(s.growthCents)} · fees ${formatUsdFromCents(s.feesCents)}`}
        </span>
        <button type="button" className={btn.link} onClick={() => void toggle()}>
          {open ? "Hide rows" : `${s._count.transactions} rows`}
        </button>
        {s.status !== "COMMITTED" && (
          <button type="button" className={`${btn.primary} ml-auto`} disabled={busy} onClick={() => onCommit(s.status === "DISCREPANT")}>
            {s.status === "DISCREPANT" ? "Commit anyway" : "Commit"}
          </button>
        )}
      </div>
      {s.status === "DISCREPANT" && (
        <p className="mt-1 text-neg">
          Off by {formatUsdFromCents(s.reconciliationDeltaCents)}
          {failed.length > 0 && ` · failed: ${failed.map((c) => `${c.label} (${formatUsdFromCents(c.expectedCents)} vs ${formatUsdFromCents(c.actualCents)})`).join("; ")}`}. Committing
          anyway shows the gap as “unexplained” on Net worth.
        </p>
      )}
      {open && rows && (
        <div className={`${table.wrap} mt-2 max-h-80 overflow-y-auto rounded border border-line bg-surface`}>
          <table className={table.table}>
            <thead className={`${table.head} sticky top-0 bg-surface`}>
              <tr>
                <SortTh k="date" label="Date" sort={sort} toggle={toggleSort} />
                <SortTh k="name" label="Description" sort={sort} toggle={toggleSort} />
                <th className={table.th}>Counts as</th>
                <th className={table.th}>Category</th>
                <SortTh k="amount" label="Amount" sort={sort} toggle={toggleSort} right />
              </tr>
            </thead>
            <tbody>
              {sortRows(rows, sort, { date: (r) => r.date, amount: (r) => r.amountCents, name: (r) => r.payee }).map((r) => (
                <tr key={r.id} className={table.tr}>
                  <td className={`${table.td} num whitespace-nowrap text-muted`}>
                    {r.date.slice(0, 10)}
                    {r.datePrecision === "PERIOD" && <span title="Period total, no exact date"> ~</span>}
                  </td>
                  <td className={`${table.td} text-fg-2`}>
                    {r.payee}
                    {r.section && <span className="ml-1 text-faint">[{r.section}]</span>}
                  </td>
                  <td className={`${table.td} whitespace-nowrap`}>
                    <LaneBadge lane={r.lane} />
                    {r.transferLeg && <span className="ml-1 text-pos">· paired</span>}
                    {r.needsReview && <span className="ml-1 text-warn">· review</span>}
                  </td>
                  <td className={`${table.td} text-fg-2`}>{r.category?.name ?? "—"}</td>
                  <td className={table.tdR}>
                    <ProofValue proof={inBook && !s.isSummary ? { descriptor: { report: "row", rowId: r.id }, shownCents: r.amountCents } : undefined}>{formatUsdFromCents(r.amountCents)}</ProofValue>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}
