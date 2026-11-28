"use client";

import { Card, table } from "@/components/ui/kit";

import { NA } from "@/lib/formatMoney";

import type { MedicalPage } from "@/lib/medical/page";

import type { YearView } from "@/lib/medical/report";

import { Fragment } from "react";

import { Fig, Amt } from "./parts";
import { SliceTable } from "./OverviewTab";

// ---------------------------------------------------------------------------- providers & care

export function Providers({ y, fig, accounts }: { y: YearView; fig: Fig; accounts: MedicalPage["accounts"] }) {
  return (
    <>
      <Card title="Providers" subtitle={`Every provider with a ${y.year} claim, by what you owe`}>
        <SliceTable y={y} rows={y.providers} kind="provider" fig={fig} name="Provider" />
      </Card>
      {accounts.length > 0 && (
        <Card
          title="Balances with providers"
          subtitle="Each office over all years: what its EOBs say you owed against what card, bank and HSA rows paid it"
        >
          <AccountTable accounts={accounts} fig={fig} />
        </Card>
      )}
      <Card title="Kinds of care" subtitle="Grouped by each claim's procedure codes (most of its billed amount)">
        <SliceTable y={y} rows={y.kinds} kind="kind" fig={fig} name="Care" />
      </Card>
    </>
  );
}

export function AccountTable({ accounts, fig }: { accounts: MedicalPage["accounts"]; fig: Fig }) {
  const rows = [...accounts].sort((a, b) => Math.abs(b.balanceCents) - Math.abs(a.balanceCents) || b.lastDate.localeCompare(a.lastDate));
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr className={table.head}>
            <th className={table.th}>Office</th>
            <th className={table.thR}>Visits</th>
            <th className={table.thR}>EOBs say you owed</th>
            <th className={table.thR}>Paid</th>
            <th className={table.thR}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const name = a.payees[0] ?? a.providers[0] ?? "Provider";
            return (
              <tr key={a.key} className={table.tr}>
                <td className={`${table.td} max-w-[18rem] truncate`} title={[`Billed as ${a.payees.join(", ") || NA}`, `EOBs name ${a.providers.join(", ") || "no provider"}`, `${a.firstDate} to ${a.lastDate}`].join("\n")}>
                  {name}
                  {a.providers.length > 0 && <span className="text-faint"> · {a.providers.join(", ")}</span>}
                </td>
                <td className={table.tdR}>{a.visits}</td>
                <td className={table.tdR}>
                  <Amt fig={fig} figure="account-owed" k={a.key} cents={a.owedCents} />
                </td>
                <td className={table.tdR}>
                  <Amt fig={fig} figure="account-paid" k={a.key} cents={a.paidCents} />
                </td>
                <td className={`${table.tdR} whitespace-nowrap`}>
                  {a.balanceCents === 0 ? (
                    <span className="text-pos" title="Everything its EOBs say you owed is paid, no more and no less.">
                      <Amt fig={fig} figure="account-balance" k={a.key} cents={0} /> settled
                    </span>
                  ) : a.balanceCents < 0 ? (
                    <span title="Paid it more in all than its EOBs say you owed: a credit it holds, for a later visit or a refund. Until then that much isn't reimbursable from the HSA.">
                      <Amt fig={fig} figure="account-balance" k={a.key} cents={-a.balanceCents} /> credit
                    </span>
                  ) : (
                    <span className="text-muted" title="What its EOBs say you owed beyond what the statements show paid: bills not in yet, paid in cash or from an account not imported, or still due.">
                      <Amt fig={fig} figure="account-balance" k={a.key} cents={a.balanceCents} /> not found paid
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
