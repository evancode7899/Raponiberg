"use client";

import type { Api } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Drawer, inputCls, selectCls, table } from "@/components/ui/kit";
import { formatUsdCents } from "@/lib/formatMoney";
import type { ImportPreview, ImportedExpense } from "@/lib/hsa/importSheet";
import { EXPENSE_KINDS, type ExpenseKind } from "@/lib/hsa/qualify";
import type { HsaReport } from "@/lib/hsa/report";
import { useState } from "react";
import type { Send } from "./HsaClient";

type Row = ImportedExpense & { inLog: boolean; repeatInSheet: boolean };
type Preview = Omit<ImportPreview, "expenses"> & { expenses: Row[] };

/**
 * Brings in a receipts spreadsheet: pick the .xlsx/.csv (or paste the cells), check the
 * preview — patients and kinds are guessed from the notes and can be changed — and import.
 * Rows the log already has (same day, same amount) start unticked.
 */
export function ImportDrawer({
  open,
  api,
  r,
  send,
  onClose,
  onDone,
}: {
  open: boolean;
  api: Api;
  r: HsaReport;
  send: Send;
  onClose: () => void;
  onDone: (n: number, reimbursed: number) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [take, setTake] = useState<Set<number>>(new Set());
  const [paste, setPaste] = useState("");
  const [allReceipts, setAllReceipts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Closing clears the drawer (adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setPreview(null);
      setRows([]);
      setPaste("");
      setErr(null);
    }
  }

  const show = (p: Preview) => {
    setPreview(p);
    setRows(p.expenses);
    setTake(new Set(p.expenses.filter((e) => !e.inLog).map((e) => e.line)));
    setErr(null);
  };
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      show(await api.call<Preview>("/api/hsa/import", { method: "POST", body: form }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fromPaste = async () => {
    setBusy(true);
    try {
      show(await api.call<Preview>("/api/hsa/import", { method: "POST", json: { text: paste } }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (line: number, patch: Partial<Row>) => setRows((rs) => rs.map((x) => (x.line === line ? { ...x, ...patch } : x)));

  const chosen = rows.filter((x) => take.has(x.line));
  const save = async () => {
    if (!chosen.length) return;
    setBusy(true);
    const ok = await send({
      op: "add",
      expenses: chosen.map((x) => ({
        date: x.date,
        amountCents: x.amountCents,
        provider: x.provider,
        patient: x.patient,
        kind: x.kind,
        notes: x.notes,
        receipt: x.receipt || allReceipts,
        receiptRef: "",
        source: "IMPORT",
        reimbursement: x.reimbursed ? { date: x.reimbursedOn, withdrawal: null, note: "Marked reimbursed in the spreadsheet" } : null,
      })),
    });
    setBusy(false);
    if (ok) onDone(chosen.length, chosen.filter((x) => x.reimbursed).length);
  };

  const repeats = rows.filter((x) => x.repeatInSheet);
  return (
    <Drawer open={open} onClose={onClose} title="Import a receipts spreadsheet" subtitle="An .xlsx or .csv with a Date and an Amount column; Reimbursed?, Provider/Notes and Patient columns are used when there." width="60rem">
      {!preview ? (
        <div className="flex flex-col gap-4">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-10 text-center hover:bg-surface-2">
            <span className="text-sm font-semibold text-fg">{busy ? "Reading…" : "Choose a spreadsheet"}</span>
            <span className="text-xs text-muted">.xlsx, .csv — read on this computer, never uploaded anywhere else</span>
            <input
              type="file"
              accept=".xlsx,.csv,.tsv,.txt"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-fg-2">…or paste the cells from Excel (include the header row)</span>
            <textarea className={`${inputCls} num min-h-28 text-xs`} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"Date\tAmount\tReimbursed?\tProvider/Notes\n3/14/2026\t48.10\t0\tPharmacy copay"} />
            <div>
              <button type="button" className={btn.secondary} disabled={busy || !paste.trim()} onClick={fromPaste}>
                Preview pasted cells
              </button>
            </div>
          </div>
          {err && <p className="text-xs text-neg">{err}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted">
            Sheet <span className="text-fg">{preview.sheet}</span> · columns {preview.columns.join(", ")} · {rows.length} expenses found
            {preview.skipped.length > 0 && <span title={preview.skipped.map((s) => `row ${s.line}: ${s.reason}`).join("\n")}> · {preview.skipped.length} rows skipped (hover)</span>}
          </p>
          {repeats.length > 0 && (
            <Callout tone="warn" title="Same day, same amount">
              {repeats.length === 1 ? "A row repeats" : `${repeats.length} rows repeat`} the date and amount of an earlier row ({repeats.map((x) => `row ${x.line}: ${x.date} ${formatUsdCents(x.amountCents)}`).join("; ")}). If it&apos;s a copied row rather than a second bill, untick it.
            </Callout>
          )}
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={`${table.th} w-6`}>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={take.size === rows.length}
                      onChange={() => setTake(take.size === rows.length ? new Set() : new Set(rows.map((x) => x.line)))}
                    />
                  </th>
                  <th className={table.th}>Row</th>
                  <th className={table.th}>Date</th>
                  <th className={table.th}>Provider</th>
                  <th className={table.th}>Patient</th>
                  <th className={table.th}>Kind</th>
                  <th className={table.thR}>Amount</th>
                  <th className={table.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.line} className={`${table.tr} ${take.has(x.line) ? "" : "opacity-55"}`}>
                    <td className={table.td}>
                      <input
                        type="checkbox"
                        aria-label={`Import row ${x.line}`}
                        checked={take.has(x.line)}
                        onChange={() =>
                          setTake((s) => {
                            const n = new Set(s);
                            if (n.has(x.line)) n.delete(x.line);
                            else n.add(x.line);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className={`${table.td} num text-muted`}>{x.line}</td>
                    <td className={`${table.td} num whitespace-nowrap`}>{x.date}</td>
                    <td className={table.td}>
                      <input className={`${inputCls} w-full min-w-[12rem] py-1 text-xs`} value={x.provider} onChange={(e) => edit(x.line, { provider: e.target.value })} />
                    </td>
                    <td className={table.td}>
                      <input className={`${inputCls} w-28 py-1 text-xs`} list="hsa-patients-import" value={x.patient} onChange={(e) => edit(x.line, { patient: e.target.value })} />
                    </td>
                    <td className={table.td}>
                      <select className={selectCls} value={x.kind} onChange={(e) => edit(x.line, { kind: e.target.value as ExpenseKind })}>
                        {EXPENSE_KINDS.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={table.tdR}>{formatUsdCents(x.amountCents)}</td>
                    <td className={`${table.td} whitespace-nowrap`}>
                      <span className="flex gap-1">
                        {x.reimbursed && <Badge tone="pos">reimbursed{x.reimbursedOn ? ` ${x.reimbursedOn}` : ""}</Badge>}
                        {x.inLog && <Badge tone="neutral" title="The log already has an expense on this day for this amount">in log</Badge>}
                        {x.repeatInSheet && <Badge tone="warn">repeat</Badge>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="hsa-patients-import">
              {r.patients.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
          <label className="flex items-center gap-2 text-xs text-fg">
            <input type="checkbox" checked={allReceipts} onChange={(e) => setAllReceipts(e.target.checked)} />I have the receipts for all of these saved
          </label>
          <div className="flex items-center justify-between gap-2">
            <button type="button" className={btn.ghost} onClick={() => setPreview(null)}>
              ← Another file
            </button>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">
                {chosen.length} selected · <span className="num text-fg">{formatUsdCents(chosen.reduce((s, x) => s + x.amountCents, 0))}</span>
              </span>
              <button type="button" className={btn.primary} disabled={busy || !chosen.length} onClick={save}>
                Import {chosen.length}
              </button>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
