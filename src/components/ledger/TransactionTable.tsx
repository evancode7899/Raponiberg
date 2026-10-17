"use client";

import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { Badge, btn, selectCls, table, type Tone } from "@/components/ui/kit";
import { sortRows, SortTh, useSort, type Sort, type SortKey } from "@/components/ui/sort";
import { isGenericMerchantKey } from "@/lib/classifier/merchants";
import { CATEGORIES, LANE_LABELS, type Lane } from "@/lib/classifier/taxonomy";
import { formatUsdFromCents } from "@/lib/formatMoney";
import { useState } from "react";
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
 * only (locked against the classifier) or teach it for every row from the merchant.
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
            <Row key={r.id} r={r} api={api} onChanged={onChanged} showAccount={showAccount} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ r, api, onChanged, showAccount }: { r: TxnRow; api: Api; onChanged: () => void; showAccount: boolean }) {
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
    <tr className={table.trHover}>
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
      <td className={`${table.tdR} font-medium ${r.amountCents > 0 ? "text-pos" : "text-fg"}`}>{formatUsdFromCents(r.amountCents)}</td>
    </tr>
  );
}
