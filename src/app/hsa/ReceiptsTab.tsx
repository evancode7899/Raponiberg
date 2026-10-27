"use client";

import { Badge, btn, Callout, Card, downloadResponse, EmptyState, inputCls, Segmented, selectCls, table } from "@/components/ui/kit";
import { apiSecretHeaders } from "@/components/ledger/useApi";
import { formatUsdCents, usd0 } from "@/lib/formatMoney";
import { KIND_LABEL } from "@/lib/hsa/qualify";
import type { ExpenseView, HsaReport } from "@/lib/hsa/report";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { Send } from "./HsaClient";
import { sortRows, SortTh, useSort } from "@/components/ui/sort";

type Status = "open" | "done" | "review" | "all";

const needsReview = (e: ExpenseView) => e.flags.includes("NOT_MEDICAL") || e.flags.includes("BAD_TIE");

const FLAG_BADGE: Record<string, { tone: "warn" | "neg" | "neutral"; label: string; title: string }> = {
  DUPLICATE: { tone: "warn", label: "duplicate?", title: "Another expense has the same date and amount. If it's the same bill logged twice, delete one." },
  BEFORE_OPEN: { tone: "neg", label: "before HSA", title: "Paid before the HSA was opened (Settings): the IRS doesn't allow reimbursing it." },
  PAID_ROW_MISSING: { tone: "neutral", label: "row gone", title: "The statement row this was tied to is no longer in the ledger (re-imported or deleted)." },
  NOT_MEDICAL: { tone: "neg", label: "not medical?", title: "Added from a statement charge that doesn't look like medical care. Left out of the totals until you keep or remove it." },
  BAD_TIE: { tone: "neg", label: "wrong tie", title: "Marked reimbursed by an HSA card payment to a provider, which isn't a reimbursement." },
};

export function waitLabel(days: number): string {
  if (days < 45) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 365 * 2) return `${Math.round(days / 30.4)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

export function ReceiptsTab({
  r,
  send,
  selected,
  setSelected,
  onAdd,
  onEdit,
  onExport,
  onReimburse,
  goFound,
}: {
  r: HsaReport;
  send: Send;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onExport: (openOnly: boolean) => void;
  onReimburse: (ids: string[]) => void;
  goFound: () => void;
}) {
  const [status, setStatus] = useState<Status>("open");
  const [year, setYear] = useState("");
  const [patient, setPatient] = useState("");
  const [q, setQ] = useState("");
  const { sort, toggle: toggleSort } = useSort();

  const years = useMemo(() => [...new Set(r.expenses.map((e) => e.date.slice(0, 4)))].sort().reverse(), [r.expenses]);
  const shown = sortRows(
    r.expenses.filter(
    (e) =>
      (status === "all" || (status === "review" ? needsReview(e) : (status === "open") === !e.reimbursement)) &&
      (!year || e.date.startsWith(year)) &&
      (!patient || (e.patient || "Unassigned") === patient) &&
      (!q || `${e.provider} ${e.notes} ${e.patient} ${KIND_LABEL[e.kind]}`.toLowerCase().includes(q.toLowerCase())),
    ),
    sort,
    { date: (e) => e.date, amount: (e) => e.amountCents, name: (e) => e.provider },
  );
  const picked = r.expenses.filter((e) => selected.has(e.id));
  const pickedCents = picked.reduce((s, e) => s + e.amountCents, 0);
  const shownCents = shown.reduce((s, e) => s + e.amountCents, 0);
  const allShownPicked = shown.length > 0 && shown.every((e) => selected.has(e.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const dups = r.expenses.filter((e) => e.flags.includes("DUPLICATE"));
  const early = r.expenses.filter((e) => e.flags.includes("BEFORE_OPEN"));
  const likely = r.suggestions.filter((s) => s.tier === "LIKELY");
  const notMedical = r.expenses.filter((e) => e.flags.includes("NOT_MEDICAL"));
  const badTies = r.expenses.filter((e) => e.flags.includes("BAD_TIE"));
  const review = r.expenses.filter(needsReview);

  return (
    <>
      {badTies.length > 0 && (
        <Callout
          tone="bad"
          title={`${badTies.length} expense${badTies.length === 1 ? " is" : "s are"} marked reimbursed by an HSA card payment`}
          action={
            <button type="button" className={btn.primary} onClick={() => send({ op: "unreimburse", ids: badTies.map((e) => e.id) })}>
              Mark {badTies.length === 1 ? "it" : `all ${badTies.length}`} not reimbursed
            </button>
          }
        >
          When the HSA&apos;s own card pays a provider, the HSA paid that bill: no money came back to you, so it can&apos;t reimburse a different expense you paid out of pocket. These were
          tied because their amounts added up ({usd0(badTies.reduce((s, e) => s + e.amountCents, 0))} in all). Only a distribution to your bank reimburses a receipt.
        </Callout>
      )}
      {notMedical.length > 0 && (
        <Callout
          tone="warn"
          title={`${notMedical.length} logged expense${notMedical.length === 1 ? " doesn't" : "s don't"} look like medical care`}
          action={
            <span className="flex flex-wrap gap-2">
              <button type="button" className={btn.secondary} onClick={() => setStatus("review")}>
                Show them
              </button>
              <button
                type="button"
                className={btn.danger}
                onClick={() => {
                  if (window.confirm(`Remove ${notMedical.length} expense${notMedical.length === 1 ? "" : "s"} from the log and stop suggesting those charges? (The journal beside the file keeps a copy.)`)) {
                    void send({ op: "delete", ids: notMedical.map((e) => e.id), dismiss: true });
                  }
                }}
              >
                Remove all {notMedical.length}
              </button>
            </span>
          }
        >
          They were added from statement charges filed under groceries, dining, shopping and the like, or whose names only looked medical (a state abbreviation read as &ldquo;MD&rdquo;).
          They&apos;re left out of the totals until you keep one (Keep, on its row) or remove it.
        </Callout>
      )}
      {dups.length > 0 && (
        <Callout tone="warn" title={`${dups.length} expenses share a date and amount with another`}>
          {[...new Set(dups.map((e) => `${e.date} ${formatUsdCents(e.amountCents)}`))].join(" · ")}. If one is the same bill logged twice (a copied row), delete it so it isn&apos;t reimbursed twice.
        </Callout>
      )}
      {early.length > 0 && (
        <Callout tone="bad" title={`${early.length} expense${early.length === 1 ? " was" : "s were"} paid before the HSA was opened`}>
          Only expenses incurred after an HSA is established can be reimbursed from it. They&apos;re kept in the log but left out of the totals.
        </Callout>
      )}
      {r.suggestions.length > 0 && (
        <Callout
          tone="info"
          title={`${r.suggestions.length} medical charge${r.suggestions.length === 1 ? "" : "s"} in your statements ${r.suggestions.length === 1 ? "isn't" : "aren't"} in the log`}
          action={
            <button type="button" className={btn.secondary} onClick={goFound}>
              Review
            </button>
          }
        >
          {[
            likely.length > 0 && `${likely.length} look${likely.length === 1 ? "s" : ""} like qualified care (${usd0(likely.reduce((s, x) => s + x.amountCents, 0))})`,
            r.suggestions.length > likely.length && `${r.suggestions.length - likely.length} ${r.suggestions.length - likely.length === 1 ? "is a" : "are"} drug-store purchase${r.suggestions.length - likely.length === 1 ? "" : "s"} to check against the receipt`,
          ]
            .filter(Boolean)
            .join("; ")}
          .
        </Callout>
      )}

      <Card
        title="Expense log"
        subtitle="Every qualified medical bill you paid out of pocket. There's no deadline to reimburse one — keep the receipt and the HSA can pay you back tax-free years from now."
        actions={
          <>
            <button type="button" className={btn.primary} onClick={onAdd}>
              + Add expense
            </button>
            <button type="button" className={btn.ghost} onClick={() => onExport(status === "open")} title={status === "open" ? "Unreimbursed expenses as CSV" : "Every expense as CSV"}>
              Export CSV
            </button>
          </>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Status"
            size="xs"
            options={[
              { value: "open", label: `Unreimbursed (${r.totals.unreimbursedCount + early.filter((e) => !e.reimbursement).length})` },
              { value: "done", label: `Reimbursed (${r.totals.reimbursedCount})` },
              ...(review.length ? [{ value: "review" as const, label: `Needs review (${review.length})` }] : []),
              { value: "all", label: "All" },
            ]}
            value={status}
            onChange={setStatus}
          />
          <select className={selectCls} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
            <option value="">All years</option>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
          {r.byPatient.length > 1 && (
            <select className={selectCls} value={patient} onChange={(e) => setPatient(e.target.value)} aria-label="Patient">
              <option value="">Everyone</option>
              {r.byPatient.map((p) => (
                <option key={p.key}>{p.key}</option>
              ))}
            </select>
          )}
          <input className={`${inputCls} w-48 py-1 text-xs`} placeholder="Search provider or notes" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="ml-auto text-xs text-muted">
            {shown.length} shown · <span className="num text-fg">{formatUsdCents(shownCents)}</span>
          </span>
        </div>

        {picked.length > 0 && (
          <div className="sticky top-12 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-xs">
            <span className="font-medium text-fg">
              {picked.length} selected · <span className="num">{formatUsdCents(pickedCents)}</span>
            </span>
            <span className="flex-1" />
            {picked.some((e) => !e.reimbursement) && (
              <button type="button" className={btn.primary} onClick={() => onReimburse(picked.filter((e) => !e.reimbursement).map((e) => e.id))}>
                Mark reimbursed…
              </button>
            )}
            {picked.some((e) => e.reimbursement) && (
              <button type="button" className={btn.secondary} onClick={() => send({ op: "unreimburse", ids: picked.map((e) => e.id) })}>
                Mark not reimbursed
              </button>
            )}
            <button type="button" className={btn.secondary} onClick={() => send({ op: "receipt", ids: picked.map((e) => e.id), receipt: true })}>
              Receipt saved
            </button>
            <button
              type="button"
              className={btn.danger}
              onClick={() => {
                if (window.confirm(`Delete ${picked.length} expense${picked.length === 1 ? "" : "s"} from the log? (The journal beside the file keeps a copy.)`)) {
                  void send({ op: "delete", ids: picked.map((e) => e.id) }).then(() => setSelected(new Set()));
                }
              }}
            >
              Delete
            </button>
            <button type="button" className={btn.ghost} onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}

        {r.expenses.length === 0 ? (
          <EmptyState
            title="No expenses logged yet"
            action={
              <div className="flex gap-2">
                <button type="button" className={btn.primary} onClick={onAdd}>
                  + Add expense
                </button>
                {r.suggestions.length > 0 && (
                  <button type="button" className={btn.secondary} onClick={goFound}>
                    Pull from statements ({r.suggestions.length})
                  </button>
                )}
              </div>
            }
          >
            Add expenses by hand, or pull medical charges straight from your imported card and bank statements.
          </EmptyState>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">Nothing matches these filters.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={`${table.th} w-6`}>
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={allShownPicked}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          for (const e of shown) {
                            if (allShownPicked) n.delete(e.id);
                            else n.add(e.id);
                          }
                          return n;
                        })
                      }
                    />
                  </th>
                  <SortTh k="date" label="Date" sort={sort} toggle={toggleSort} />
                  <SortTh k="name" label="Provider" sort={sort} toggle={toggleSort} />
                  <th className={table.th}>Patient</th>
                  <th className={table.th}>Paid with</th>
                  <th className={table.th} title="Receipt or EOB saved">
                    Receipt
                  </th>
                  <SortTh k="amount" label="Amount" sort={sort} toggle={toggleSort} right />
                  <th className={table.th}>Status</th>
                  <th className={table.th} />
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <Row key={e.id} e={e} picked={selected.has(e.id)} toggle={() => toggle(e.id)} send={send} onEdit={() => onEdit(e.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {r.receiptsFolder && r.receiptsFolder.unmatched.length > 0 && <UnmatchedReceipts r={r} send={send} onAdd={onAdd} />}
    </>
  );
}

const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

/** Receipts in the folder no expense was matched to: open one, tie it to an expense, or log the bill it's for. */
function UnmatchedReceipts({ r, send, onAdd }: { r: HsaReport; send: Send; onAdd: () => void }) {
  const folder = r.receiptsFolder!;
  // Expenses a receipt could be for: no receipt in the folder yet, paid up to ~6 months after the receipt's date.
  const choices = (date: string | null) =>
    r.expenses
      .filter((e) => !e.receiptFiles.some((m) => m.how !== "DATE"))
      .map((e) => ({ e, gap: date ? dayNum(e.date) - dayNum(date) : 0 }))
      .filter(({ gap }) => gap >= -14 && gap <= 200)
      .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))
      .slice(0, 30)
      .map(({ e }) => e);
  return (
    <Card
      title={`${folder.unmatched.length} receipt${folder.unmatched.length === 1 ? " in the folder matches" : "s in the folder match"} no expense`}
      subtitle={`Of ${folder.fileCount} files in ${folder.dir}. Matched by the amount printed in the receipt next to a date, or by the date in a photo's file name. Tie one to its expense, or add the bill if it isn't logged.`}
      actions={
        <button type="button" className={btn.secondary} onClick={onAdd}>
          + Add expense
        </button>
      }
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>File</th>
              <th className={table.th}>Dated</th>
              <th className={table.th}>Tie to</th>
            </tr>
          </thead>
          <tbody>
            {folder.unmatched.map((f) => {
              const opts = choices(f.date);
              return (
                <tr key={f.file} className={table.trHover}>
                  <td className={table.td}>
                    <button type="button" className="text-xs text-fg hover:underline" onClick={() => openReceipt(f.file)} title="Open it">
                      {f.file}
                    </button>
                  </td>
                  <td className={`${table.td} num whitespace-nowrap text-xs text-muted`}>{f.date ?? "no date in its name"}</td>
                  <td className={table.td}>
                    <select
                      className={`${selectCls} text-xs`}
                      value=""
                      aria-label={`Tie ${f.file} to an expense`}
                      disabled={!opts.length}
                      onChange={(ev) => ev.target.value && void send({ op: "receipt", ids: [ev.target.value], receipt: true, receiptRef: f.file })}
                    >
                      <option value="">{opts.length ? "Choose its expense…" : "No logged expense near its date"}</option>
                      {opts.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.date} · {e.provider || "Unnamed"} · {formatUsdCents(e.amountCents)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** How an expense came to be marked reimbursed, in a few words. */
function reimbursedHow(e: ExpenseView): string {
  const r = e.reimbursement!;
  const when = r.markedAt ? ` on ${r.markedAt.slice(0, 10)}` : "";
  if (e.withdrawal) return `tied to ${e.withdrawal.payee}, ${e.withdrawal.date} (${formatUsdCents(e.withdrawal.amountCents)})${when}`;
  if (e.source === "IMPORT" && !r.markedAt) return "from the imported spreadsheet";
  return `marked by hand${when}`;
}

/**
 * Opens a file from the receipts folder in a new tab. The tab opens at the click (a tab
 * opened after the fetch would be blocked as a pop-up), then gets the file; with pop-ups
 * blocked the file is downloaded instead.
 */
export function openReceipt(file: string) {
  const tab = window.open("", "_blank");
  void fetch(`/api/hsa/receipt?file=${encodeURIComponent(file)}`, { headers: apiSecretHeaders() })
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not open the receipt");
      if (!tab) return void downloadResponse(res, file.split("/").pop()!);
      const url = URL.createObjectURL(await res.blob());
      tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch((err: Error) => {
      tab?.close();
      window.alert(err.message);
    });
}

const cellBtn = "whitespace-nowrap rounded px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** The Receipt column: a receipt found in the folder (opens it), ticked by hand, a photo that may be it, or still needed. */
function ReceiptCell({ e, send }: { e: ExpenseView; send: Send }) {
  const proven = e.receiptFiles.find((m) => m.how !== "DATE");
  const maybe = e.receiptFiles.find((m) => m.how === "DATE");
  if (proven) {
    const more = e.receiptFiles.filter((m) => m.how !== "DATE").length - 1;
    const why =
      proven.how === "LINKED" ? `Tied to ${proven.file} in the receipts folder` : `${proven.file} shows ${formatUsdCents(e.amountCents)}${proven.date ? ` next to ${proven.date}` : ""}`;
    return (
      <button type="button" onClick={() => openReceipt(proven.file)} className={`${cellBtn} text-pos hover:underline`} title={`${why}. Click to open it.`}>
        ✓ on file{more > 0 && <span className="text-faint"> +{more}</span>}
      </button>
    );
  }
  if (e.receipt) {
    return (
      <button
        type="button"
        onClick={() => send({ op: "receipt", ids: [e.id], receipt: false })}
        className={`${cellBtn} text-pos`}
        title={`Receipt saved${e.receiptRef ? `: ${e.receiptRef}` : ""}, not in the receipts folder (click to unmark)`}
      >
        ✓ saved
      </button>
    );
  }
  if (maybe) {
    return (
      <span className="flex items-center whitespace-nowrap">
        <button type="button" onClick={() => openReceipt(maybe.file)} className={`${cellBtn} text-warn hover:underline`} title={`${maybe.file} is dated ${maybe.date}, but its amount can't be read (a photo or a scan). Click to open it.`}>
          possible
        </button>
        <button type="button" className={`${cellBtn} text-muted hover:text-fg`} title={`It is this expense's receipt: tie ${maybe.file} to it`} onClick={() => send({ op: "receipt", ids: [e.id], receipt: true, receiptRef: maybe.file })}>
          tie
        </button>
      </span>
    );
  }
  return (
    <button type="button" onClick={() => send({ op: "receipt", ids: [e.id], receipt: true })} className={`${cellBtn} text-warn hover:text-fg`} title="No receipt in the receipts folder or saved yet (click when you have it)">
      needed
    </button>
  );
}

function Row({ e, picked, toggle, send, onEdit }: { e: ExpenseView; picked: boolean; toggle: () => void; send: Send; onEdit: () => void }) {
  return (
    <tr className={`${table.trHover} ${picked ? "bg-accent-soft/50" : ""} ${e.flags.includes("BEFORE_OPEN") ? "opacity-60" : ""}`}>
      <td className={table.td}>
        <input type="checkbox" aria-label={`Select ${e.provider}`} checked={picked} onChange={toggle} />
      </td>
      <td className={`${table.td} num whitespace-nowrap`}>{e.date}</td>
      <td className={`${table.td} min-w-[14rem]`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-fg">{e.provider}</span>
          {e.flags.map((f) =>
            FLAG_BADGE[f] ? (
              <Badge key={f} tone={FLAG_BADGE[f]!.tone} title={FLAG_BADGE[f]!.title}>
                {FLAG_BADGE[f]!.label}
              </Badge>
            ) : null,
          )}
        </div>
        <div className="text-[11px] text-muted">
          {KIND_LABEL[e.kind]}
          {e.notes && ` · ${e.notes}`}
        </div>
        {e.doubt && <div className="text-[11px] text-warn">{e.doubt}</div>}
      </td>
      <td className={`${table.td} whitespace-nowrap text-fg-2`}>{e.patient || <span className="text-faint">—</span>}</td>
      <td className={`${table.td} max-w-[13rem] truncate whitespace-nowrap text-xs`}>
        {e.paid ? (
          <span title={`${e.paid.payee} · ${e.paid.date}${e.paidAuto ? " · matched by amount and date" : ""}`}>
            <span className="text-fg-2">{e.paid.account || e.paid.fp.institution}</span> <span className="text-muted">{e.paid.date.slice(5)}</span>
            {e.paidAuto && <span className="ml-1 text-faint">auto</span>}
          </span>
        ) : (
          <span className="text-faint" title="No card or bank row of this amount within 10 days (paid in cash, by an untracked card, or the statement isn't imported).">
            —
          </span>
        )}
      </td>
      <td className={table.td}>
        <ReceiptCell e={e} send={send} />
      </td>
      <td className={table.tdR}>{formatUsdCents(e.amountCents)}</td>
      <td className={`${table.td} whitespace-nowrap text-xs`}>
        {e.reimbursement ? (
          <span className="flex flex-col gap-0.5">
            <span title={e.reimbursement.note || undefined}>
              <Badge tone={e.flags.includes("BAD_TIE") ? "neg" : "pos"}>reimbursed</Badge> <span className="text-muted">{e.reimbursement.date ?? "date unknown"}</span>
            </span>
            <span className="text-[11px] text-faint">
              {reimbursedHow(e)} ·{" "}
              <button type="button" className="underline hover:text-fg" onClick={() => send({ op: "unreimburse", ids: [e.id] })}>
                undo
              </button>
            </span>
          </span>
        ) : (
          <span className="text-muted" title="Days since paid, and the estimated tax-free growth on the money left in the HSA meanwhile">
            waiting {waitLabel(e.daysWaiting)}
            {e.growthCents > 0 && <span className="ml-1 text-pos">+{usd0(e.growthCents)}</span>}
          </span>
        )}
      </td>
      <td className={table.td}>
        <span className="flex whitespace-nowrap">
          <button type="button" className={btn.ghost} onClick={onEdit}>
            Edit
          </button>
          {e.flags.includes("NOT_MEDICAL") && (
            <button type="button" className={btn.ghost} title="It is a medical expense: keep it and stop flagging it" onClick={() => send({ op: "keep", ids: [e.id] })}>
              Keep
            </button>
          )}
          {e.source === "LEDGER" && (
            <button
              type="button"
              className={btn.ghost}
              title="Not an HSA expense: remove it from the log and don't suggest its charge again"
              onClick={() => send({ op: "delete", ids: [e.id], dismiss: true })}
            >
              Not HSA
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}
