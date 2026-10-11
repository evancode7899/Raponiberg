"use client";

import { btn, Card, ErrorNote, inputCls, PageBody } from "@/components/ui/kit";
import { useCallback, useEffect, useState } from "react";

const PAGE_SIZE = 50;

type TableMeta = { name: string; count: number };

/** ISO-8601 timestamps as returned by JSON APIs (Prisma Date → string). */
const ISO_DATE_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function prettyJsonFromUnknown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return null;
    }
  }
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Display-only formatting; underlying row data is unchanged.
 * Pretty-prints JSON, humanizes dates, formats *Cents as USD.
 */
function formatDatabaseCell(column: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "bigint") return value.toString();
  const pretty = prettyJsonFromUnknown(value);
  if (pretty !== null) return pretty;
  if (column.endsWith("Cents") && typeof value === "number" && Number.isFinite(value)) {
    return (value / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  }
  if (typeof value === "string" && ISO_DATE_START.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString("en-US");
  return String(value);
}

export function DatabaseBrowserClient({ requiresDbSecret }: { requiresDbSecret: boolean }) {
  const [dbSecret, setDbSecret] = useState("");
  const [tables, setTables] = useState<TableMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState("Account");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);

  const headers = useCallback((): HeadersInit => {
    const t = dbSecret.trim();
    return t ? { "x-settings-database-secret": t } : {};
  }, [dbSecret]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setListError(null);
      try {
        const res = await fetch("/api/settings/database/browse", { headers: headers() });
        const j = (await res.json()) as { ok: true; tables: TableMeta[] } | { ok: false; error?: string };
        if (!res.ok || !j.ok) throw new Error(!j.ok && j.error ? j.error : `Failed to load tables (${res.status})`);
        if (!cancelled) setTables(j.tables);
      } catch (e) {
        if (!cancelled) {
          setListError(e instanceof Error ? e.message : "Request failed");
          setTables(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [headers]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const sp = new URLSearchParams({ table: active, page: String(page), limit: String(PAGE_SIZE) });
        const res = await fetch(`/api/settings/database/browse?${sp}`, { headers: headers() });
        const j = (await res.json()) as { ok: true; columns: string[]; rows: Record<string, unknown>[]; total: number } | { ok: false; error?: string };
        if (!res.ok || !j.ok) throw new Error(!j.ok && j.error ? j.error : `Failed to load rows (${res.status})`);
        if (!cancelled) {
          setColumns(j.columns);
          setRows(j.rows);
          setTotal(j.total);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Request failed");
          setColumns([]);
          setRows([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, page, headers]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageBody>
      <p className="-mt-1 text-xs text-muted">Read-only. JSON, dates and cent columns are formatted for display only.</p>
      {requiresDbSecret && (
        <label className="flex max-w-md flex-col gap-1 text-xs">
          <span className="font-medium text-fg-2">Settings database secret</span>
          <input
            type="password"
            autoComplete="off"
            value={dbSecret}
            onChange={(e) => setDbSecret(e.target.value)}
            className={inputCls}
            placeholder="Same value as SETTINGS_DATABASE_SECRET"
          />
        </label>
      )}
      {listError && <ErrorNote>{listError}</ErrorNote>}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="Tables" className="flex flex-col gap-px self-start rounded-lg border border-line bg-surface p-1.5">
          {(tables ?? []).map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => {
                setActive(t.name);
                setPage(1);
              }}
              className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                active === t.name ? "bg-accent-soft font-medium text-fg" : "text-fg-2 hover:bg-surface-2"
              }`}
            >
              <span className="truncate font-mono">{t.name}</span>
              <span className={`num shrink-0 text-[10px] ${t.count ? "text-muted" : "text-faint"}`}>{t.count.toLocaleString()}</span>
            </button>
          ))}
        </nav>
        <Card
          title={<span className="font-mono">{active}</span>}
          subtitle={loading ? "Loading…" : `${total.toLocaleString()} row${total === 1 ? "" : "s"}`}
          actions={
            totalPages > 1 ? (
              <div className="flex items-center gap-1.5 text-xs">
                <button type="button" className={btn.secondary} disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  ← Prev
                </button>
                <span className="num px-1 text-muted">
                  {page} / {totalPages}
                </span>
                <button type="button" className={btn.secondary} disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                  Next →
                </button>
              </div>
            ) : undefined
          }
        >
          {loadError && <ErrorNote>{loadError}</ErrorNote>}
          <div className="app-scroll max-h-[70vh] overflow-auto rounded border border-line">
            <table className="w-max min-w-full border-collapse text-left text-[11px]">
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr className="border-b border-line-strong text-[10px] uppercase tracking-wide text-muted">
                  {columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={Math.max(1, columns.length)} className="px-3 py-4 text-muted">
                      No rows.
                    </td>
                  </tr>
                ) : (
                  rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-line last:border-b-0 hover:bg-surface-2">
                      {columns.map((c) => {
                        const text = formatDatabaseCell(c, row[c]);
                        const multiline = text.includes("\n");
                        return (
                          <td
                            key={c}
                            className={`whitespace-pre-wrap break-words px-2 py-1 align-top font-mono text-[10px] leading-snug text-fg-2 ${
                              multiline ? "max-h-72 min-w-[10rem] max-w-[min(42rem,96vw)] overflow-y-auto" : "max-w-[22rem] break-all"
                            }`}
                          >
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </PageBody>
  );
}
