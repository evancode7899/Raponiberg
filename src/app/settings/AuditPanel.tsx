"use client";

import type { Api } from "@/components/ledger/useApi";
import { btn, Card, downloadResponse, ErrorNote, inputCls, Loading, table } from "@/components/ui/kit";
import { formatDisplayDateTime } from "@/lib/displayTime";
import { useEffect, useMemo, useState } from "react";

type Event = { id: string; occurredAt: string; action: string; actor: string; payloadJson: unknown };

/** Everything the app has changed: imports, corrections, settings, exports. */
export function AuditPanel({ api }: { api: Api }) {
  const [data, setData] = useState<{ events: Event[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .call<{ events: Event[]; total: number }>("/api/audit?limit=500")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!data || !n) return data?.events ?? [];
    return data.events.filter((e) => e.action.toLowerCase().includes(n) || e.actor.toLowerCase().includes(n) || JSON.stringify(e.payloadJson ?? "").toLowerCase().includes(n));
  }, [data, q]);

  const download = async () => {
    const headers: Record<string, string> = api.requiresApiSecret && api.secret.trim() ? { "x-api-secret": api.secret.trim() } : {};
    const res = await fetch("/api/export/audit", { headers });
    if (res.ok) await downloadResponse(res, "audit_log.csv");
    else setError(`Download failed (${res.status})`);
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;
  return (
    <Card
      title={`Audit log (${data.total.toLocaleString()} events)`}
      subtitle={`Newest first, times in Eastern. Showing the latest ${data.events.length}; download the CSV for everything. Click a row for its details.`}
      actions={
        <>
          <input type="search" className={`${inputCls} w-48 !py-1 !text-xs`} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className={btn.secondary} onClick={() => void download()}>
            Download CSV
          </button>
        </>
      }
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>When</th>
              <th className={table.th}>Action</th>
              <th className={table.th}>By</th>
              <th className={table.th}>Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const payload = e.payloadJson == null ? "" : JSON.stringify(e.payloadJson);
              const isOpen = open === e.id;
              return (
                <tr key={e.id} className={`${table.trHover} cursor-pointer align-top`} onClick={() => setOpen(isOpen ? null : e.id)}>
                  <td className={`${table.td} num whitespace-nowrap text-xs text-muted`}>{formatDisplayDateTime(new Date(e.occurredAt))}</td>
                  <td className={`${table.td} whitespace-nowrap font-mono text-xs text-fg`}>{e.action}</td>
                  <td className={`${table.td} whitespace-nowrap text-xs text-muted`}>{e.actor}</td>
                  <td className={`${table.td} w-full max-w-0 font-mono text-[11px] text-muted`}>
                    {isOpen ? <pre className="whitespace-pre-wrap break-all text-fg-2">{JSON.stringify(e.payloadJson, null, 2)}</pre> : <div className="truncate">{payload || "—"}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
