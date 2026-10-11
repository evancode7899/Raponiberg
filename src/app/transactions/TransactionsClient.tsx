"use client";

import { TransactionTable, type TxnRow } from "@/components/ledger/TransactionTable";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { useApi } from "@/components/ledger/useApi";
import { useChanged } from "@/components/useChanged";
import { btn, Card, EmptyState, ErrorNote, Field, inputCls, Loading, PageBody, selectCls } from "@/components/ui/kit";
import { CATEGORIES } from "@/lib/classifier/taxonomy";
import { addDays, startOfMonth } from "@/lib/dates/isoDate";
import { usd0 } from "@/lib/formatMoney";
import { useCallback, useEffect, useMemo, useState } from "react";

type Filters = { q: string; from: string; to: string; accountId: string; category: string; lane: string; needsReview: boolean };
type Response = { transactions: TxnRow[]; total: { count: number; inCents: number; outCents: number } };

const LANE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "INCOME,EXPENSE", label: "Income & spending" },
  { value: "EXPENSE", label: "Spending" },
  { value: "INCOME", label: "Income" },
  { value: "TRANSFER", label: "Transfers between accounts" },
  { value: "EXTERNAL_TRANSFER", label: "Untracked money in/out" },
  { value: "CONTRIBUTION_EMPLOYEE,CONTRIBUTION_EMPLOYER,CONTRIBUTION_PERSONAL", label: "Retirement contributions" },
];

const today = () => new Date().toISOString().slice(0, 10);
const PRESETS: { id: string; label: string; range: () => [string, string] }[] = [
  { id: "30d", label: "30 days", range: () => [addDays(today(), -30), ""] },
  { id: "month", label: "This month", range: () => [startOfMonth(today()), ""] },
  { id: "lastMonth", label: "Last month", range: () => [startOfMonth(addDays(startOfMonth(today()), -1)), addDays(startOfMonth(today()), -1)] },
  { id: "ytd", label: "This year", range: () => [`${today().slice(0, 4)}-01-01`, ""] },
  { id: "12m", label: "12 months", range: () => [addDays(today(), -365), ""] },
  { id: "all", label: "All", range: () => ["", ""] },
];

const CATEGORY_GROUPS = [...new Set(CATEGORIES.map((c) => c.group))];

const EMPTY: Filters = { q: "", from: "", to: "", accountId: "", category: "", lane: "", needsReview: false };

function readUrl(): Filters {
  const sp = new URLSearchParams(window.location.search);
  return {
    q: sp.get("q") ?? "",
    from: sp.get("from") ?? "",
    to: sp.get("to") ?? "",
    accountId: sp.get("accountId") ?? "",
    category: sp.get("category") ?? "",
    lane: sp.get("lane") ?? "",
    needsReview: sp.get("needsReview") === "1",
  };
}

export function TransactionsClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [f, setF] = useState<Filters | null>(null);
  const [qDraft, setQDraft] = useState("");
  const [limit, setLimit] = useState(300);
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; name: string; archivedAt: string | null }[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const init = readUrl();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount: the server render can't see the URL, so reading it during render would mismatch hydration
    setF(init);
    setQDraft(init.q);
  }, []);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<{ accounts: { id: string; name: string; archivedAt: string | null }[] }>("/api/accounts")
      .then((r) => setAccounts(r.accounts))
      .catch(() => {});
  }, [api]);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setF((cur) => (cur && cur.q !== qDraft ? { ...cur, q: qDraft } : cur)), 250);
    return () => clearTimeout(t);
  }, [qDraft]);

  const query = useMemo(() => {
    if (!f) return null;
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (k === "needsReview") {
        if (v) sp.set(k, "1");
      } else if (v) sp.set(k, String(v));
    }
    return sp;
  }, [f]);

  useEffect(() => {
    if (!query) return;
    const url = new URL(window.location.href);
    url.search = query.toString();
    window.history.replaceState(null, "", url);
  }, [query]);

  if (useChanged([api, query, limit, version]) && api.ready && query) setLoading(true);
  useEffect(() => {
    if (!api.ready || !query) return;
    const sp = new URLSearchParams(query);
    sp.set("limit", String(limit));
    api
      .call<Response>(`/api/transactions?${sp}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [api, query, limit, version]);

  const set = (patch: Partial<Filters>) => {
    setLimit(300);
    setF((cur) => ({ ...(cur ?? EMPTY), ...patch }));
  };
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const active = f && (f.q || f.from || f.to || f.accountId || f.category || f.lane || f.needsReview);

  return (
    <PageBody>
      <ApiSecretField api={api} />
      <Card bodyClassName="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Search" className="min-w-[16rem] flex-1">
            <input
              type="search"
              className={inputCls}
              placeholder="Payee, memo or merchant…"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Account">
            <select className={`${selectCls} !py-2`} value={f?.accountId ?? ""} onChange={(e) => set({ accountId: e.target.value })}>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.archivedAt ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select className={`${selectCls} !py-2`} value={f?.category ?? ""} onChange={(e) => set({ category: e.target.value })}>
              <option value="">All categories</option>
              {CATEGORY_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {CATEGORIES.filter((c) => c.group === g).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Counts as">
            <select className={`${selectCls} !py-2`} value={f?.lane ?? ""} onChange={(e) => set({ lane: e.target.value })}>
              {LANE_FILTERS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => {
              const [a, b] = p.range();
              const on = f?.from === a && f?.to === b;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-muted hover:text-fg"}`}
                  onClick={() => set({ from: a, to: b })}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            From
            <input type="date" className={`${inputCls} !py-1 !text-xs`} value={f?.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            to
            <input type="date" className={`${inputCls} !py-1 !text-xs`} value={f?.to ?? ""} onChange={(e) => set({ to: e.target.value })} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg-2">
            <input type="checkbox" checked={f?.needsReview ?? false} onChange={(e) => set({ needsReview: e.target.checked })} />
            Only rows waiting for review
          </label>
          {active && (
            <button
              type="button"
              className={`${btn.link} ml-auto`}
              onClick={() => {
                setQDraft("");
                set(EMPTY);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        api.ready ? <Loading /> : null
      ) : (
        <Card
          title={
            <span className="num">
              {data.total.count.toLocaleString()} transaction{data.total.count === 1 ? "" : "s"}
              {loading && <span className="ml-2 text-xs font-normal text-muted">updating…</span>}
            </span>
          }
          subtitle={
            <span className="num">
              In <span className="text-pos">{usd0(data.total.inCents)}</span> · out {usd0(-data.total.outCents)} · net {usd0(data.total.inCents + data.total.outCents)}
            </span>
          }
        >
          {data.transactions.length === 0 ? (
            <EmptyState title="No transactions match">Try a wider date range or clear a filter.</EmptyState>
          ) : (
            <>
              <TransactionTable api={api} rows={data.transactions} onChanged={refresh} maxHeight="calc(100dvh - 22rem)" />
              {data.total.count > data.transactions.length && (
                <div className="mt-3 flex items-center gap-3 text-xs text-muted">
                  Showing the latest {data.transactions.length.toLocaleString()} of {data.total.count.toLocaleString()}.
                  {limit < 2000 && (
                    <button type="button" className={btn.secondary} onClick={() => setLimit(Math.min(2000, limit * 3))}>
                      Show more
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </PageBody>
  );
}
