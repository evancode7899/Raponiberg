"use client";

import { Badge, btn, Card, EmptyState, Field, selectCls, table } from "@/components/ui/kit";
import { formatUsdCents } from "@/lib/formatMoney";
import { EXPENSE_KINDS, type ExpenseKind } from "@/lib/hsa/qualify";
import type { HsaReport, Suggestion } from "@/lib/hsa/report";
import { useState } from "react";
import { PatientInput } from "./ExpenseDrawer";
import type { Send } from "./HsaClient";
import { sortRows, SortTh, useSort } from "./sort";

const key = (s: Suggestion) => s.rowId ?? `${s.date}|${s.amountCents}|${s.payee}`;

/** Readable provider from a card descriptor ("SQ *SMITH DENTAL NEW YORK NY" → "Smith Dental"). */
function providerName(s: Suggestion): string {
  const m = s.merchant && s.merchant !== s.payee ? s.merchant : s.payee;
  return m.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Medical charges found in the imported card and bank statements that aren't in the log:
 * add them (one, several, or every likely one), or say they're not HSA expenses — for one
 * charge, or for every charge from that merchant.
 */
export function FoundTab({ r, send, onDone }: { r: HsaReport; send: Send; onDone: (n: number) => void }) {
  const [take, setTake] = useState<Set<string>>(new Set());
  const [patient, setPatient] = useState("");
  const [kinds, setKinds] = useState<Record<string, ExpenseKind>>({});
  // Drug-store maybes far outnumber the likely ones: start on the likely ones when there are any.
  const [tier, setTier] = useState<"ALL" | "LIKELY" | "CHECK">(() => (r.suggestions.some((s) => s.tier === "LIKELY") ? "LIKELY" : "ALL"));

  const { sort, toggle: toggleSort } = useSort();
  const shown = sortRows(
    r.suggestions.filter((s) => tier === "ALL" || s.tier === tier),
    sort,
  );
  const chosen = r.suggestions.filter((s) => take.has(key(s)));

  const add = async (list: Suggestion[]) => {
    if (!list.length) return;
    const ok = await send({
      op: "add",
      expenses: list.map((s) => ({
        date: s.date,
        amountCents: s.amountCents,
        provider: providerName(s),
        patient,
        kind: kinds[key(s)] ?? s.kind,
        notes: s.tier === "CHECK" ? "From a drug-store charge: check the receipt for the medical items" : "",
        receipt: false,
        receiptRef: "",
        source: "LEDGER",
        paidWith: s.fp,
      })),
    });
    if (ok) {
      setTake(new Set());
      onDone(list.length);
    }
  };

  return (
    <>
      <Card
        title="Medical charges in your statements"
        subtitle="Card and bank charges that look like qualified care and aren't in the log yet. Charges that were refunded, paid from the HSA itself, or dated before the HSA opened are left out. A drug-store charge can mix medicine with other things, so only log what the receipt shows was medical."
        actions={
          <>
            <button type="button" className={btn.secondary} disabled={!r.suggestions.some((s) => s.tier === "LIKELY")} onClick={() => add(r.suggestions.filter((s) => s.tier === "LIKELY"))}>
              Add all likely ({r.suggestions.filter((s) => s.tier === "LIKELY").length})
            </button>
          </>
        }
      >
        {r.suggestions.length === 0 ? (
          <EmptyState title="Nothing new">Every medical-looking charge in your statements is in the log or was set aside. New statements are checked as they&apos;re imported.</EmptyState>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <Field label="Show">
                <select className={selectCls} value={tier} onChange={(e) => setTier(e.target.value as typeof tier)}>
                  <option value="ALL">All ({r.suggestions.length})</option>
                  <option value="LIKELY">Likely qualified ({r.suggestions.filter((s) => s.tier === "LIKELY").length})</option>
                  <option value="CHECK">Check the receipt ({r.suggestions.filter((s) => s.tier === "CHECK").length})</option>
                </select>
              </Field>
              <Field label="Patient for added charges">
                <PatientInput id="hsa-patients-found" value={patient} onChange={setPatient} patients={r.patients} />
              </Field>
              <span className="flex-1" />
              {chosen.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">
                    {chosen.length} selected · <span className="num text-fg">{formatUsdCents(chosen.reduce((s, x) => s + x.amountCents, 0))}</span>
                  </span>
                  <button type="button" className={btn.primary} onClick={() => add(chosen)}>
                    Add selected
                  </button>
                  <button type="button" className={btn.secondary} onClick={() => send({ op: "dismiss", rows: chosen.map((s) => s.fp) }).then(() => setTake(new Set()))}>
                    Not HSA
                  </button>
                </div>
              )}
            </div>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.head}>
                  <tr>
                    <th className={`${table.th} w-6`}>
                      <input
                        type="checkbox"
                        aria-label="Select all shown"
                        checked={shown.length > 0 && shown.every((s) => take.has(key(s)))}
                        onChange={(e) => setTake(e.target.checked ? new Set(shown.map(key)) : new Set())}
                      />
                    </th>
                    <SortTh k="date" label="Date" sort={sort} toggle={toggleSort} />
                    <th className={table.th}>Charge</th>
                    <th className={table.th}>Why</th>
                    <th className={table.th}>Kind</th>
                    <SortTh k="amount" label="Amount" sort={sort} toggle={toggleSort} right />
                    <th className={table.th} />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => (
                    <tr key={key(s)} className={table.trHover}>
                      <td className={table.td}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${s.payee}`}
                          checked={take.has(key(s))}
                          onChange={() =>
                            setTake((t) => {
                              const n = new Set(t);
                              if (n.has(key(s))) n.delete(key(s));
                              else n.add(key(s));
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className={`${table.td} num whitespace-nowrap`}>{s.date}</td>
                      <td className={`${table.td} min-w-[14rem]`}>
                        <div className="text-fg">{s.payee}</div>
                        <div className="text-[11px] text-muted">
                          {s.account} · {s.reason}
                        </div>
                      </td>
                      <td className={table.td}>
                        <Badge tone={s.tier === "LIKELY" ? "pos" : "warn"}>{s.tier === "LIKELY" ? "likely" : "check receipt"}</Badge>
                      </td>
                      <td className={table.td}>
                        <select className={selectCls} aria-label="Kind" value={kinds[key(s)] ?? s.kind} onChange={(e) => setKinds({ ...kinds, [key(s)]: e.target.value as ExpenseKind })}>
                          {EXPENSE_KINDS.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={table.tdR}>{formatUsdCents(s.amountCents)}</td>
                      <td className={`${table.td} whitespace-nowrap`}>
                        <button type="button" className={btn.ghost} onClick={() => add([s])}>
                          Add
                        </button>
                        <button type="button" className={btn.ghost} title="Not an HSA expense: don't suggest this charge again" onClick={() => send({ op: "dismiss", rows: [s.fp] })}>
                          Not HSA
                        </button>
                        <button type="button" className={btn.ghost} title={`Never suggest charges from ${s.merchant}`} onClick={() => send({ op: "ignoreMerchant", merchant: s.merchant })}>
                          Never
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {(r.dismissed.length > 0 || r.ignoredMerchants.length > 0) && (
        <Card title="Set aside" subtitle="Charges and merchants you said aren't HSA expenses. Restore one to see it suggested again.">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium text-fg-2">Charges ({r.dismissed.length})</div>
              <ul className="flex flex-col divide-y divide-line text-xs">
                {r.dismissed.map((d) => (
                  <li key={`${d.date}|${d.amountCents}|${d.payee}`} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      <span className="num text-muted">{d.date}</span> {d.payee} <span className="num">{formatUsdCents(d.amountCents)}</span>
                    </span>
                    <button type="button" className={btn.link} onClick={() => send({ op: "undismiss", rows: [d.fp] })}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-fg-2">Merchants never suggested ({r.ignoredMerchants.length})</div>
              <ul className="flex flex-col divide-y divide-line text-xs">
                {r.ignoredMerchants.map((m) => (
                  <li key={m} className="flex items-center justify-between gap-2 py-1.5">
                    <span>{m}</span>
                    <button type="button" className={btn.link} onClick={() => send({ op: "unignoreMerchant", merchant: m })}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
