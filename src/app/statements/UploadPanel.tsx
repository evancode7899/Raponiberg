"use client";

import type { Api } from "@/components/ledger/useApi";
import { Badge, btn, Card, ErrorNote } from "@/components/ui/kit";
import { formatUsdFromCents } from "@/lib/formatMoney";
import type { FileOutcome } from "@/lib/ingest/importFiles";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TaxDocsCard } from "./TaxDocsCard";

type UploadResponse = {
  outcomes: FileOutcome[];
  maintenance: { transfers: { matched: number; untrackedCardPayments: number }; payStubsLinked: number } | null;
  /** Set for folder scans. */
  folder?: string;
  scanned?: number;
};

const isDuplicate = (o: FileOutcome) => !o.ok && o.reason.startsWith("DUPLICATE");
const isUnrecognized = (o: FileOutcome) => !o.ok && o.reason === "UNRECOGNIZED";
const isInsurance = (o: FileOutcome) => !o.ok && o.reason === "INSURANCE";

export function UploadPanel({ api, onChanged, onGo }: { api: Api; onChanged: () => void; onGo: (tab: "issues" | "documents") => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [hold, setHold] = useState(false);
  const [busy, setBusy] = useState<"upload" | "scan" | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scans, setScans] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // The results card sits below the tall import card, often off-screen: bring it into view.
  useEffect(() => {
    if (result) resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  useEffect(() => {
    api
      .call<{ folder: string }>("/api/statements/scan-folder")
      .then((r) => setFolder(r.folder))
      .catch(() => setFolder(null));
  }, [api]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...[...list].filter((f) => f.name.toLowerCase().endsWith(".pdf"))]);
  };

  const upload = useCallback(async () => {
    setBusy("upload");
    setError(null);
    try {
      const form = new FormData();
      for (const f of files) form.append("file", f);
      if (hold) form.set("review", "true");
      const res = await api.call<UploadResponse>("/api/statements/import", { method: "POST", body: form });
      setResult(res);
      setFiles([]);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }, [api, files, hold, onChanged]);

  const scan = useCallback(async () => {
    setBusy("scan");
    setError(null);
    try {
      const res = await api.call<UploadResponse>("/api/statements/scan-folder", { method: "POST", json: { review: hold } });
      setResult(res);
      setScans((n) => n + 1);
      if (res.outcomes.some((o) => o.ok)) onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(null);
    }
  }, [api, hold, onChanged]);

  // Re-downloads, files no parser reads yet and insurance documents (read on the
  // Insurance page) are folded away, so a folder scan's results show what actually changed.
  const shown = result?.outcomes.filter((o) => !isDuplicate(o) && !isUnrecognized(o) && !isInsurance(o)) ?? [];
  const duplicates = result?.outcomes.filter(isDuplicate) ?? [];
  const unrecognized = result?.outcomes.filter(isUnrecognized) ?? [];
  const insurance = result?.outcomes.filter(isInsurance) ?? [];
  const imported = shown.filter((o) => o.ok).length;
  const failed = shown.length - imported;
  const summary = !result
    ? null
    : imported > 0
      ? [
          `Imported ${imported} new document${imported === 1 ? "" : "s"}`,
          failed > 0 && `${failed} couldn't be imported`,
          duplicates.length > 0 && `${duplicates.length} already on file`,
          unrecognized.length > 0 && `${unrecognized.length} not recognized`,
          insurance.length > 0 && `${insurance.length} insurance document${insurance.length === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join(" · ")
      : failed > 0
        ? `Nothing imported — ${failed} file${failed === 1 ? "" : "s"} couldn't be imported (see below).`
        : result.scanned !== undefined
          ? `No new statements — all ${result.scanned} PDFs in the folder are already on file${unrecognized.length > 0 ? ` or not recognized (${unrecognized.length})` : ""}.`
          : "Nothing new — these files are already on file.";
  const held = shown.flatMap((o) => (o.ok ? o.result.sections : [])).filter((s) => s.outcome !== "DUPLICATE" && s.status !== "COMMITTED").length;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Import statements"
        subtitle="Bank, card, brokerage, 401(k), HSA, pay stubs, year-end reports. The institution and account are read from the statement itself; new accounts and reissued cards are picked up automatically. Statements that reconcile to the cent are committed; anything that doesn't waits in Documents."
      >
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => input.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-10 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus ${
            dragging ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent hover:bg-surface-2"
          }`}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-accent" aria-hidden>
            <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-sm font-medium text-fg">Drop statement PDFs here, or click to choose</span>
          <span className="text-xs text-muted">Any number of files, any order — duplicates and re-downloads are skipped.</span>
          <input
            ref={input}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {files.length > 0 && (
          <div className="mt-4 rounded-md border border-line bg-surface-2 p-3">
            <ul className="mb-3 flex max-h-40 flex-col gap-0.5 overflow-y-auto text-xs text-fg-2">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2">
                  <span className="text-faint">PDF</span>
                  <span className="truncate">{f.name}</span>
                  <span className="num ml-auto text-faint">{Math.round(f.size / 1024)} KB</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={btn.primary} disabled={busy !== null} onClick={() => void upload()}>
                {busy === "upload" ? "Importing…" : `Import ${files.length} file${files.length === 1 ? "" : "s"}`}
              </button>
              <button type="button" className={`${btn.ghost} ml-auto`} disabled={busy !== null} onClick={() => setFiles([])}>
                Clear
              </button>
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className={btn.secondary} disabled={busy !== null} onClick={() => void scan()}>
            {busy === "scan" ? "Scanning folder…" : "Scan statements folder"}
          </button>
          <span className="min-w-0 flex-1 text-xs text-muted">
            Imports every PDF in{" "}
            {folder ? (
              <code className="break-all text-fg-2" title={folder}>
                {folder}
              </code>
            ) : (
              "your statements folder"
            )}{" "}
            (subfolders included) that isn&apos;t on file yet.
          </span>
        </div>
        {summary && busy === null && (
          <p role="status" className={`mt-2 text-xs font-medium ${imported > 0 ? "text-pos" : failed > 0 ? "text-neg" : "text-fg-2"}`}>
            {summary}
          </p>
        )}
        <label className="mt-3 flex items-center gap-1.5 text-xs text-fg-2">
          <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
          Hold for review even if they reconcile
        </label>
        {error && (
          <div className="mt-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
      </Card>

      <TaxDocsCard api={api} refreshKey={scans} />

      {result && (
        <div ref={resultsRef} className="scroll-mt-4">
        <Card
          title={result.folder ? "Folder scan results" : "Import results"}
          subtitle={
            [
              result.scanned !== undefined &&
                `Checked ${result.scanned} PDF${result.scanned === 1 ? "" : "s"}; ${imported} new document${imported === 1 ? "" : "s"} imported.`,
              result.maintenance &&
                `Ledger refreshed: ${result.maintenance.transfers.matched} transfers paired, ${result.maintenance.transfers.untrackedCardPayments} payments to untracked cards, ${result.maintenance.payStubsLinked} pay stubs linked.`,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          actions={
            <>
              {held > 0 && (
                <button type="button" className={btn.secondary} onClick={() => onGo("documents")}>
                  {held} held — open Documents
                </button>
              )}
              <button type="button" className={btn.secondary} onClick={() => onGo("issues")}>
                See what&apos;s still open
              </button>
              <Link href="/review" className={btn.secondary}>
                Review new rows
              </Link>
            </>
          }
        >
          {failed > 0 && <p className="mb-2 text-xs text-neg">{failed} file{failed === 1 ? "" : "s"} couldn&apos;t be imported.</p>}
          {shown.length === 0 && <p className="text-sm text-muted">Nothing new to import.</p>}
          <ul className="flex flex-col gap-2">
            {shown.map((o, i) => (
              <li key={i} className="rounded-md border border-line px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{o.fileName}</span>
                  {o.ok ? <span className="text-muted">{o.result.title}</span> : <span className="text-neg">{o.message}</span>}
                </div>
                {o.ok && o.result.sections.length > 0 && (
                  <ul className="mt-1.5 flex flex-col gap-1 text-fg-2">
                    {o.result.sections.map((s, j) => (
                      <li key={j} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>{s.accountName}</span>
                        <span className="num text-muted">
                          {s.periodStart} → {s.periodEnd} · {s.transactionCount} rows
                        </span>
                        {s.outcome === "DUPLICATE" ? (
                          <Badge>already on file</Badge>
                        ) : s.status === "DISCREPANT" ? (
                          <Badge tone="neg">off by {formatUsdFromCents(s.deltaCents)} — held</Badge>
                        ) : s.status === "COMMITTED" ? (
                          <Badge tone="pos">reconciled · committed</Badge>
                        ) : (
                          <Badge tone="warn">reconciled · awaiting commit</Badge>
                        )}
                        {s.resolution === "CREATED" && <Badge tone="info">new account</Badge>}
                        {s.resolution === "CONTINUATION" && <Badge tone="info">new card number linked</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
                {o.ok && o.result.payStubs.created + o.result.payStubs.duplicate > 0 && (
                  <p className="mt-1 text-fg-2">
                    {o.result.payStubs.created} pay stub{o.result.payStubs.created === 1 ? "" : "s"} added
                    {o.result.payStubs.duplicate ? `, ${o.result.payStubs.duplicate} already on file` : ""}
                  </p>
                )}
                {o.ok && o.result.kind === "SUPPORTING" && <p className="mt-1 text-muted">Kept for reference — supporting documents never add money to the ledger.</p>}
              </li>
            ))}
          </ul>
          {unrecognized.length > 0 && (
            <SkippedList
              label={`${unrecognized.length} file${unrecognized.length === 1 ? "" : "s"} no parser recognizes yet`}
              note="Ask Claude to add a parser for these, or hand-parse them (scripts/commitParsedStatement.ts)."
              outcomes={unrecognized}
            />
          )}
          {insurance.length > 0 && (
            <SkippedList
              label={`${insurance.length} life insurance document${insurance.length === 1 ? "" : "s"}`}
              note="Policy packets and premium notices are read on the Insurance page, not imported as statements."
              outcomes={insurance}
            />
          )}
          {duplicates.length > 0 && (
            <SkippedList
              label={`${duplicates.length} already on file`}
              note="The same file, or the same statement re-downloaded — skipped."
              outcomes={duplicates}
            />
          )}
        </Card>
        </div>
      )}
    </div>
  );
}

function SkippedList({ label, note, outcomes }: { label: string; note: string; outcomes: FileOutcome[] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-fg-2">{label}</summary>
      <p className="mt-1 text-muted">{note}</p>
      <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto text-fg-2">
        {outcomes.map((o, i) => (
          <li key={i} className="truncate">
            {o.fileName}
          </li>
        ))}
      </ul>
    </details>
  );
}
