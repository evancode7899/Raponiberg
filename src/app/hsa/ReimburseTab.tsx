"use client";

import { Badge, btn, Callout, Card, Drawer, EmptyState, Field, inputCls, MoneyInput, NotFigure, selectCls, table } from "@/components/ui/kit";
import { sortRows, SortTh, useSort, type SortGetters } from "@/components/ui/sort";
import { formatUsdCents, usd0 } from "@/lib/formatMoney";
import type { ExpenseView, HsaReport } from "@/lib/hsa/report";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { useMemo, useState } from "react";
import type { Send } from "./HsaClient";
import { hsaProof } from "./proof";
import { expensesSum, useHsaDerived } from "./derived";
import { waitLabel } from "./ReceiptsTab";

/** The amount you type to take out, and what it leaves over the receipts picked: your input, not a figure. */
const TYPED = "the amount you typed to take out";

/** Unreimbursed, reimbursable expenses, oldest first: the order to pay them back in. */
const reimbursable = (r: HsaReport) => r.expenses.filter((e) => !e.reimbursement && !e.flags.includes("BEFORE_OPEN")).sort((a, b) => a.date.localeCompare(b.date));

/**
 * Oldest-first expenses that fit within `target` without going over: oldest first so the
 * receipts most likely to go missing are cleared first, skipping any that would overshoot.
 */
export function planWithdrawal(list: ExpenseView[], target: number): ExpenseView[] {
  const out: ExpenseView[] = [];
  let left = target;
  for (const e of list) {
    if (e.amountCents <= left) {
      out.push(e);
      left -= e.amountCents;
    }
  }
  return out;
}

export function ReimburseTab({ r, onReimburse, send }: { r: HsaReport; onReimburse: (ids: string[], withdrawal: number | null) => void; send: Send }) {
  const [target, setTarget] = useState<number | null>(null);
  const [receiptsOnly, setReceiptsOnly] = useState(true);
  const pool = useMemo(() => reimbursable(r).filter((e) => !receiptsOnly || e.hasReceipt), [r, receiptsOnly]);
  const plan = target ? planWithdrawal(pool, target) : [];
  const planCents = plan.reduce((s, e) => s + e.amountCents, 0);
  const poolCents = pool.reduce((s, e) => s + e.amountCents, 0);
  const dp = useHsaDerived(r);
  const byId = new Map(r.expenses.map((e) => [e.id, e]));
  const distSort = useSort();
  const directSort = useSort();
  const byWithdrawal: SortGetters<HsaReport["withdrawals"][number]> = { date: (w) => w.date, amount: (w) => w.amountCents, name: (w) => w.payee };
  const distributions = sortRows(
    r.withdrawals.filter((w) => w.kind === "DISTRIBUTION"),
    distSort.sort,
    byWithdrawal,
  );
  const direct = sortRows(
    r.withdrawals.filter((w) => w.kind === "DIRECT"),
    directSort.sort,
    byWithdrawal,
  );
  const { distributionCents: distCents, directCents } = r.withdrawalTotals;

  return (
    <>
      <Card
        title="Plan a withdrawal"
        subtitle="Need cash? Say how much and this picks the oldest receipts that add up to it without going over. Have the HSA send that amount to your bank, then mark them reimbursed (tying them to the distribution once its statement is imported)."
      >
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Amount to take out">
            <MoneyInput cents={target} nullable allowNegative={false} onChange={setTarget} className="w-40" placeholderCents={r.totals.unreimbursedCents} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-xs text-fg">
            <input type="checkbox" checked={receiptsOnly} onChange={(e) => setReceiptsOnly(e.target.checked)} />
            Only expenses with the receipt saved
          </label>
          <span className="mb-0.5 inline-flex items-center gap-1 text-xs text-muted">
            <button type="button" className={btn.ghost} onClick={() => setTarget(poolCents)}>
              Everything
            </button>
            (<ProofValue proof={expensesSum(dp, pool)}>{usd0(poolCents)}</ProofValue>)
          </span>
        </div>
        {target != null && (
          <div className="mt-4">
            {plan.length === 0 ? (
              <p className="text-xs text-muted">
                No {receiptsOnly ? "receipted " : ""}expense fits within <NotFigure why={TYPED}>{formatUsdCents(target)}</NotFigure>.
              </p>
            ) : (
              <>
                <p className="mb-2 text-xs text-muted">
                  {plan.length} expense{plan.length === 1 ? "" : "s"} totalling{" "}
                  <span className="num font-semibold text-fg">
                    <ProofValue proof={expensesSum(dp, plan)}>{formatUsdCents(planCents)}</ProofValue>
                  </span>
                  {planCents < target && (
                    <>
                      {" "}
                      (<NotFigure why={TYPED}>{formatUsdCents(target - planCents)}</NotFigure> under the amount you typed — withdraw exactly{" "}
                      <ProofValue proof={expensesSum(dp, plan)}>{formatUsdCents(planCents)}</ProofValue> so every dollar has a receipt)
                    </>
                  )}
                  .
                </p>
                <ul className="mb-3 flex flex-col divide-y divide-line text-xs">
                  {plan.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span>
                        <span className="num text-muted">{e.date}</span> {e.provider} {e.patient && <span className="text-muted">· {e.patient}</span>}
                      </span>
                      <span className="num text-fg">
                        <ProofValue proof={dp("expense", e.id)}>{formatUsdCents(e.amountCents)}</ProofValue>
                      </span>
                    </li>
                  ))}
                </ul>
                <button type="button" className={btn.primary} onClick={() => onReimburse(plan.map((e) => e.id), null)}>
                  Mark these reimbursed…
                </button>
              </>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Distributions to you"
        subtitle={
          <>
            Money the HSA sent to your bank
            {distributions.length > 0 && (
              <>
                {" "}
                (<ProofValue proof={hsaProof("distributions", distCents, "distribution")}>{usd0(distCents)}</ProofValue> in all)
              </>
            )}
            : these are what reimburse receipts. Tie each one to the receipts it paid back; if the IRS ever asks about a distribution, that&apos;s your answer.
          </>
        }
      >
        {distributions.length === 0 ? (
          <EmptyState title="No distributions in the statements">
            {r.hsa.accounts.length ? "Nothing has been paid back to you yet, which is the point of letting it grow." : "Import your HSA statements to see distributions here."}
          </EmptyState>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <SortTh k="date" label="Date" sort={distSort.sort} toggle={distSort.toggle} />
                  <SortTh k="name" label="Description" sort={distSort.sort} toggle={distSort.toggle} />
                  <SortTh k="amount" label="Amount" sort={distSort.sort} toggle={distSort.toggle} right />
                  <th className={table.th}>Receipts</th>
                </tr>
              </thead>
              <tbody>
                {distributions.map((w) => (
                  <tr key={`${w.rowId}`} className={table.tr}>
                    <td className={`${table.td} num whitespace-nowrap`}>{w.date}</td>
                    <td className={table.td}>
                      {w.payee} <span className="text-xs text-muted">· {w.account}</span>
                    </td>
                    <td className={table.tdR}>{formatUsdCents(w.amountCents)}</td>
                    <td className={`${table.td} text-xs`}>
                      {w.linkedIds.length ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone="pos">tied</Badge> {w.linkedIds.map((id) => byId.get(id)?.provider ?? "?").join(", ")}
                          <button type="button" className={btn.link} onClick={() => send({ op: "unreimburse", ids: w.linkedIds })}>
                            Untie
                          </button>
                        </span>
                      ) : w.exactMatch ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-muted">
                            {w.exactMatch.length} receipt{w.exactMatch.length === 1 ? "" : "s"} add up to it exactly
                          </span>
                          <button type="button" className={btn.secondary} onClick={() => onReimburse(w.exactMatch!, r.withdrawals.indexOf(w))}>
                            Review…
                          </button>
                        </span>
                      ) : (
                        <span className="text-faint">No receipts tied</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {distributions.some((w) => !w.linkedIds.length) && r.totals.unreimbursedCount > 0 && (
          <p className="mt-2 text-[11px] text-muted">
            An exact match only means the amounts add up, so check they&apos;re the receipts you meant. To tie other receipts, select them on Receipts and pick the distribution under Mark
            reimbursed.
          </p>
        )}
      </Card>

      {direct.length > 0 && (
        <Card
          title="Paid straight from the HSA"
          subtitle={
            <>
              The HSA&apos;s card or bill pay paid these providers directly (<ProofValue proof={hsaProof("distributions", directCents, "direct")}>{usd0(directCents)}</ProofValue> in all). The HSA
              already covered them, so nothing comes back to you and they never reimburse a receipt in the log.
            </>
          }
        >
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <SortTh k="date" label="Date" sort={directSort.sort} toggle={directSort.toggle} />
                  <SortTh k="name" label="Paid to" sort={directSort.sort} toggle={directSort.toggle} />
                  <SortTh k="amount" label="Amount" sort={directSort.sort} toggle={directSort.toggle} right />
                  <th className={table.th} />
                </tr>
              </thead>
              <tbody>
                {direct.map((w) => (
                  <tr key={`${w.rowId}`} className={table.tr}>
                    <td className={`${table.td} num whitespace-nowrap`}>{w.date}</td>
                    <td className={table.td}>{w.payee}</td>
                    <td className={table.tdR}>{formatUsdCents(w.amountCents)}</td>
                    <td className={`${table.td} text-xs`}>
                      {w.linkedIds.length > 0 && (
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone="neg" title="Receipts in the log were marked reimbursed by this payment, which isn't a reimbursement.">
                            wrongly tied to {w.linkedIds.length}
                          </Badge>
                          <button type="button" className={btn.secondary} onClick={() => send({ op: "unreimburse", ids: w.linkedIds })}>
                            Untie
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

/** Marks a set of expenses reimbursed: the date, and optionally the HSA withdrawal that paid them. */
export function ReimburseDrawer({
  ids,
  withdrawal,
  r,
  send,
  onClose,
  onDone,
}: {
  ids: string[] | null;
  /** Index in r.withdrawals to start with (a distribution picked on the Reimburse tab). */
  withdrawal: number | null;
  r: HsaReport;
  send: Send;
  onClose: () => void;
  onDone: (n: number, cents: number) => void;
}) {
  const list = (ids ?? []).map((id) => r.expenses.find((e) => e.id === id)).filter((e): e is ExpenseView => !!e);
  const total = list.reduce((s, e) => s + e.amountCents, 0);
  const [date, setDate] = useState(r.today);
  const [w, setW] = useState("");
  const [note, setNote] = useState("");
  // Only distributions reimburse; an HSA card payment to a provider never does.
  const options = r.withdrawals.filter((x) => x.kind === "DISTRIBUTION" && !x.linkedIds.length).sort((a, b) => Number(b.amountCents === total) - Number(a.amountCents === total) || b.date.localeCompare(a.date));
  // Reset when a new set opens (adjusted during render, not in an effect; `undefined` so
  // the first render fills the form too).
  const [seenIds, setSeenIds] = useState<string[] | null | undefined>(undefined);
  if (ids !== seenIds) {
    setSeenIds(ids);
    if (ids) {
      const picked = withdrawal != null ? r.withdrawals[withdrawal] : undefined;
      const exact = picked ?? r.withdrawals.find((x) => x.kind === "DISTRIBUTION" && !x.linkedIds.length && x.amountCents === total);
      setW(exact ? String(r.withdrawals.indexOf(exact)) : "");
      setDate(exact?.date ?? r.today);
      setNote("");
    }
  }
  const chosen = w === "" ? null : r.withdrawals[Number(w)];
  const growth = list.reduce((s, e) => s + e.growthCents, 0);
  const missing = list.filter((e) => !e.hasReceipt).length;

  return (
    <Drawer open={ids != null} onClose={onClose} title={`Mark ${list.length} reimbursed`} subtitle={`${formatUsdCents(total)} paid back from the HSA`} width="34rem">
      <div className="flex flex-col gap-3">
        {missing > 0 && (
          <Callout tone="warn" title={`${missing} without a saved receipt`}>
            Reimbursements are tax-free only for expenses you can document. Find the receipt or EOB before withdrawing.
          </Callout>
        )}
        <ul className="flex max-h-60 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line px-3 text-xs">
          {list.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-1.5">
              <span>
                <span className="num text-muted">{e.date}</span> {e.provider} <span className="text-faint">· waited {waitLabel(e.daysWaiting)}</span>
              </span>
              <span className="num">{formatUsdCents(e.amountCents)}</span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reimbursed on">
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="HSA distribution" hint={options.length ? undefined : "No untied distributions to your bank in the imported HSA statements."}>
            <select
              className={selectCls}
              value={w}
              onChange={(e) => {
                setW(e.target.value);
                const x = e.target.value === "" ? null : r.withdrawals[Number(e.target.value)];
                if (x) setDate(x.date);
              }}
            >
              <option value="">Not tied to one</option>
              {options.map((x) => (
                <option key={r.withdrawals.indexOf(x)} value={String(r.withdrawals.indexOf(x))}>
                  {x.date} · {formatUsdCents(x.amountCents)}
                  {x.amountCents === total ? " · matches" : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {chosen && chosen.amountCents !== total && (
          <p className="text-xs text-warn">
            That withdrawal is {formatUsdCents(chosen.amountCents)}; these expenses add up to {formatUsdCents(total)}.
          </p>
        )}
        <Field label="Note">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Down payment cash" />
        </Field>
        {growth > 0 && <p className="text-xs text-muted">Leaving this money invested earned an estimated {usd0(growth)} tax-free while you waited.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={btn.primary}
            disabled={!list.length}
            onClick={async () => {
              if (await send({ op: "reimburse", ids: list.map((e) => e.id), date: date || null, withdrawal: chosen?.fp ?? null, note })) onDone(list.length, total);
            }}
          >
            Mark reimbursed
          </button>
        </div>
      </div>
    </Drawer>
  );
}
