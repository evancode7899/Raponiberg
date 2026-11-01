"use client";

import { BlockedNote } from "@/components/ledger/Blocked";
import { cardPerksDerived } from "@/lib/book/derived/cardPerks";
import { derivedTarget } from "@/lib/book/derived/types";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { EmptyState, ErrorNote, Loading, PageBody, Segmented, StatCell, StatGrid, Tabs, useTabParam } from "@/components/ui/kit";
import type { CardPerksResponse } from "@/lib/cardPerks/page";
import type { CardPerksSettings } from "@/lib/cardPerks/settings";
import { usd0 } from "@/lib/formatMoney";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { useCallback, useEffect, useState } from "react";
import { CreditsTab } from "./CreditsTab";
import { OptimizerTab } from "./OptimizerTab";
import { OverviewTab } from "./OverviewTab";
import { pct } from "./parts";
import { RewardsTab } from "./RewardsTab";
import { SetupTab } from "./SetupTab";

const TABS = ["overview", "credits", "rewards", "best-card", "setup"] as const;
export type Save = (next: CardPerksSettings) => Promise<boolean>;

export function CardPerksClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [year, setYear] = useState<number | null>(null);
  const path = `/api/card-perks${year ? `?year=${year}` : ""}`;
  const [d, setD] = useState(() => cachedResponse<CardPerksResponse>(path));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .call<CardPerksResponse>(path)
      .then((x) => {
        setD(x);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, path]);
  useEffect(() => {
    if (api.ready) load();
  }, [api, load]);
  // The rewards summaries are read from the statement files in the background the first time: ask again until they're in.
  const reading = d?.report.reading ?? 0;
  useEffect(() => {
    if (!reading) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [reading, load, d]);

  const save: Save = useCallback(
    async (next) => {
      try {
        await api.call("/api/card-perks", { method: "PUT", json: next });
        load();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [api, load],
  );

  const r = d?.report;
  const t = r?.totals;
  // The headline, as the sweep lists it for this year (derived/cardPerks.ts); the year's card findings block every figure.
  const derived = r ? cardPerksDerived(r) : [];
  const dp = (figure: string) => derivedTarget("card-perks", derived, figure, r ? String(r.year) : undefined);
  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "credits", label: "Credits", count: t?.openPerks || null },
          { id: "rewards", label: "Rewards" },
          { id: "best-card", label: "Best card" },
          { id: "setup", label: "Setup" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!r || !t || !d ? (
          api.ready && !error && <Loading label="Matching card credits and rewards to the statements…" />
        ) : !r.cards.length && !r.hidden.length ? (
          <EmptyState title={`No credit card statements for ${r.year}`}>
            Import credit card statements on the Statements page: each card shows up here with its fee, the rewards its statements report, and every credit it paid.
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented view ariaLabel="Year" options={r.years.map((y) => ({ value: String(y), label: String(y) }))} value={String(r.year)} onChange={(y) => setYear(Number(y))} />
              {r.reading > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                  Reading the rewards summary on {r.reading} statement{r.reading === 1 ? "" : "s"}…
                </span>
              )}
            </div>
            <StatGrid cols={5}>
              <StatCell proof={dp("net-value")} blockers={r.blockers}
                label="Net value"
                value={usd0(t.netCents)}
                tone={t.netCents >= 0 ? "pos" : "neg"}
                sub={<>rewards + credits + offers − <ProofValue proof={dp("fees")}>{usd0(t.feesCents)}</ProofValue> in fees</>}
              />
              <StatCell proof={dp("rewards")} blockers={r.blockers} label="Rewards earned" value={usd0(t.rewardsValueCents)} tone="accent" sub={<>on <ProofValue proof={dp("spend")}>{usd0(t.spendCents)}</ProofValue> of card spending</>} />
              <StatCell proof={dp("credits")} blockers={r.blockers}
                label="Credits used"
                value={usd0(t.perksValueCents + t.offersCents)}
                sub={<><ProofValue proof={dp("perks")}>{usd0(t.perksValueCents)}</ProofValue> perks · <ProofValue proof={dp("offers")}>{usd0(t.offersCents)}</ProofValue> offers & bonuses</>}
              />
              <StatCell proof={dp("capture")} blockers={r.blockers} label="Perk capture" value={pct(t.captureRate)} tone={t.captureRate == null ? "neutral" : t.captureRate >= 0.75 ? "pos" : t.captureRate >= 0.4 ? "warn" : "neg"} sub={<><ProofValue proof={dp("missed")}>{usd0(t.missedCents)}</ProofValue> let lapse</>} />
              <StatCell proof={dp("remaining")} blockers={r.blockers}
                label="Still to use"
                value={usd0(t.remainingCents)}
                tone={t.remainingCents > 0 ? "warn" : "neutral"}
                sub={t.openPerks ? `${t.openPerks} credit${t.openPerks === 1 ? "" : "s"} open right now` : "Nothing open right now"}
              />
            </StatGrid>
            <BlockedNote blockers={r.blockers} what={`the card credits and spending for ${r.year}`} />

            {tab === "overview" && <OverviewTab r={r} goCredits={() => setTab("credits")} />}
            {tab === "credits" && <CreditsTab r={r} />}
            {tab === "rewards" && <RewardsTab r={r} />}
            {tab === "best-card" && <OptimizerTab r={r} />}
            {tab === "setup" && <SetupTab r={r} settings={d.settings} save={save} />}
          </>
        )}
      </PageBody>
    </>
  );
}
