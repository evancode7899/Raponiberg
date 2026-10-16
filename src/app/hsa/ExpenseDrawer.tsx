"use client";

import { btn, Drawer, Field, inputCls, selectCls } from "@/components/ui/kit";
import { formatUsdCents } from "@/lib/formatMoney";
import { EXPENSE_KINDS, type ExpenseKind } from "@/lib/hsa/qualify";
import type { HsaReport } from "@/lib/hsa/report";
import { useState } from "react";
import type { Send } from "./HsaClient";

/** The expense being edited (id) or added (null). */
export type DraftExpense = { id: string | null };

type Form = {
  date: string;
  amount: string;
  provider: string;
  patient: string;
  kind: ExpenseKind;
  notes: string;
  receipt: boolean;
  receiptRef: string;
  reimbursed: boolean;
  reimbursedOn: string;
  reimbursementNote: string;
};

const blank = (today: string): Form => ({
  date: today,
  amount: "",
  provider: "",
  patient: "",
  kind: "MEDICAL",
  notes: "",
  receipt: false,
  receiptRef: "",
  reimbursed: false,
  reimbursedOn: today,
  reimbursementNote: "",
});

export const dollarsToCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export function PatientInput({ value, onChange, patients, id }: { value: string; onChange: (v: string) => void; patients: string[]; id: string }) {
  return (
    <>
      <input className={inputCls} list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Who the care was for" />
      <datalist id={id}>
        {patients.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </>
  );
}

export function ExpenseDrawer({ draft, r, send, onClose }: { draft: DraftExpense | null; r: HsaReport; send: Send; onClose: () => void }) {
  const existing = draft?.id ? r.expenses.find((e) => e.id === draft.id) : null;
  const [f, setF] = useState<Form>(() => blank(r.today));
  const [err, setErr] = useState<string | null>(null);
  // Reset only when a different expense opens (adjusted during render, not in an effect;
  // `undefined` so the first render fills the form too).
  const [seen, setSeen] = useState<DraftExpense | null | undefined>(undefined);
  if (draft !== seen) {
    setSeen(draft);
    setErr(null);
    if (draft) setF(
      existing
        ? {
            date: existing.date,
            amount: (existing.amountCents / 100).toFixed(2),
            provider: existing.provider,
            patient: existing.patient,
            kind: existing.kind,
            notes: existing.notes,
            receipt: existing.receipt,
            receiptRef: existing.receiptRef,
            reimbursed: !!existing.reimbursement,
            reimbursedOn: existing.reimbursement?.date ?? "",
            reimbursementNote: existing.reimbursement?.note ?? "",
          }
        : blank(r.today),
    );
  }
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));

  const save = async () => {
    const amountCents = dollarsToCents(f.amount);
    if (!amountCents) return setErr("Enter the amount you paid.");
    if (!f.provider.trim()) return setErr("Enter the provider or what it was for.");
    const expense = {
      date: f.date,
      amountCents,
      provider: f.provider.trim(),
      patient: f.patient.trim(),
      kind: f.kind,
      notes: f.notes,
      receipt: f.receipt,
      receiptRef: f.receiptRef,
      paidWith: existing?.paidWith ?? null,
      reimbursement: f.reimbursed ? { date: f.reimbursedOn || null, withdrawal: existing?.reimbursement?.withdrawal ?? null, note: f.reimbursementNote } : null,
    };
    const ok = existing ? await send({ op: "update", id: existing.id, expense }) : await send({ op: "add", expenses: [expense] });
    if (ok) onClose();
  };

  // Charges in the statements of this amount, to tie the expense to by hand.
  const linkable = existing?.candidates ?? [];

  return (
    <Drawer open={draft != null} onClose={onClose} title={existing ? "Edit expense" : "Add an expense"} subtitle="A qualified medical expense you paid out of pocket (IRS Publication 502)." width="34rem">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date paid">
            <input type="date" className={inputCls} value={f.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
          <Field label="Amount">
            <input className={`${inputCls} num text-right`} inputMode="decimal" placeholder="0.00" value={f.amount} onChange={(e) => set({ amount: e.target.value })} />
          </Field>
        </div>
        <Field label="Provider / what for">
          <input className={inputCls} value={f.provider} onChange={(e) => set({ provider: e.target.value })} placeholder="e.g. Dr. Lee — annual physical" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Patient">
            <PatientInput id="hsa-patients-edit" value={f.patient} onChange={(v) => set({ patient: v })} patients={r.patients} />
          </Field>
          <Field label="Kind">
            <select className={selectCls} value={f.kind} onChange={(e) => set({ kind: e.target.value as ExpenseKind })}>
              {EXPENSE_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={`${inputCls} min-h-16`} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <fieldset className="rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium text-fg-2">Receipt</legend>
          <label className="flex items-center gap-2 text-xs text-fg">
            <input type="checkbox" checked={f.receipt} onChange={(e) => set({ receipt: e.target.checked })} />
            I have the receipt or EOB saved
          </label>
          <Field label="Where it is" hint="A file path, folder or email subject: the IRS can ask for it whenever you reimburse, even decades later." className="mt-2">
            <input className={inputCls} value={f.receiptRef} onChange={(e) => set({ receiptRef: e.target.value })} placeholder="e.g. Receipts/2026/pharmacy.pdf" />
          </Field>
        </fieldset>
        <fieldset className="rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium text-fg-2">Reimbursement</legend>
          <label className="flex items-center gap-2 text-xs text-fg">
            <input type="checkbox" checked={f.reimbursed} onChange={(e) => set({ reimbursed: e.target.checked })} />
            The HSA has paid this back
          </label>
          {f.reimbursed && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Field label="Reimbursed on" hint="Blank if you don't know.">
                <input type="date" className={inputCls} value={f.reimbursedOn} onChange={(e) => set({ reimbursedOn: e.target.value })} />
              </Field>
              <Field label="Note">
                <input className={inputCls} value={f.reimbursementNote} onChange={(e) => set({ reimbursementNote: e.target.value })} />
              </Field>
            </div>
          )}
        </fieldset>
        {existing && (
          <div className="rounded-md border border-line p-3 text-xs">
            <div className="mb-1 font-medium text-fg-2">Paid with</div>
            {existing.paid ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-fg">
                  {existing.paid.payee} · {existing.paid.account} · {existing.paid.date} {existing.paidAuto && <span className="text-muted">(matched automatically)</span>}
                </span>
                {existing.paidWith && (
                  <button type="button" className={btn.link} onClick={() => send({ op: "link", id: existing.id, row: null })}>
                    Unlink
                  </button>
                )}
              </div>
            ) : (
              <p className="text-muted">No card or bank charge tied to it.</p>
            )}
            {linkable.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                <span className="text-muted">Charges of {formatUsdCents(existing.amountCents)} within 45 days in your statements:</span>
                {linkable.map((s) => (
                  <button key={`${s.rowId}`} type="button" className={`${btn.secondary} justify-between`} onClick={() => send({ op: "link", id: existing.id, row: s.fp })}>
                    <span>
                      {s.date} · {s.payee}
                    </span>
                    <span className="text-muted">{s.account}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {err && <p className="text-xs text-neg">{err}</p>}
        <div className="flex justify-between gap-2 pt-1">
          {existing ? (
            <button
              type="button"
              className={btn.danger}
              onClick={() => {
                if (window.confirm("Delete this expense from the log?")) void send({ op: "delete", ids: [existing.id] }).then((ok) => ok && onClose());
              }}
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={btn.ghost} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={btn.primary} onClick={save}>
              {existing ? "Save" : "Add to log"}
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
