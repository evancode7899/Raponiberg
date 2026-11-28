"use client";

import { Badge, Card, NotFigure, Segmented, table } from "@/components/ui/kit";

import type { MedicalPage } from "@/lib/medical/page";

import type { ClaimView, YearView } from "@/lib/medical/report";

import { Fragment, useState } from "react";

import { money, shortDate, Fig, Amt } from "./parts";

// ---------------------------------------------------------------------------- claims

/** How each row was tied to its claim, in words. */
export const HOW: Record<ClaimView["payments"][number]["how"], string> = {
  NAME: "The bill",
  MEDICAL: "The bill (matched by amount)",
  GROUP: "One bill for several claims",
  NEAR: "The bill (within a cent-rounding)",
  VISIT: "Paid at the desk on the day of care",
  BALANCE: "The balance after the desk payment",
  INSTALLMENT: "One of the payments the bill was paid in",
  PARTIAL: "Part of the bill (the rest isn't in the statements)",
};

/** How a claim's share was paid, in words: the row that paid it, and whether the HSA log has it. */
export function PaidCell({ c, log }: { c: ClaimView; log: MedicalPage["inHsaLog"][string] | undefined }) {
  const p = c.payment;
  const diff = c.paidCents == null ? 0 : c.paidCents - c.yourShareCents;
  const paidTitle = [
    ...c.payments.map((x) => `${HOW[x.how]}: ${money(x.amountCents)} on ${x.date}, ${x.payee} (${x.fromHsa ? "the HSA" : x.account})${x.claimIds.length > 1 ? ` · one payment for ${x.claimIds.length} claims` : ""}`),
    diff > 0 ? `Paid ${money(diff)} more than the EOB says you owe: a credit with the office, netted on a later visit or refunded (Providers › Balances with providers).` : diff < 0 ? `${money(-diff)} of what the EOB says you owe isn't paid yet in the statements.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <td className={`${table.td} whitespace-nowrap text-xs`}>
      <NotFigure why="Where the claim's share was paid from, and the HSA log's entry for it">
        {c.yourShareCents <= 0 ? (
          <span className="text-muted">Nothing owed</span>
        ) : p ? (
          <span title={paidTitle}>
            {p.fromHsa ? "HSA" : p.account} · {shortDate(p.date)}
            {c.payments.length > 1 && ` + ${c.payments.length - 1} more`}
          </span>
        ) : c.awaiting ? (
          <span className="text-muted" title="No payment found yet, and the statements in end too soon after this EOB to show the bill being paid. It is looked for again as statements come in.">
            Statements not in yet
          </span>
        ) : (
          <span className="text-warn" title="No card, bank or HSA payment for this claim was found: not of its amount (alone or with the provider's other claims), and nothing paid at the desk that day. Paid in cash, from an account not imported, or still due.">
            Not found
          </span>
        )}
        {log && (
          <>
            {" "}
            <Badge tone={log.over ? "warn" : "info"} title={log.over ? "The HSA log has this visit for more than the EOB says you owed." : log.reimbursed ? "In the HSA receipts log, reimbursed." : "In the HSA receipts log, not reimbursed yet."}>
              {log.over ? "HSA log: over" : log.reimbursed ? "HSA: reimbursed" : "HSA log"}
            </Badge>
          </>
        )}
      </NotFigure>
    </td>
  );
}

export function Claims({ y, claims, fig, inHsaLog }: { y: YearView; claims: ClaimView[]; fig: Fig; inHsaLog: MedicalPage["inHsaLog"] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [who, setWho] = useState<string>("all");
  const shown = who === "all" ? claims : claims.filter((c) => c.patient === who);
  return (
    <Card title={`${y.year} claims`} subtitle="Every claim on the explanations of benefits, newest first. An adjusted claim replaces the version before it. Click an amount for the service lines behind it; click a row for the services and the insurer's remarks.">
      {y.people.length > 1 && (
        <div className="mb-3">
          <Segmented options={[{ value: "all", label: "Everyone" }, ...y.people.map((p) => ({ value: p.key, label: p.key }))]} value={who} onChange={setWho} />
        </div>
      )}
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr className={table.head}>
              <th className={table.th}>Date</th>
              <th className={table.th}>Patient</th>
              <th className={table.th}>Provider</th>
              <th className={table.th}>Care</th>
              <th className={table.thR}>Billed</th>
              <th className={table.thR}>Plan paid</th>
              <th className={table.thR}>You owe</th>
              <th className={table.th}>Paid</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <Fragment key={c.id}>
                <tr className={`${table.trHover} cursor-pointer`} onClick={() => setOpen(open === c.id ? null : c.id)}>
                  <td className={`${table.td} whitespace-nowrap`}>{c.firstDate === c.lastDate ? shortDate(c.firstDate) : `${shortDate(c.firstDate)} – ${shortDate(c.lastDate)}`}</td>
                  <td className={table.td}>{c.patient}</td>
                  <td className={`${table.td} max-w-[16rem] truncate`} title={c.provider}>
                    {c.provider || <span className="text-muted">Not printed</span>}
                    {c.inNetwork === false && (
                      <>
                        {" "}
                        <Badge tone="warn">Out of network</Badge>
                      </>
                    )}
                  </td>
                  <td className={`${table.td} whitespace-nowrap text-fg-2`}>
                    {c.kind}
                    {c.earlier.length > 0 && (
                      <>
                        {" "}
                        <Badge tone="info" title="The insurer reprocessed this claim: this version replaces the earlier one.">Adjusted</Badge>
                      </>
                    )}
                    {c.cob && (
                      <>
                        {" "}
                        <Badge tone="info" title="Another plan paid first (coordination of benefits).">COB</Badge>
                      </>
                    )}
                  </td>
                  <td className={table.tdR} onClick={(e) => e.stopPropagation()}>
                    <Amt fig={fig} figure="claim-billed" k={c.id} cents={c.billedCents} />
                  </td>
                  <td className={table.tdR} onClick={(e) => e.stopPropagation()}>
                    <Amt fig={fig} figure="claim-plan" k={c.id} cents={c.planCents} />
                  </td>
                  <td className={`${table.tdR} font-medium`} onClick={(e) => e.stopPropagation()}>
                    <Amt fig={fig} figure="claim-you" k={c.id} cents={c.yourShareCents} />
                  </td>
                  <PaidCell c={c} log={inHsaLog[c.id]} />
                </tr>
                {open === c.id && (
                  <tr className="bg-surface-2">
                    <td colSpan={8} className="px-3 py-2 text-xs text-fg-2">
                      <ClaimDetail c={c} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ClaimDetail({ c }: { c: ClaimView }) {
  const remarks = Object.entries(c.remarks);
  return (
    <div className="space-y-2">
      <div>
        Claim <code>{c.id}</code>
        {c.received && ` · received ${shortDate(c.received)}`} · on the EOB of {shortDate(c.statementDate)}
        {c.relationship && ` · ${c.patient} (${c.relationship})`}
      </div>
      <ul className="list-disc space-y-0.5 pl-4">
        {c.lines.map((l, i) => (
          <li key={i}>
            {shortDate(l.date)}
            {l.dateTo && ` – ${shortDate(l.dateTo)}`}: {l.service}
            {l.code && <span className="text-muted"> ({l.code})</span>}
            {l.remarks.length > 0 && <span className="text-muted"> · remark {l.remarks.join(", ")}</span>}
          </li>
        ))}
      </ul>
      {c.earlier.length > 0 && <div>Replaces {c.earlier.map((e) => `claim ${e.id} on the EOB of ${shortDate(e.statementDate)}`).join(" and ")}: the amounts shown are this version&apos;s. Click an amount for what the earlier version said.</div>}
      {c.cob && <div>Another plan paid first: what you owe and what this plan paid are the EOB&apos;s figures after coordination of benefits.</div>}
      {remarks.length > 0 && (
        <div className="space-y-0.5">
          {remarks.map(([n, text]) => (
            <div key={n}>
              <NotFigure why="The insurer's remark, as the EOB prints it">
                ({n}) {text}
              </NotFigure>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
