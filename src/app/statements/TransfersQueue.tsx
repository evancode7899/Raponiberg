"use client";

import type { Api } from "@/components/ledger/useApi";
import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { holdBack } from "@/components/ui/holdBack";
import { btn, Card, ErrorNote, Loading, table } from "@/components/ui/kit";
import { dateLabel } from "@/lib/dates/display";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { formatUsdFromCents } from "@/lib/formatMoney";
import { useCallback, useEffect, useState } from "react";
import { rowProof, type ReviewRow } from "./CategorizeQueue";

type Transfers = {
  unmatched: ReviewRow[];
  ambiguous: ReviewRow[][];
  suggestions: { differenceCents: number; legs: ReviewRow[] }[];
};

function Legs({ legs, pick }: { legs: ReviewRow[]; pick?: { selected: Set<string>; toggle: (id: string) => void } }) {
  return (
    <table className={table.table}>
      <tbody>
        {legs.map((r) => (
          <tr key={r.id} className={table.tr}>
            {pick && (
              <td className={`${table.td} w-6`}>
                <input type="checkbox" checked={pick.selected.has(r.id)} onChange={() => pick.toggle(r.id)} aria-label="Pair this row" />
              </td>
            )}
            <td className={`${table.td} num whitespace-nowrap text-muted`}>{dateLabel(r.date)}</td>
            <td className={`${table.td} whitespace-nowrap text-fg-2`}>{r.account.name}</td>
            <td className={`${table.td} w-full max-w-0 truncate text-muted`} title={r.payee ?? undefined}>
              {r.payee}
              {r.counterpartyInstitution && <span className="ml-1 text-faint">→ {r.counterpartyInstitution}</span>}
            </td>
            <td className={`${table.tdR} font-medium ${r.amountCents > 0 ? "text-pos" : ""}`}>
              <ProofValue proof={rowProof(r)}>{formatUsdFromCents(r.amountCents)}</ProofValue>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Money moving between the household's own accounts. Most pairs match automatically
 * (exact amount, the named account, a plausible date, no rival candidate). What's left
 * needs a person: near-misses (a rollover that lost a fee in transit), rows that could
 * pair more than one way, and legs whose partner isn't on file yet.
 */
export function TransfersQueue({ api, onCount }: { api: Api; onCount: (n: number) => void }) {
  const [data, setData] = useState<Transfers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api
      .call<{ transfers: Transfers }>("/api/ledger/review")
      .then((r) => {
        setData(r.transfers);
        onCount(r.transfers.unmatched.length + r.transfers.ambiguous.length + r.transfers.suggestions.length);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, version, onCount]);

  // Rows decided a moment ago: off the lists while Undo is open, then sent (holdBack).
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const act = useCallback(
    (action: "confirm" | "reject", transactionIds: string[]) => {
      setError(null);
      holdBack({
        say: action === "confirm" ? `Paired ${transactionIds.length} rows as one transfer` : "Marked: never pair these rows",
        hide: () => {
          // Ticks are kept by a group's place in the list, which moves when one leaves it.
          setPicked({});
          setSettled((s) => new Set([...s, ...transactionIds]));
        },
        show: () => setSettled((s) => new Set([...s].filter((id) => !transactionIds.includes(id)))),
        commit: async ({ keepalive }) => {
          setBusy(true);
          try {
            await api.call("/api/transfers", { method: "POST", json: { action, transactionIds }, keepalive });
          } finally {
            setBusy(false);
          }
        },
        done: () => {
          setPicked({});
          notifyLedgerChanged();
          setVersion((v) => v + 1);
        },
      });
    },
    [api],
  );

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading label="Matching transfers…" />;
  const open = (legs: ReviewRow[]) => !legs.some((l) => settled.has(l.id));
  const view = { ...data, suggestions: data.suggestions.filter((x) => open(x.legs)), ambiguous: data.ambiguous.filter(open) };

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      <Card
        title={`Almost-matching transfers (${view.suggestions.length})`}
        subtitle="Same money, amounts a little apart — usually a fee or a residual taken in transit. Confirm to pair them; the difference shows as a transfer cost instead of disappearing. On a rent bill it counts as housing: the landlord changed the bill without listing the change."
      >
        {view.suggestions.length === 0 ? (
          <p className="text-sm text-muted">None — nothing to confirm.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {view.suggestions.map((s, i) => (
              <li key={i} className="rounded-md border border-line p-3">
                <Legs legs={s.legs} />
                <div className="mt-2 flex items-center gap-2">
                  <span className="num text-xs text-muted">Difference {formatUsdFromCents(s.differenceCents)}</span>
                  <span className="flex-1" />
                  <button type="button" className={btn.secondary} disabled={busy} onClick={() => act("reject", s.legs.map((l) => l.id))}>
                    Not related
                  </button>
                  <button type="button" className={btn.primary} disabled={busy} onClick={() => act("confirm", s.legs.map((l) => l.id))}>
                    Same transfer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Could pair more than one way (${view.ambiguous.length})`} subtitle="The matcher never guesses between equally good candidates. Tick the rows that belong together and pair them.">
        {view.ambiguous.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {view.ambiguous.map((g, i) => {
              const sel = picked[i] ?? new Set<string>();
              return (
                <li key={i} className="rounded-md border border-line p-3">
                  <Legs
                    legs={g}
                    pick={{
                      selected: sel,
                      toggle: (id) => {
                        const next = new Set(sel);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        setPicked({ ...picked, [i]: next });
                      },
                    }}
                  />
                  <div className="mt-2 flex justify-end">
                    <button type="button" className={btn.primary} disabled={busy || sel.size < 2} onClick={() => act("confirm", [...sel])}>
                      Pair selected
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title={`Waiting for the other half (${data.unmatched.length})`}
        subtitle="Known to be between your own accounts (so never counted as income or spending), but the other side isn't on file — usually its statement hasn't been uploaded or issued yet. They pair automatically once it arrives."
      >
        {data.unmatched.length === 0 ? <p className="text-sm text-muted">None.</p> : <Legs legs={data.unmatched} />}
      </Card>
    </div>
  );
}
