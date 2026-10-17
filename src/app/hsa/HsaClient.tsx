"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { apiSecretHeaders, cachedResponse, useApi } from "@/components/ledger/useApi";
import { btn, Callout, downloadResponse, ErrorNote, Loading, PageBody, StatCell, StatGrid, Tabs, useTabParam } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { HsaReport } from "@/lib/hsa/report";
import type { HsaOp } from "@/lib/hsa/store";
import { formatPercentRatio, formatUsdCents, usd0 } from "@/lib/formatMoney";
import { useCallback, useEffect, useState } from "react";
import { ExpenseDrawer, type DraftExpense } from "./ExpenseDrawer";
import { FoundTab } from "./FoundTab";
import { GrowthTab } from "./GrowthTab";
import { hsaProof } from "./proof";
import { ReceiptsTab } from "./ReceiptsTab";
import { ReimburseDrawer, ReimburseTab } from "./ReimburseTab";
import { SettingsTab } from "./SettingsTab";

const TABS = ["receipts", "found", "reimburse", "growth", "settings"] as const;

/** Sends one change to the log; the page reloads the report after it. */
export type Send = (op: HsaOp) => Promise<boolean>;

export function HsaClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "receipts");
  const [r, setR] = useState(() => cachedResponse<HsaReport>("/api/hsa"));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftExpense | null>(null);
  const [reimbursing, setReimbursing] = useState<{ ids: string[]; withdrawal: number | null } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    api
      .call<HsaReport>("/api/hsa")
      .then((d) => {
        setR(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    if (api.ready) load();
  }, [api, load]);

  const send: Send = useCallback(
    async (op) => {
      try {
        await api.call("/api/hsa", { method: "POST", json: op });
        load();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [api, load],
  );

  const exportCsv = async (open: boolean) => {
    try {
      const res = await fetch(`/api/hsa/export${open ? "?status=open" : ""}`, { headers: apiSecretHeaders() });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      setNotice(`Saved ${await downloadResponse(res, "hsa-receipts.csv")}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const t = r?.totals;
  return (
    <>
      <Tabs
        tabs={[
          { id: "receipts", label: "Receipts", count: t?.unreimbursedCount ?? null },
          { id: "found", label: "Found in statements", count: r?.suggestions.length ?? null },
          { id: "reimburse", label: "Reimburse" },
          { id: "growth", label: "Growth & strategy" },
          { id: "settings", label: "Settings" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && (
          <Callout tone="good" action={<button type="button" className={btn.ghost} onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>}>
            {notice}
          </Callout>
        )}
        {!r || !t ? (
          api.ready && !error && <Loading label="Matching receipts to statements…" />
        ) : (
          <>
            <StatGrid cols={4}>
              <StatCell
                label="Reimbursable today"
                value={usd0(t.unreimbursedCents)}
                tone="accent"
                proof={hsaProof("reimbursable", t.unreimbursedCents)}
                sub={
                  t.unreimbursedCount ? (
                    <>
                        {t.unreimbursedCount} receipt{t.unreimbursedCount === 1 ? "" : "s"}, tax-free whenever you want it
                        {t.readyCents < t.unreimbursedCents && (
                          <>
                            {" "}
                            · <ProofValue proof={hsaProof("ready", t.readyCents)}>{usd0(t.readyCents)}</ProofValue> with the receipt saved
                          </>
                        )}
                    </>
                  ) : (
                    "Nothing waiting"
                  )
                }
              />
              <StatCell
                label="Growth from waiting"
                value={usd0(t.growthCents)}
                tone={t.growthCents > 0 ? "pos" : "neutral"}
                proof={hsaProof("growth", t.growthCents)}
                sub={`Est. at ${formatPercentRatio(r.growth.rate, 1)} a year${r.growth.rateSource === "MEASURED" ? " (your HSA's return)" : ""}${t.avgDaysWaiting ? ` · average wait ${Math.round(t.avgDaysWaiting / 30.4)} months` : ""}`}
              />
              <StatCell
                label="Reimbursed so far"
                value={usd0(t.reimbursedCents)}
                proof={hsaProof("reimbursed", t.reimbursedCents)}
                sub={
                  <>
                    {t.reimbursedCount} of {t.count} logged · <ProofValue proof={hsaProof("logged", t.loggedCents)}>{usd0(t.loggedCents)}</ProofValue> in all
                  </>
                }
              />
              <StatCell
                label="HSA balance"
                value={usd0(r.hsa.balanceCents)}
                proof={r.hsa.balanceCents == null ? undefined : hsaProof("balance", r.hsa.balanceCents)}
                sub={
                  r.hsa.balanceCents == null
                    ? "No HSA statements imported"
                    : t.unreimbursedCents > r.hsa.balanceCents
                      ? `${usd0(t.unreimbursedCents - r.hsa.balanceCents)} short of covering every receipt`
                      : `Covers every receipt${t.unreimbursedCents ? ` ${(r.hsa.balanceCents / t.unreimbursedCents).toFixed(1)}×` : ""}${r.hsa.asOf ? ` · as of ${r.hsa.asOf}` : ""}`
                }
              />
            </StatGrid>

            {tab === "receipts" && (
              <ReceiptsTab
                r={r}
                send={send}
                selected={selected}
                setSelected={setSelected}
                onAdd={() => setEditing({ id: null })}
                onEdit={(id) => setEditing({ id })}
                onExport={exportCsv}
                onReimburse={(ids) => setReimbursing({ ids, withdrawal: null })}
                goFound={() => setTab("found")}
              />
            )}
            {tab === "found" && <FoundTab r={r} send={send} onDone={(n) => setNotice(`Added ${n} expense${n === 1 ? "" : "s"} to the log.`)} />}
            {tab === "reimburse" && <ReimburseTab r={r} onReimburse={(ids, withdrawal) => setReimbursing({ ids, withdrawal })} send={send} />}
            {tab === "growth" && <GrowthTab r={r} />}
            {tab === "settings" && <SettingsTab r={r} send={send} />}

            <ExpenseDrawer draft={editing} r={r} send={send} onClose={() => setEditing(null)} />
            <ReimburseDrawer
              ids={reimbursing?.ids ?? null}
              withdrawal={reimbursing?.withdrawal ?? null}
              r={r}
              send={send}
              onClose={() => setReimbursing(null)}
              onDone={(n, cents) => {
                setReimbursing(null);
                setSelected(new Set());
                setNotice(`Marked ${n} expense${n === 1 ? "" : "s"} reimbursed (${formatUsdCents(cents)}).`);
              }}
            />
          </>
        )}
      </PageBody>
    </>
  );
}
