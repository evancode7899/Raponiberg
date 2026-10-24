"use client";

import { CategorySelect, LaneBadge, LaneSelect } from "@/components/ledger/TransactionTable";
import type { Api } from "@/components/ledger/useApi";
import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { btn, Card, EmptyState, ErrorNote, inputCls, Loading, Segmented, table } from "@/components/ui/kit";
import { isGenericMerchantKey } from "@/lib/classifier/merchants";
import type { Lane } from "@/lib/classifier/taxonomy";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { formatUsdFromCents, usd0 } from "@/lib/formatMoney";
import { useEffect, useMemo, useState } from "react";

export type ReviewRow = {
  id: string;
  date: string;
  amountCents: number;
  payee: string | null;
  detail: string | null;
  section: string | null;
  lane: Lane | null;
  merchantKey: string | null;
  classifiedBy: string | null;
  confidence: string | null;
  counterpartyInstitution: string | null;
  account: { id: string; name: string };
  category: { name: string } | null;
  statementImport: { status: string } | null;
};

/** A row's proof: as its statement prints it, why the classifier wasn't sure, and where it counts (book/proof/rowProof). */
export const rowProof = (r: Pick<ReviewRow, "id" | "amountCents">) => ({ descriptor: { report: "row" as const, rowId: r.id }, shownCents: r.amountCents });

type Group = { key: string; merchantKey: string | null; rows: ReviewRow[]; totalCents: number; accounts: string[] };

/**
 * The classifier's open questions, one card per merchant (checks and deposits that name
 * no merchant get one card each). Answering a merchant teaches a rule for every past and
 * future row from it; "Looks right" keeps the guess and clears the flag.
 */
export function CategorizeQueue({ api, onCount }: { api: Api; onCount: (n: number) => void }) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<"amount" | "rows" | "recent">("amount");
  const [q, setQ] = useState("");

  useEffect(() => {
    api
      .call<{ needsReview: ReviewRow[] }>("/api/ledger/review")
      .then((r) => setRows(r.needsReview))
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const groups = useMemo<Group[]>(() => {
    if (!rows) return [];
    const m = new Map<string, Group>();
    for (const r of rows) {
      const key = isGenericMerchantKey(r.merchantKey) ? `row:${r.id}` : r.merchantKey!;
      const g = m.get(key) ?? { key, merchantKey: key.startsWith("row:") ? null : key, rows: [], totalCents: 0, accounts: [] };
      g.rows.push(r);
      g.totalCents += r.amountCents;
      if (!g.accounts.includes(r.account.name)) g.accounts.push(r.account.name);
      m.set(key, g);
    }
    return [...m.values()];
  }, [rows]);

  const remaining = groups.filter((g) => !done.has(g.key));
  const remainingRows = remaining.reduce((s, g) => s + g.rows.length, 0);
  useEffect(() => onCount(remainingRows), [remainingRows, onCount]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = remaining.filter(
      (g) => !needle || (g.merchantKey ?? "").toLowerCase().includes(needle) || g.rows.some((r) => (r.payee ?? "").toLowerCase().includes(needle)),
    );
    const latest = (g: Group) => g.rows.reduce((d, r) => (r.date > d ? r.date : d), "");
    return list.sort((a, b) =>
      sort === "rows" ? b.rows.length - a.rows.length : sort === "recent" ? latest(b).localeCompare(latest(a)) : Math.abs(b.totalCents) - Math.abs(a.totalCents),
    );
  }, [remaining, q, sort]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!rows) return <Loading label="Gathering open questions…" />;
  const total = rows.length;
  const answered = total - remainingRows;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-[14rem] flex-1">
            <div className="flex items-baseline justify-between text-xs text-muted">
              <span>
                <span className="num text-base font-semibold text-fg">{remainingRows.toLocaleString()}</span> rows from{" "}
                <span className="num font-medium text-fg-2">{remaining.length}</span> merchants left
              </span>
              {answered > 0 && <span className="num text-pos">{answered} done this visit</span>}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${total ? (answered / total) * 100 : 100}%` }} />
            </div>
          </div>
          <input type="search" className={`${inputCls} w-56`} placeholder="Find a merchant…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Segmented
            ariaLabel="Sort"
            options={[
              { value: "amount", label: "Biggest $" },
              { value: "rows", label: "Most rows" },
              { value: "recent", label: "Recent" },
            ]}
            value={sort}
            onChange={setSort}
          />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Statements keep counting while rows wait here — the guess shown is what&apos;s used. Choosing a category for a merchant teaches a rule: every
          past and future row from it follows (rows you&apos;ve fixed one by one stay as you set them).
        </p>
      </Card>

      {shown.length === 0 ? (
        <EmptyState title={remaining.length === 0 ? "Nothing left to review" : "No merchant matches"}>
          {remaining.length === 0 ? "Every row has a confident category." : "Clear the search to see everything."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.slice(0, 60).map((g) => (
            <GroupCard key={g.key} group={g} api={api} onDone={() => setDone((d) => new Set(d).add(g.key))} />
          ))}
        </ul>
      )}
      {shown.length > 60 && <p className="text-center text-xs text-muted">Showing the first 60 merchants — they disappear as you answer them.</p>}
    </div>
  );
}

function GroupCard({ group, api, onDone }: { group: Group; api: Api; onDone: () => void }) {
  const first = group.rows[0]!;
  const guess = first.category?.name ?? "Other";
  const [category, setCategory] = useState(guess);
  const [lane, setLane] = useState<Lane | "">("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      notifyLedgerChanged();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  };

  const apply = () =>
    run(async () => {
      if (group.merchantKey) {
        await api.call(`/api/transactions/${first.id}`, { method: "PATCH", json: { category, lane: lane || undefined, applyToMerchant: true } });
      } else {
        for (const r of group.rows) await api.call(`/api/transactions/${r.id}`, { method: "PATCH", json: { category, lane: lane || undefined } });
      }
    });
  const accept = () =>
    run(async () => {
      for (const r of group.rows) await api.call(`/api/transactions/${r.id}`, { method: "PATCH", json: { reviewed: true } });
    });
  const changed = category !== guess || lane !== "";

  return (
    <li className={`rounded-lg border border-line bg-surface transition-opacity ${busy ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button type="button" className="min-w-[14rem] flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <div className="flex items-baseline gap-2">
            <span className="text-faint">{open ? "▾" : "▸"}</span>
            <span className="truncate text-sm font-semibold text-fg">{group.merchantKey ?? first.payee ?? "—"}</span>
            <span className={`num shrink-0 text-sm font-medium ${group.totalCents > 0 ? "text-pos" : "text-fg-2"}`}>{usd0(group.totalCents)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-4 text-xs text-muted">
            <span>
              {group.rows.length} row{group.rows.length === 1 ? "" : "s"} · {group.accounts.join(", ")}
            </span>
            <span className="text-faint">·</span>
            <span className="flex items-center gap-1">
              guess: <LaneBadge lane={first.lane} /> <span className="text-fg-2">{guess}</span>
            </span>
            {!group.merchantKey && first.detail && <span className="truncate">“{first.detail}”</span>}
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={btn.secondary} disabled={busy} onClick={() => void accept()} title="Keep the classifier's guess">
            ✓ Looks right
          </button>
          <span className="px-1 text-xs text-faint">or</span>
          <CategorySelect value={category} onChange={setCategory} />
          <LaneSelect value={lane} onChange={setLane} />
          <button type="button" className={btn.primary} disabled={busy || !changed} onClick={() => void apply()}>
            {group.merchantKey ? "Apply to merchant" : "Apply"}
          </button>
        </div>
      </div>
      {error && <div className="px-4 pb-2 text-xs text-neg">{error}</div>}
      {open && (
        <div className="border-t border-line px-4 py-2">
          <table className={table.table}>
            <tbody>
              {group.rows.map((r) => (
                <tr key={r.id} className={table.tr}>
                  <td className={`${table.td} num whitespace-nowrap text-muted`}>{r.date.slice(0, 10)}</td>
                  <td className={`${table.td} w-full`}>
                    <div className="text-fg-2">{r.payee}</div>
                    {r.detail && <div className="text-[11px] text-muted">{r.detail}</div>}
                  </td>
                  <td className={`${table.td} whitespace-nowrap text-xs text-muted`}>{r.account.name}</td>
                  <td className={table.tdR}>
                    <ProofValue proof={rowProof(r)}>{formatUsdFromCents(r.amountCents)}</ProofValue>
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
