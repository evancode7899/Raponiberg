"use client";

import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { Badge, btn, Callout, Drawer, EmptyState, ErrorNote, Field, inputCls, Loading } from "@/components/ui/kit";
import type { ChargeReimbursementsResponse, PaybackCandidate } from "@/app/api/reimbursements/route";
import { formatUsdCents } from "@/lib/formatMoney";
import { useEffect, useState } from "react";
import type { Api } from "./useApi";

/** "744.40" → 74440; anything else → null. */
const toCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return s.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const dollars = (c: number) => (c / 100).toFixed(2);

const candidateLabel = (c: PaybackCandidate) =>
  c.kind === "stub" ? `${c.person ? `${c.person}'s pay stub` : "Pay stub"} · ${c.line}` : `${c.payee} · ${c.account}`;

/**
 * Marks a charge as paid back: pick the pay stub reimbursement line (or incoming row)
 * that paid it and how much of the charge it covered. A payback can cover several charges
 * and a charge can be paid back by several paybacks; each side shows what's still free.
 */
export function PaidBackDrawer({ api, expenseId, onClose, onChanged }: { api: Api; expenseId: string | null; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<ChargeReimbursementsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!expenseId) return;
    let live = true;
    api
      .call<ChargeReimbursementsResponse>(`/api/reimbursements?expense=${encodeURIComponent(expenseId)}`)
      .then((r) => {
        if (!live) return;
        setData(r);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [api, expenseId, version]);

  const close = () => {
    setData(null);
    setPick(null);
    setAmount("");
    setNote("");
    setError(null);
    onClose();
  };
  const changed = () => {
    notifyLedgerChanged();
    onChanged();
    setPick(null);
    setAmount("");
    setNote("");
    setVersion((v) => v + 1);
  };

  const left = data ? data.expense.cents - data.reimbursed : 0;
  const chosen = data?.candidates.find((c) => c.key === pick) ?? null;
  const cents = toCents(amount);
  const tooMuch = cents != null && chosen != null && (cents > left || cents > chosen.remaining);

  const choose = (c: PaybackCandidate) => {
    setPick(c.key);
    setAmount(dollars(Math.min(left, c.remaining)));
  };

  const save = async () => {
    if (!data || !chosen || cents == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.call("/api/reimbursements", {
        method: "POST",
        json: { expenseId: data.expense.id, source: chosen.kind === "stub" ? { kind: "stub", stubId: chosen.stubId, line: chosen.line } : { kind: "row", rowId: chosen.rowId }, cents, note },
      });
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.call(`/api/reimbursements?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={expenseId != null}
      onClose={close}
      title="Paid back"
      subtitle={data ? `${data.expense.date} · ${data.expense.payee} · ${formatUsdCents(data.expense.cents)}` : undefined}
      width="36rem"
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        !error && <Loading />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">
            A linked payback counts as a credit in {data.expense.category} on the day it arrived, and comes off the income it came in with. Living cost totals
            don&apos;t change: a paycheck reimbursement already offsets them. This just puts the money back in the right category.
          </p>

          {data.links.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs font-semibold text-fg-2">
                Paid back so far: {formatUsdCents(data.reimbursed)} of {formatUsdCents(data.expense.cents)}
              </h3>
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line px-3 text-xs">
                {data.links.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="text-fg">{l.source.label}</div>
                      {l.note && <div className="text-muted">“{l.note}”</div>}
                      {l.status === "WAITING" && <div className="text-warn">Not applied: {l.reason}.</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {l.status === "WAITING" ? <Badge tone="warn">waiting</Badge> : null}
                      <span className="num">{formatUsdCents(l.cents)}</span>
                      <button type="button" className={btn.link} disabled={busy} onClick={() => void remove(l.id)}>
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {left <= 0 ? (
            <Callout tone="good" title="Fully paid back">
              Remove a link above to change it.
            </Callout>
          ) : (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-fg-2">What paid it back?</h3>
              {data.candidates.length === 0 ? (
                <EmptyState title="Nothing to link to">
                  No pay stub reimbursement lines or incoming money from a month before this charge to six months after. If the stub line isn&apos;t showing, it
                  may have been read as regular pay.
                </EmptyState>
              ) : (
                <ul className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line text-xs">
                  {data.candidates.map((c) => {
                    const full = c.remaining <= 0;
                    return (
                      <li key={c.key}>
                        <label className={`flex items-center gap-2.5 px-3 py-2 ${full ? "opacity-50" : "cursor-pointer hover:bg-surface-2"}`}>
                          <input type="radio" name="payback" disabled={full} checked={pick === c.key} onChange={() => choose(c)} />
                          <span className="num w-20 shrink-0 text-muted">{c.date}</span>
                          <span className="min-w-0 flex-1 truncate text-fg" title={candidateLabel(c)}>
                            {candidateLabel(c)}
                          </span>
                          <span className="num shrink-0 text-right">
                            {formatUsdCents(c.cents)}
                            {c.remaining !== c.cents && <span className="block text-[11px] text-muted">{full ? "all linked" : `${formatUsdCents(c.remaining)} free`}</span>}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {chosen && (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-[10rem_1fr] gap-3">
                    <Field label="Amount for this charge" hint={chosen.remaining < chosen.cents || chosen.cents > left ? undefined : "Lower it if the payback covered other things too."}>
                      <div className="flex items-center rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
                        <span className="select-none text-faint">$</span>
                        <input inputMode="decimal" aria-label="Amount paid back" className="num w-full bg-transparent px-1 py-1.5 text-right text-sm outline-none" value={amount} onChange={(e) => setAmount(e.target.value)} />
                      </div>
                    </Field>
                    <Field label="Note">
                      <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Q1 expense report" />
                    </Field>
                  </div>
                  {tooMuch && (
                    <p className="text-xs text-warn">
                      At most {formatUsdCents(Math.min(left, chosen.remaining))}: {cents! > left ? `that's what's left of the charge` : `that's what's left of the payback`}.
                    </p>
                  )}
                  {cents != null && !tooMuch && cents < chosen.remaining && (
                    <p className="text-xs text-muted">The other {formatUsdCents(chosen.remaining - cents)} of this payback stays free to link to other charges.</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button type="button" className={btn.ghost} onClick={close}>
                      Cancel
                    </button>
                    <button type="button" className={btn.primary} disabled={busy || cents == null || tooMuch} onClick={() => void save()}>
                      Link {cents != null ? formatUsdCents(cents) : ""}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
