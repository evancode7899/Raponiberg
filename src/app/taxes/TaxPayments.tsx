"use client";

import { Card } from "@/components/ledger/LedgerBits";
import type { PaymentAttribution, TaxProfile } from "@/lib/tax/profile";
import { useState } from "react";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { Callout, formatDate, NumberTable, usd } from "./taxUi";

const AUTH: Record<string, string> = { FEDERAL: "IRS", CT: "Connecticut", OTHER_STATE: "Other state" };

/**
 * Tax payments and refunds found in the bank ledger, with what tax year each one is for.
 * Dates decide the default; any row can be re-attributed (saved as an override).
 */
export function TaxPayments({ r, onSave }: { r: TaxResponse; onSave: (p: TaxProfile) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setAttribution = async (txId: string, value: string) => {
    const profile = structuredClone(r.profile);
    const key = String(r.year);
    const y = profile.years[key] ?? { ...r.inputs, paymentOverrides: {} };
    const [kind, taxYear] = value.split(":");
    y.paymentOverrides = { ...y.paymentOverrides, [txId]: { kind: kind as PaymentAttribution["kind"], taxYear: Number(taxYear) } };
    profile.years[key] = y;
    setBusy(txId);
    setError(null);
    try {
      await onSave(profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const options = (date: string) => {
    const yr = Number(date.slice(0, 4));
    return [
      { v: `ESTIMATE:${yr}`, l: `${yr} estimated payment` },
      { v: `ESTIMATE:${yr - 1}`, l: `${yr - 1} estimated payment (Q4)` },
      { v: `BALANCE_DUE:${yr - 1}`, l: `${yr - 1} balance due / extension` },
      { v: `REFUND:${yr - 1}`, l: `${yr - 1} refund` },
      { v: `IGNORE:${yr}`, l: "Not a tax payment" },
    ];
  };

  const est = (a: string) =>
    r.payments.filter((p) => p.authority === a && p.attribution.kind === "ESTIMATE" && p.attribution.taxYear === r.year).reduce((s, p) => s + p.amount, 0);

  return (
    <div className="flex flex-col gap-4">
      {error && <Callout tone="warn">{error}</Callout>}
      <Card
        title={`Estimated payments for ${r.year}`}
        subtitle="Quarterly due dates: Apr 15, Jun 15, Sep 15, and Jan 15 of the next year (federal and Connecticut)."
      >
        <NumberTable
          columns={["Found in ledger"]}
          rows={[
            { label: "Federal (IRS)", values: [usd(est("FEDERAL"))] },
            { label: "Connecticut (DRS)", values: [usd(est("CT"))] },
          ]}
        />
      </Card>
      <Card
        title="Tax payments and refunds in the bank ledger"
        subtitle="Matched by payee (IRS Direct Pay/EFTPS, CT DRS, state refunds). Change what a row is for if the date-based guess is wrong."
      >
        {r.payments.length === 0 ? (
          <p className="text-sm text-muted">None found for {r.year}–{r.year + 1}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3 font-medium">Date</th>
                  <th className="py-1.5 pr-3 font-medium">To / from</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
                  <th className="py-1.5 pr-3 font-medium">Counts as</th>
                </tr>
              </thead>
              <tbody>
                {r.payments.map((p) => (
                  <tr key={p.transactionId} className="border-t border-line">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(p.date)}</td>
                    <td className="py-1.5 pr-3">
                      <div className="text-fg">{AUTH[p.authority]}</div>
                      <div className="max-w-[22rem] truncate text-xs text-muted" title={p.payee}>
                        {p.payee}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{p.amount < 0 ? `+${usd(-p.amount)} refund` : usd(p.amount)}</td>
                    <td className="py-1.5 pr-3">
                      <select
                        className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs"
                        value={`${p.attribution.kind}:${p.attribution.taxYear}`}
                        disabled={busy === p.transactionId}
                        onChange={(e) => void setAttribution(p.transactionId, e.target.value)}
                      >
                        {[...options(p.date), ...(options(p.date).some((o) => o.v === `${p.attribution.kind}:${p.attribution.taxYear}`) ? [] : [{ v: `${p.attribution.kind}:${p.attribution.taxYear}`, l: `${p.attribution.taxYear} ${p.attribution.kind.toLowerCase()}` }])].map((o) => (
                          <option key={o.v} value={o.v}>
                            {o.l}
                          </option>
                        ))}
                      </select>
                      {p.overridden && <span className="ml-1 text-[10px] uppercase text-muted">set by you</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
