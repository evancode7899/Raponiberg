"use client";

import type { Api } from "@/components/ledger/useApi";
import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { btn, Callout, Card, downloadResponse, ErrorNote, Field, inputCls, selectCls } from "@/components/ui/kit";
import Link from "next/link";
import { BackupCard } from "./BackupCard";
import { useEffect, useRef, useState } from "react";

const WIPE_CONFIRM_PHRASE = "WIPE ALL LOCAL DATA";

type Account = { id: string; name: string; archivedAt: string | null; _count: { transactions: number } };

/** Cloud backups, exports, the database file, maintenance and the raw table browser. */
export function DataPanel({ api, requiresDbSecret }: { api: Api; requiresDbSecret: boolean }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [exportId, setExportId] = useState("all");
  const [dbSecret, setDbSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wipeTyped, setWipeTyped] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .call<{ accounts: Account[] }>("/api/accounts")
      .then((r) => setAccounts(r.accounts))
      .catch(() => {});
  }, [api]);

  const total = accounts.reduce((s, a) => s + a._count.transactions, 0);
  const dbHeaders = (): Record<string, string> => (dbSecret.trim() ? { "x-settings-database-secret": dbSecret.trim() } : {});
  const syncHeaders = (): Record<string, string> => (api.requiresApiSecret && api.secret.trim() ? { "x-api-secret": api.secret.trim() } : {});

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const msg = await fn();
      if (msg) setMessage(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  };

  const fail = async (res: Response, what: string) => {
    const j = (await res.json().catch(() => null)) as { error?: string; hint?: string } | null;
    throw new Error(j?.error ?? j?.hint ?? `${what} failed (${res.status})`);
  };

  return (
    <>
      {message && <Callout tone="good">{message}</Callout>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <BackupCard api={api} />

      <Card title="Export transactions" subtitle="Every statement row for one account or all of them, as CSV (date, account, payee, amount, how it counts, category).">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Account">
            <select className={`${selectCls} !py-2`} value={exportId} onChange={(e) => setExportId(e.target.value)}>
              <option value="all">All accounts ({total.toLocaleString()} rows)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a._count.transactions.toLocaleString()}){a.archivedAt ? " · archived" : ""}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className={btn.primary}
            disabled={busy != null}
            onClick={() =>
              void run("csv", async () => {
                const res = await fetch(`/api/export/transactions?accountId=${encodeURIComponent(exportId)}`, { headers: syncHeaders() });
                if (!res.ok) await fail(res, "Export");
                const name = await downloadResponse(res, "transactions.csv");
                return `Downloaded ${name}.`;
              })
            }
          >
            {busy === "csv" ? "Exporting…" : "Download CSV"}
          </button>
        </div>
      </Card>

      <Card
        title="Database file"
        subtitle={
          <>
            A full copy of <span className="font-mono text-fg-2">finance.db</span> — every statement, rule and setting. Restoring replaces the live database; the
            current file is copied to <span className="font-mono text-fg-2">data/backups/</span> first.
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {requiresDbSecret && (
            <Field label="Admin secret" hint="Must match SETTINGS_DATABASE_SECRET in .env" className="max-w-sm">
              <input type="password" autoComplete="off" className={inputCls} value={dbSecret} onChange={(e) => setDbSecret(e.target.value)} />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={btn.primary}
              disabled={busy != null}
              onClick={() =>
                void run("export", async () => {
                  const res = await fetch("/api/settings/database/export", { headers: dbHeaders() });
                  if (!res.ok) await fail(res, "Export");
                  const name = await downloadResponse(res, "finance_backup.db");
                  return `Backup downloaded (${name}).`;
                })
              }
            >
              {busy === "export" ? "Exporting…" : "Download backup (.db)"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <input
              ref={importRef}
              type="file"
              accept=".db,application/octet-stream,application/x-sqlite3"
              className="max-w-full text-xs text-muted file:mr-2 file:rounded-md file:border file:border-line-strong file:bg-surface-2 file:px-2.5 file:py-1 file:text-xs file:text-fg"
              onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className={btn.secondary}
              disabled={busy != null || !importFile}
              onClick={() => {
                if (!importFile || !confirm(`Replace the live database with ${importFile.name}? The current one is backed up first.`)) return;
                void run("import", async () => {
                  const fd = new FormData();
                  fd.set("file", importFile);
                  const res = await fetch("/api/settings/database/import", { method: "POST", headers: dbHeaders(), body: fd });
                  if (!res.ok) await fail(res, "Restore");
                  const j = (await res.json()) as { previousDatabaseBackedUpTo?: string | null };
                  setImportFile(null);
                  if (importRef.current) importRef.current.value = "";
                  notifyLedgerChanged();
                  return j.previousDatabaseBackedUpTo ? `Restored. The previous database was copied to ${j.previousDatabaseBackedUpTo}.` : "Restored.";
                });
              }}
            >
              {busy === "import" ? "Restoring…" : "Restore from backup"}
            </button>
          </div>
        </div>
      </Card>

      <Card title="Maintenance">
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 max-w-xl">
              <div className="font-medium text-fg">Re-run the classifier</div>
              <div className="text-xs text-muted">Re-applies every rule to rows you haven&apos;t corrected by hand, then re-matches transfers. Use after editing rules in code.</div>
            </div>
            <button
              type="button"
              className={btn.secondary}
              disabled={busy != null}
              onClick={() =>
                void run("reclassify", async () => {
                  const r = await api.call<{ changed: number }>("/api/ledger/reclassify", { method: "POST" });
                  notifyLedgerChanged();
                  return `Classifier re-run: ${r.changed} rows changed.`;
                })
              }
            >
              {busy === "reclassify" ? "Running…" : "Re-run classifier"}
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0 max-w-xl">
              <div className="font-medium text-fg">Database browser</div>
              <div className="text-xs text-muted">Read-only view of every raw table — useful for debugging a parser or a rule.</div>
            </div>
            <Link href="/database" className={btn.secondary}>
              Open browser
            </Link>
          </div>
        </div>
      </Card>

      <Card title="Danger zone" className="border-neg/40">
        <p className="text-xs leading-relaxed text-fg-2">
          Wiping deletes every account, statement, transaction, pay stub, rule and setting. The audit log is kept so the wipe stays traceable, and the stored
          statement PDFs on disk are left alone, so you can import them again. Download a backup first. Type <span className="font-mono font-semibold text-neg">{WIPE_CONFIRM_PHRASE}</span> to
          enable it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input type="text" autoComplete="off" className={`${inputCls} w-64 font-mono !text-xs`} placeholder={WIPE_CONFIRM_PHRASE} value={wipeTyped} onChange={(e) => setWipeTyped(e.target.value)} />
          <button
            type="button"
            className={btn.danger}
            disabled={busy != null || wipeTyped !== WIPE_CONFIRM_PHRASE}
            onClick={() =>
              void run("wipe", async () => {
                const res = await fetch("/api/settings/database/wipe", {
                  method: "POST",
                  headers: { ...dbHeaders(), "Content-Type": "application/json" },
                  body: JSON.stringify({ confirm: WIPE_CONFIRM_PHRASE }),
                });
                if (!res.ok) await fail(res, "Wipe");
                setWipeTyped("");
                notifyLedgerChanged();
                return "Database wiped. Import statements to start again.";
              })
            }
          >
            {busy === "wipe" ? "Wiping…" : "Wipe all data"}
          </button>
        </div>
      </Card>
    </>
  );
}
