"use client";

import type { Api } from "@/components/ledger/useApi";
import { notify } from "@/components/ui/Feedback";
import { btn } from "@/components/ui/kit";
import { formatDisplayDateTime } from "@/lib/displayTime";
import type { DeletedDocument } from "@/lib/ingest/deletedDocuments";
import { useEffect, useState } from "react";

/**
 * Documents deleted lately, each with Put back: its stored file is read again
 * (lib/ingest/deletedDocuments.ts), long after the moment's Undo has passed. Folded away,
 * and drawn only when there is one.
 */
export function DeletedDocuments({ api, onChanged, version }: { api: Api; onChanged: () => void; version: number }) {
  const [deleted, setDeleted] = useState<DeletedDocument[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api
      .call<{ deleted: DeletedDocument[] }>("/api/documents/deleted")
      .then((r) => setDeleted(r.deleted))
      .catch(() => setDeleted([]));
  }, [api, version]);
  if (!deleted.length) return null;
  const putBack = async (d: DeletedDocument) => {
    setBusy(d.eventId);
    try {
      const r = await api.call<{ deleted: DeletedDocument[]; outcome: { ok: boolean; message?: string } }>("/api/documents/deleted", { method: "POST", json: { eventId: d.eventId } });
      setDeleted(r.deleted);
      notify(r.outcome.ok ? `Put back "${d.title}".` : `Couldn't put back "${d.title}": ${r.outcome.message ?? "it wasn't read"}`, { tone: r.outcome.ok ? "good" : "bad" });
      if (r.outcome.ok) onChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : "Couldn't put it back", { tone: "bad" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <details className="mt-4 border-t border-line pt-3 text-xs">
      <summary className="cursor-pointer text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus">
        Deleted lately ({deleted.length}): put one back from its stored file
      </summary>
      <ul className="mt-2 flex flex-col divide-y divide-line">
        {deleted.map((d) => (
          <li key={d.eventId} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-fg-2" title={d.fileName ?? undefined}>
              {d.title}
            </span>
            <span className="shrink-0 text-muted">deleted {formatDisplayDateTime(new Date(d.deletedAt))}</span>
            <button type="button" className={btn.secondary} disabled={busy !== null} onClick={() => void putBack(d)}>
              {busy === d.eventId ? "Reading it again…" : "Put back"}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
