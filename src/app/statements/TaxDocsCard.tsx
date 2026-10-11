"use client";

import type { Api } from "@/components/ledger/useApi";
import { Badge, btn, Card, ErrorNote } from "@/components/ui/kit";
import { formatDisplayDateTime } from "@/lib/displayTime";
import type { TaxDocsSummary } from "@/lib/taxdocs/summary";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/**
 * The second source folder: filed tax returns and the forms behind them (W-2s, 1099s,
 * K-1s), one subfolder per year. Read into data/tax-documents.json; the Taxes page uses
 * them as each finished year's figures of record and checks its model against the
 * returns line by line.
 */
export function TaxDocsCard({ api, refreshKey }: { api: Api; refreshKey: number }) {
  const [summary, setSummary] = useState<TaxDocsSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .call<TaxDocsSummary>("/api/tax/documents")
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [api, refreshKey]);

  const scan = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSummary(await api.call<TaxDocsSummary>("/api/tax/documents", { method: "POST" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }, [api]);

  if (!summary) return null;
  return (
    <Card
      title="Tax documents"
      subtitle="Filed returns, W-2s, 1099s and K-1s, one subfolder per year. A finished year's forms are its figures of record on the Taxes page, and the model is checked against the filed return line by line."
      actions={
        summary.configured ? (
          <button type="button" className={btn.secondary} disabled={busy} onClick={() => void scan()}>
            {busy ? "Reading…" : "Scan tax documents folder"}
          </button>
        ) : undefined
      }
    >
      {!summary.configured ? (
        <p className="text-sm text-muted">
          No tax documents folder is set up. Add <code className="text-fg-2">TAX_DOCS_DIR</code> to <code className="text-fg-2">.env</code> (the folder holding your filed returns) and restart the app.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted">
            <code className="break-all text-fg-2" title={summary.folder ?? ""}>
              {summary.folder}
            </code>
            {summary.scannedAt ? ` · read ${formatDisplayDateTime(new Date(summary.scannedAt))} · ${summary.total} documents` : " · not read yet"}. The statements folder scan reads it too.
          </p>
          {summary.years.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5 text-xs">
              {summary.years.map((y) => (
                <li key={String(y.year)} className="flex flex-wrap items-center gap-1.5">
                  <span className="num w-12 font-medium text-fg">{y.year ?? "—"}</span>
                  {y.kinds.map((k) => (
                    <Badge key={k.kind} tone={k.kind.startsWith("RETURN_") ? "pos" : k.kind === "OTHER" || k.kind === "FOREIGN" ? "neutral" : "info"}>
                      {k.count > 1 ? `${k.count} × ` : ""}
                      {k.label}
                    </Badge>
                  ))}
                  {y.year != null && y.filed.length > 0 && y.checkable && (
                    <Link href={`/taxes?tab=filed&year=${y.year}`} className="text-accent hover:underline">
                      Check against the filed return →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          {summary.issues.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-fg-2">
                {summary.issues.length} document{summary.issues.length === 1 ? "" : "s"} only partly read
              </summary>
              <ul className="mt-1 flex flex-col gap-1 text-fg-2">
                {summary.issues.map((i, n) => (
                  <li key={n}>
                    <span className="text-fg">{i.file}</span> — {i.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Card>
  );
}
