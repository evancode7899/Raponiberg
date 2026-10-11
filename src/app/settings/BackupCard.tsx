"use client";

import type { Api } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Card, ErrorNote } from "@/components/ui/kit";
import type { BackupStatus } from "@/lib/backup/auto";
import { formatDisplayDateTime } from "@/lib/displayTime";
import { useCallback, useEffect, useState } from "react";

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** OneDrive backups: where they go, the latest one, and "Back up now" (lib/backup). */
export function BackupCard({ api }: { api: Api }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the status was read: "stale" is judged against that, since reading the clock during
  // render would give a different answer on every render.
  const [checkedAt, setCheckedAt] = useState(0);
  const show = useCallback((s: BackupStatus) => {
    setStatus(s);
    setCheckedAt(Date.now());
  }, []);

  const load = useCallback(() => {
    api
      .call<BackupStatus>("/api/system/backup")
      .then(show)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the backup status"));
  }, [api, show]);
  useEffect(load, [load]);

  const backUp = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await api.call<{ status: "created" | "unchanged"; snapshot: string; statementsCopied: number; backup: BackupStatus }>("/api/system/backup", { method: "POST" });
      show(r.backup);
      const pdfs = r.statementsCopied ? ` ${r.statementsCopied} statement PDF${r.statementsCopied === 1 ? "" : "s"} copied.` : "";
      setMessage(r.status === "created" ? `Backed up (${r.snapshot}).${pdfs}` : `Nothing changed since the last backup (${r.snapshot}).${pdfs}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backup failed");
      load();
    } finally {
      setBusy(false);
    }
  };

  const latest = status?.latest;
  const stale = latest && checkedAt ? checkedAt - new Date(latest.createdAt).getTime() > 3 * 86_400_000 : false;
  const failed = status?.last && !status.last.ok ? status.last : null;

  return (
    <Card
      title="Cloud backup"
      subtitle="The ledger and every decision file in data/, copied to OneDrive so a new or wiped computer can restore everything. Automatic every 15 minutes while the app runs, only when something changed."
      actions={
        <button type="button" className={btn.primary} disabled={busy || !status?.root} onClick={() => void backUp()}>
          {busy ? "Backing up…" : "Back up now"}
        </button>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {message && <Callout tone="good">{message}</Callout>}
        {error && <ErrorNote>{error}</ErrorNote>}
        {failed && <ErrorNote>The last {failed.reason} backup failed: {failed.error}</ErrorNote>}
        {status && !status.root && (
          <Callout tone="warn" title="No backup folder">
            Set <span className="font-mono">BACKUP_DIR</span> in <span className="font-mono">.env</span> to a folder OneDrive syncs, then restart the app.
          </Callout>
        )}
        {status?.root && (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted">Folder</dt>
            <dd className="min-w-0 break-all font-mono text-xs text-fg-2">{status.root}</dd>
            <dt className="text-muted">Latest</dt>
            <dd>
              {latest ? (
                <>
                  <span className="text-fg">{formatDisplayDateTime(new Date(latest.createdAt))}</span> <span className="text-muted">({ago(latest.createdAt)})</span>{" "}
                  {stale && <Badge tone="warn">Over 3 days old</Badge>}
                  <div className="text-xs text-muted">
                    {latest.files} files, {mb(latest.bytes)} · {latest.statements.toLocaleString()} statement PDFs mirrored · {status.snapshots} snapshot
                    {status.snapshots === 1 ? "" : "s"} kept
                  </div>
                </>
              ) : (
                <span className="text-warn">No backup yet</span>
              )}
            </dd>
            <dt className="text-muted">Automatic</dt>
            <dd className="text-fg-2">
              {status.auto ? `On, every ${status.everyMinutes} minutes` : "Off in this server (dev). The desktop app backs up on its own."}
              {status.last?.ok && <span className="text-muted"> · last check {ago(status.last.at)}</span>}
            </dd>
          </dl>
        )}
        <p className="text-xs leading-relaxed text-muted">
          To restore on a new computer: clone the app, then <span className="font-mono text-fg-2">npm install</span> and{" "}
          <span className="font-mono text-fg-2">npm run setup</span>. The backup folder&apos;s README.txt has the steps.
        </p>
      </div>
    </Card>
  );
}
