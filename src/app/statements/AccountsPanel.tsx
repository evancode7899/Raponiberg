"use client";

import { cachedResponse, type Api } from "@/components/ledger/useApi";
import { Badge, btn, Card, ErrorNote, inputCls, Loading, selectCls } from "@/components/ui/kit";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Account = {
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  institution: string | null;
  archivedAt: string | null;
  aliases: { identifier: string; source: string }[];
  _count: { statementImports: number; transactions: number };
};

export function AccountsPanel({ api, version, onChanged }: { api: Api; version: number; onChanged: () => void }) {
  const [accounts, setAccounts] = useState(() => cachedResponse<{ accounts: Account[] }>("/api/accounts")?.accounts ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .call<{ accounts: Account[] }>("/api/accounts")
      .then((r) => setAccounts(r.accounts))
      .catch((e: Error) => setError(e.message));
  }, [api, version]);

  const run = useCallback(
    async (fn: () => Promise<string | void>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const msg = await fn();
        if (msg) setNotice(msg);
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return (
    <Card
      title="Accounts"
      subtitle={
        <>
          Created automatically from statements. Every number an institution has printed for an account is listed — a reissued card is linked when its first
          statement picks up exactly where the old one left off. If one ever isn&apos;t, merge it here. The household merge date and the classifier re-run
          live in{" "}
          <Link href="/settings?tab=household" className={btn.link}>
            Settings › Household
          </Link>
          .
        </>
      }
    >
      {notice && <p className="mb-2 text-xs text-pos">{notice}</p>}
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {!accounts ? (
        <Loading />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {accounts.map((a) => (
            <AccountRow key={a.id} a={a} all={accounts} busy={busy} run={run} api={api} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AccountRow({
  a,
  all,
  busy,
  run,
  api,
}: {
  a: Account;
  all: Account[];
  busy: boolean;
  run: (fn: () => Promise<string | void>) => Promise<void>;
  api: Api;
}) {
  const [name, setName] = useState(a.name);
  const [into, setInto] = useState("");
  const candidates = all.filter((x) => x.id !== a.id && x.type === a.type);
  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 text-xs ${a.archivedAt ? "opacity-60" : ""}`}>
      <div className="flex min-w-[18rem] flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <input className={`${inputCls} w-64 !py-1`} value={name} onChange={(e) => setName(e.target.value)} aria-label="Account name" />
          {name !== a.name && (
            <button
              type="button"
              className={btn.primary}
              disabled={busy || !name.trim()}
              onClick={() => void run(() => api.call(`/api/accounts/${a.id}`, { method: "PATCH", json: { name } }).then(() => "Renamed."))}
            >
              Rename
            </button>
          )}
          {a.archivedAt && <Badge>Archived</Badge>}
        </div>
        <span className="text-muted">
          {a.institution ?? "—"} · {(a.subtype ?? a.type).replace(/_/g, " ").toLowerCase()} · {a.aliases.map((x) => x.identifier).join(", ") || "no statements yet"} ·{" "}
          <span className="num">
            {a._count.statementImports} statements · {a._count.transactions.toLocaleString()} rows
          </span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Link href={`/transactions?accountId=${a.id}`} className={btn.ghost}>
          Transactions
        </Link>
        {candidates.length > 0 && (
          <>
            <select className={selectCls} value={into} onChange={(e) => setInto(e.target.value)} aria-label="Merge into">
              <option value="">Merge into…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {into && (
              <button
                type="button"
                className={btn.secondary}
                disabled={busy}
                onClick={() => {
                  const target = candidates.find((c) => c.id === into);
                  if (target && confirm(`Merge "${a.name}" into "${target.name}"? Its statements and identifiers move over.`)) {
                    void run(() => api.call(`/api/accounts/${a.id}`, { method: "POST", json: { intoAccountId: into } }).then(() => "Merged."));
                  }
                }}
              >
                Merge
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className={btn.secondary}
          disabled={busy}
          onClick={() =>
            void run(() => api.call(`/api/accounts/${a.id}`, { method: "PATCH", json: { archived: !a.archivedAt } }).then(() => (a.archivedAt ? "Restored." : "Archived.")))
          }
        >
          {a.archivedAt ? "Restore" : "Archive"}
        </button>
      </div>
    </li>
  );
}
