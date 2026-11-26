"use client";

import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { Badge, btn, selectCls, table, type Tone } from "@/components/ui/kit";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { noFigure } from "@/lib/book/proof/clearance";
import type { Sort, SortKey } from "@/components/ui/sort";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { notify } from "@/components/ui/Feedback";
import { isGenericMerchantKey } from "@/lib/classifier/merchants";
import { CATEGORIES, LANE_LABELS, type Lane } from "@/lib/classifier/taxonomy";
import { formatUsdFromCents, NA } from "@/lib/formatMoney";
import type { ReimbursementsResponse } from "@/app/api/reimbursements/route";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  if (!lane) return <span className="text-faint">{NA}</span>;
  const l = LANE_SHORT[lane];
  return (
    <Badge tone={l.tone} title={LANE_LABELS[lane]}>
      {l.label}
    </Badge>
  );
}

/**
 * Transactions on the shared table (DataTable: sort, filter, columns, copy, J/K), with inline
 * recategorizing: pick a category, then apply it to this row only (locked against the
 * classifier) or teach it for every row from the merchant. Pick several rows to file them
 * together, or mark them reviewed. Every change says what it did, with Undo (the batch-answers
 * endpoint keeps what each answer replaced). A spending row can also be marked as paid back
 * (PaidBackDrawer). Pass `sort` + `onSort` when the server sorts (the rows are one page of
 * many), otherwise the rows are sorted here. Long lists draw only the rows in view.
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
  const answer = useAnswer(api, onChanged);

  const columns = useMemo<Column<TxnRow>[]>(
    () => [
      { id: "date", label: "Date", date: (r) => r.date.slice(0, 10), className: `${table.td} num whitespace-nowrap text-muted` },
      {
        id: "name",
        label: "Description",
        text: (r) => [r.payee ?? NA, r.detail].filter(Boolean).join(" · "),
        sort: (r) => r.payee ?? "",
        className: `${table.td} w-full max-w-0 min-w-[12rem]`,
        cell: (r) => (
          <>
            <div className="truncate text-fg" title={r.payee ?? undefined}>
              {r.payee ?? NA}
            </div>
            {r.detail && (
              <div className="truncate text-2xs text-muted" title={r.detail}>
                {r.detail}
              </div>
            )}
          </>
        ),
      },
      ...(showAccount ? [{ id: "account", label: "Account", text: (r: TxnRow) => r.account.name, sort: (r: TxnRow) => r.account.name, className: `${table.td} whitespace-nowrap text-xs text-muted` }] : []),
      { id: "merchant", label: "Merchant", optional: true, text: (r) => r.merchantKey ?? "", sort: (r) => r.merchantKey ?? "", className: `${table.td} whitespace-nowrap font-mono text-2xs text-muted` },
      {
        id: "lane",
        label: "Counts as",
        text: (r) => (r.lane ? LANE_SHORT[r.lane].label : NA),
        sort: (r) => (r.lane ? LANE_SHORT[r.lane].label : ""),
        cell: (r) => (
          <>
            <LaneBadge lane={r.lane} />
            {r.needsReview && (
              <span className="ml-1">
                <Badge tone="warn" title="The classifier wasn't sure — confirm it on Statements › Categorize">
                  ?
                </Badge>
              </span>
            )}
          </>
        ),
      },
      { id: "category", label: "Category", text: (r) => r.category?.name ?? "Other", sort: (r) => r.category?.name ?? "Other", cell: (r) => <CategoryCell r={r} answer={answer} /> },
      { id: "filedBy", label: "Filed by", optional: true, text: (r) => (r.userLocked ? "you" : (r.classifiedBy ?? "")), sort: (r) => (r.userLocked ? "you" : (r.classifiedBy ?? "")), className: `${table.td} whitespace-nowrap text-xs text-muted` },
      {
        id: "amount",
        label: "Amount",
        align: "right",
        sort: (r) => Math.abs(r.amountCents),
        // The row as its statement prints it, how it is filed and where it counts (book/proof/rowProof).
        figure: (r) => ({ text: formatUsdFromCents(r.amountCents), proof: { descriptor: { report: "row", rowId: r.id }, shownCents: r.amountCents } }),
        className: `${table.tdR} font-medium`,
        cell: (r) => <AmountCell r={r} paidBackCents={paidBack[r.id] ?? 0} onPaidBack={() => setPaidBackFor(r.id)} />,
      },
    ],
    [showAccount, answer, paidBack],
  );

  return (
    <>
      <DataTable
        id="transactions"
        label="Transactions"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        maxHeight={maxHeight}
        rowHeight={42}
        {...(serverSort ? { sort: serverSort, onSort: (k: string) => onSort?.(k as SortKey) } : { defaultSort: { key: "date", desc: true } })}
        filterPlaceholder="Filter the rows listed…"
        select={{ actions: (picked, clear) => <BulkEdit picked={picked} answer={answer} onDone={clear} /> }}
      />
      <PaidBackDrawer api={api} expenseId={paidBackFor} onClose={() => setPaidBackFor(null)} onChanged={onPaidBackChanged} />
    </>
  );
}

type Answer = (ids: string[], change: { category?: string; lane?: Lane; applyToMerchant?: boolean; reviewed?: boolean }, said: string) => Promise<boolean>;

/**
 * Files rows (one or many) through the batch-answers endpoint, and says what changed with an
 * Undo that puts back exactly what the answer replaced (the server keeps it: lib/review/answerRows).
 */
function useAnswer(api: Api, onChanged: () => void): Answer {
  return useCallback<Answer>(
    async (ids, change, said) => {
      try {
        const r = await api.call<{ undoId?: string; affected?: number }>("/api/transactions/answers", { method: "POST", json: { ids, ...change } });
        notifyLedgerChanged();
        onChanged();
        const n = r.affected ?? ids.length;
        notify(`${said}${n > ids.length ? ` (${n.toLocaleString()} rows with the merchant)` : ""}.`, {
          undo: r.undoId
            ? async () => {
                await api.call(`/api/transactions/answers?undo=${encodeURIComponent(r.undoId!)}`, { method: "DELETE" });
                notifyLedgerChanged();
                onChanged();
                notify("Put back as it was.", { tone: "info" });
              }
            : undefined,
        });
        return true;
      } catch (e) {
        notify(e instanceof Error ? e.message : "Couldn't save that.", { tone: "bad" });
        return false;
      }
    },
    [api, onChanged],
  );
}

function BulkEdit({ picked, answer, onDone }: { picked: TxnRow[]; answer: Answer; onDone: () => void }) {
  const [category, setCategory] = useState(picked[0]?.category?.name ?? "Other");
  const [lane, setLane] = useState<Lane | "">("");
  const [busy, setBusy] = useState(false);
  const ids = picked.map((r) => r.id);
  const n = `${ids.length.toLocaleString()} row${ids.length === 1 ? "" : "s"}`;
  const run = async (change: Parameters<Answer>[1], said: string) => {
    setBusy(true);
    if (await answer(ids, change, said)) onDone();
    setBusy(false);
  };
  return (
    <>
      <CategorySelect value={category} onChange={setCategory} />
      <LaneSelect value={lane} onChange={setLane} />
      <button type="button" className={btn.primary} disabled={busy} onClick={() => void run({ category, ...(lane ? { lane } : {}) }, `Filed ${n} as ${category}`)}>
        File {n}
      </button>
      {picked.some((r) => r.needsReview) && (
        <button type="button" className={btn.secondary} disabled={busy} onClick={() => void run({ reviewed: true }, `Marked ${n} reviewed`)}>
          Mark reviewed
        </button>
      )}
    </>
  );
}

function CategoryCell({ r, answer }: { r: TxnRow; answer: Answer }) {
  const current = r.category?.name ?? "Other";
  const [pick, setPick] = useState(current);
  const [busy, setBusy] = useState(false);
  // A new answer from the server is the row's category now (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setPick(current);
  }
  const changed = pick !== current;
  const save = async (applyToMerchant: boolean) => {
    setBusy(true);
    const ok = await answer([r.id], { category: pick, applyToMerchant }, applyToMerchant ? `Every ${r.merchantKey} row is now ${pick}` : `${r.payee ?? "The row"} is now ${pick}`);
    if (!ok) setPick(current);
    setBusy(false);
  };
  return (
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
  );
}

function AmountCell({ r, paidBackCents, onPaidBack }: { r: TxnRow; paidBackCents: number; onPaidBack: () => void }) {
  return (
    <span className={r.amountCents > 0 ? "text-pos" : "text-fg"}>
      <ProofValue proof={{ descriptor: { report: "row", rowId: r.id }, shownCents: r.amountCents }}>{formatUsdFromCents(r.amountCents)}</ProofValue>
      {r.lane === "EXPENSE" && r.amountCents < 0 && (
        <div className="mt-0.5 text-2xs font-normal">
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
    </span>
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
  if (!parts.length) return { cents, proof: noFigure(`no money ${side === "net" ? "moved" : side}`, true) };
  const row = (r: TxnRow): ProofRef => ({ descriptor: { report: "row", rowId: r.id }, shownCents: r.amountCents });
  return { cents, proof: parts.length === 1 ? row(parts[0]!) : compositeOf("sum", parts.map(row), { cents }) };
}
