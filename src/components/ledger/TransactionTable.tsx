"use client";

import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { Badge, btn, selectCls, table, type Tone } from "@/components/ui/kit";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { noFigure } from "@/lib/book/proof/clearance";
import { sortRows, SortTh, useSort, type Sort, type SortKey } from "@/components/ui/sort";
import { isGenericMerchantKey } from "@/lib/classifier/merchants";
import { CATEGORIES, LANE_LABELS, type Lane } from "@/lib/classifier/taxonomy";
import { formatUsdFromCents } from "@/lib/formatMoney";
import type { ReimbursementsResponse } from "@/app/api/reimbursements/route";
import { useCallback, useEffect, useState } from "react";
import { PaidBackDrawer } from "./PaidBackDrawer";
import type { Api } from "./useApi";

export type TxnRow = {
  id: string;
  date: string;
  amountCents: number;
  payee: string | null;
  detail?: string | null;
  lane: Lane | null;
  merchantKey: string | null;
  needsReview?: boolean;
  classifiedBy?: string | null;
  userLocked?: boolean;
  account: { id?: string; name: string };
  category: { name: string } | null;
};

const GROUPS = [...new Set(CATEGORIES.map((c) => c.group))];

export function CategorySelect({ value, onChange, className = "" }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <select className={`${selectCls} max-w-[12rem] ${className}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Category">
      {GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {CATEGORIES.filter((c) => c.group === g).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function LaneSelect({ value, onChange, placeholder = "Keep how it counts" }: { value: Lane | ""; onChange: (v: Lane | "") => void; placeholder?: string }) {
  return (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value as Lane | "")} aria-label="Counts as">
      <option value="">{placeholder}</option>
      {(Object.keys(LANE_LABELS) as Lane[]).map((l) => (
        <option key={l} value={l}>
          {LANE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}

const LANE_SHORT: Record<Lane, { label: string; tone: Tone }> = {
  INCOME: { label: "Income", tone: "pos" },
  EXPENSE: { label: "Spending", tone: "neutral" },
  TRANSFER: { label: "Transfer", tone: "info" },
  EXTERNAL_TRANSFER: { label: "Untracked", tone: "info" },
  CONTRIBUTION_EMPLOYEE: { label: "401(k)", tone: "accent" },
  CONTRIBUTION_EMPLOYER: { label: "Employer", tone: "accent" },
  CONTRIBUTION_PERSONAL: { label: "Retirement", tone: "accent" },
};

export function LaneBadge({ lane }: { lane: Lane | null }) {
  if (!lane) return <span className="text-faint">—</span>;
  const l = LANE_SHORT[lane];
  return (
    <Badge tone={l.tone} title={LANE_LABELS[lane]}>
      {l.label}
    </Badge>
  );
}

/**
 * Transactions with inline recategorizing: pick a category, then apply it to this row
 * only (locked against the classifier) or teach it for every row from the merchant. A
 * spending row can also be marked as paid back (PaidBackDrawer).
 * Date, description and amount headers sort the table; pass `sort` + `onSort` when the
 * server sorts (the rows are one page of many), otherwise the rows are sorted here.
 */
export function TransactionTable({
  api,
  rows,
  onChanged,
  showAccount = true,
  maxHeight,
  sort: serverSort,
  onSort,
}: {
  api: Api;
  rows: TxnRow[];
  onChanged: () => void;
  showAccount?: boolean;
  maxHeight?: string;
  sort?: Sort;
  onSort?: (k: SortKey) => void;
}) {
  const local = useSort();
  const sort = serverSort ?? local.sort;
  const toggle = onSort ?? local.toggle;
  const shown = serverSort ? rows : sortRows(rows, sort, { date: (r) => r.date, amount: (r) => r.amountCents, name: (r) => r.payee });
  const [paidBack, setPaidBack] = useState<Record<string, number>>({});
  const [paidBackFor, setPaidBackFor] = useState<string | null>(null);
  const [paidBackVersion, setPaidBackVersion] = useState(0);
  useEffect(() => {
    if (!api.ready) return;
    api
      .call<ReimbursementsResponse>("/api/reimbursements")
      .then((r) => setPaidBack(r.byExpense))
      .catch(() => {});
  }, [api, paidBackVersion]);
  const onPaidBackChanged = useCallback(() => {
    setPaidBackVersion((v) => v + 1);
    onChanged();
  }, [onChanged]);
  return (
    <div className={table.wrap} style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
      <table className={table.table}>
        <thead className={`${table.head} sticky top-0 z-10 bg-surface`}>
          <tr>
            <SortTh k="date" label="Date" sort={sort} toggle={toggle} />
            <SortTh k="name" label="Description" sort={sort} toggle={toggle} />
            {showAccount && <th className={table.th}>Account</th>}
            <th className={table.th}>Counts as</th>
            <th className={table.th}>Category</th>
            <SortTh k="amount" label="Amount" sort={sort} toggle={toggle} right />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <Row key={r.id} r={r} api={api} onChanged={onChanged} showAccount={showAccount} paidBackCents={paidBack[r.id] ?? 0} onPaidBack={() => setPaidBackFor(r.id)} />
          ))}
        </tbody>
      </table>
      <PaidBackDrawer api={api} expenseId={paidBackFor} onClose={() => setPaidBackFor(null)} onChanged={onPaidBackChanged} />
    </div>
  );
}

function Row({
  r,
  api,
  onChanged,
  showAccount,
  paidBackCents,
  onPaidBack,
}: {
  r: TxnRow;
  api: Api;
  onChanged: () => void;
  showAccount: boolean;
  paidBackCents: number;
  onPaidBack: () => void;
}) {
  const current = r.category?.name ?? "Other";
  const [pick, setPick] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = pick !== current;

  const save = async (applyToMerchant: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.call(`/api/transactions/${r.id}`, { method: "PATCH", json: { category: pick, applyToMerchant } });
      notifyLedgerChanged();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={`group ${table.trHover}`}>
      <td className={`${table.td} num whitespace-nowrap text-muted`}>{r.date.slice(0, 10)}</td>
      <td className={`${table.td} w-full max-w-0 min-w-[12rem]`}>
        <div className="truncate text-fg" title={r.payee ?? undefined}>
          {r.payee ?? "—"}
        </div>
        {r.detail && (
          <div className="truncate text-[11px] text-muted" title={r.detail}>
            {r.detail}
          </div>
        )}
      </td>
      {showAccount && <td className={`${table.td} whitespace-nowrap text-xs text-muted`}>{r.account.name}</td>}
      <td className={table.td}>
        <LaneBadge lane={r.lane} />
        {r.needsReview && (
          <span className="ml-1">
            <Badge tone="warn" title="The classifier wasn't sure — confirm it on Review">
              ?
            </Badge>
          </span>
        )}
      </td>
      <td className={table.td}>
        <div className="flex flex-wrap items-center gap-1">
          <CategorySelect value={pick} onChange={setPick} className={r.userLocked ? "border-info/60" : ""} />
          {changed && (
            <>
              <button type="button" className={btn.primary} disabled={busy} onClick={() => void save(false)} title="Change this row only">
                This row
              </button>
              {!isGenericMerchantKey(r.merchantKey) && (
                <button type="button" className={btn.secondary} disabled={busy} onClick={() => void save(true)} title={`Teach a rule: every row from ${r.merchantKey}`}>
                  All {r.merchantKey}
                </button>
              )}
              <button type="button" className={btn.ghost} onClick={() => setPick(current)} aria-label="Cancel">
                ✕
              </button>
            </>
          )}
        </div>
        {error && <div className="mt-1 text-xs text-neg">{error}</div>}
      </td>
      <td className={`${table.tdR} font-medium ${r.amountCents > 0 ? "text-pos" : "text-fg"}`}>
        {/* The row as its statement prints it, how it is filed and where it counts (book/proof/rowProof). */}
        <ProofValue proof={{ descriptor: { report: "row", rowId: r.id }, shownCents: r.amountCents }}>{formatUsdFromCents(r.amountCents)}</ProofValue>
        {r.lane === "EXPENSE" && r.amountCents < 0 && (
          <div className="mt-0.5 text-[11px] font-normal">
            {paidBackCents > 0 ? (
              <button type="button" onClick={onPaidBack} title="Paid back by a reimbursement: see or change the links">
                <Badge tone="pos">{paidBackCents >= -r.amountCents ? "paid back" : `${formatUsdFromCents(paidBackCents)} paid back`}</Badge>
              </button>
            ) : (
              <button type="button" className={`${btn.link} opacity-0 focus:opacity-100 group-hover:opacity-100`} onClick={onPaidBack} title="Link this charge to the reimbursement that paid it back">
                Paid back?
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * Money in, out, or net over the rows a list shows, as a figure: the sum of those rows'
 * own figures (each row as its statement prints it), cleared once every row has. Only for a
 * list that holds every row its filter matches: a list cut short has no total of its own.
 */
export function rowsTotal(rows: readonly TxnRow[], side: "in" | "out" | "net", complete: boolean): { cents: number; proof: ProofRef } {
  const parts = rows.filter((r) => (side === "in" ? r.amountCents > 0 : side === "out" ? r.amountCents < 0 : true));
  const cents = parts.reduce((s, r) => s + r.amountCents, 0);
  if (!complete) return { cents, proof: noFigure("the list isn't all loaded: show more to total every row") };
  if (!parts.length) return { cents, proof: noFigure(`no money ${side === "net" ? "moved" : side}`) };
  const row = (r: TxnRow): ProofRef => ({ descriptor: { report: "row", rowId: r.id }, shownCents: r.amountCents });
  return { cents, proof: parts.length === 1 ? row(parts[0]!) : compositeOf("sum", parts.map(row), { cents }) };
}
