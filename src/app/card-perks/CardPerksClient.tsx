"use client";

import { BlockedNote } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { EmptyState, ErrorNote, Loading, PageBody, Segmented, StatCell, StatGrid, Tabs, useTabParam } from "@/components/ui/kit";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { CardPerksSettings } from "@/lib/cardPerks/settings";
import { formatUsdCents, usd0 } from "@/lib/formatMoney";
import { useCallback, useEffect, useState } from "react";
import { fmtCpp, fmtPoints, type Save } from "./parts";
import { PerksTab } from "./PerksTab";
import { ScorecardTab } from "./ScorecardTab";
import { SetupTab } from "./SetupTab";

const TABS = ["scorecard", "perks", "setup"] as const;
type Response = { report: CardPerksPage; settings: CardPerksSettings };

export function CardPerksClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "scorecard");
  const [year, setYear] = useState<number | null>(null);
  const path = `/api/card-perks${year ? `?year=${year}` : ""}`;
  const [d, setD] = useState(() => cachedResponse<Response>(path));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .call<Response>(path)
      .then((x) => {
        setD(x);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, path]);
  useEffect(() => {
    if (api.ready) load();
  }, [api, load]);

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
  return (
    <>
      <Tabs
        tabs={[
          { id: "scorecard", label: "Scorecard" },
          { id: "perks", label: "Perk tracker", count: t?.openPerks ?? null },
          { id: "setup", label: "Setup" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!r || !t || !d ? (
          api.ready && !error && <Loading label="Matching card credits to perks…" />
        ) : !r.cards.length && !r.hidden.length ? (
          <EmptyState title={`No credit card statements for ${r.year}`}>
            Import credit card statements on the Statements page and each card shows up here with its annual fee, the credits it gave back and the points it earned.
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented ariaLabel="Year" options={r.years.map((y) => ({ value: String(y), label: String(y) }))} value={String(r.year)} onChange={(y) => setYear(Number(y))} />
              <span className="text-xs text-muted">
                Calendar year · points at {fmtCpp(r.centsPerPoint)} each unless a card says otherwise (change it on Setup)
              </span>
            </div>
            <StatGrid cols={5}>
              <StatCell
                label="Net value"
                value={usd0(t.netCents)}
                tone={t.netCents >= 0 ? "pos" : "neg"}
                sub={t.netCents >= 0 ? "Cards are paying for themselves" : "The fees cost more than you got back"}
              />
              <StatCell label="Annual fees" value={usd0(t.feesCents)} sub={`${t.cardsWithFee} card${t.cardsWithFee === 1 ? "" : "s"} with a fee`} />
              <StatCell
                label="Credits used"
                value={usd0(t.creditsCents)}
                tone="accent"
                sub={t.otherCreditsCents ? `${usd0(t.perksValueCents)} perks · ${usd0(t.otherCreditsCents)} offers & other credits` : "From statement credits and uses you marked"}
              />
              <StatCell label="Points value" value={usd0(t.pointsValueCents)} sub={`${fmtPoints(t.points)} on ${usd0(t.spendCents)} of spending`} />
              <StatCell
                label="Still available"
                value={usd0(t.remainingCents)}
                tone={t.remainingCents > 0 ? "warn" : "neutral"}
                sub={t.missedCents ? `${formatUsdCents(t.missedCents)} already missed this year` : "Nothing missed so far"}
              />
            </StatGrid>
            <BlockedNote blockers={r.blockers} what={`the card credits and spending for ${r.year}`} />

            {tab === "scorecard" && <ScorecardTab r={r} settings={d.settings} save={save} goPerks={() => setTab("perks")} />}
            {tab === "perks" && <PerksTab r={r} settings={d.settings} save={save} />}
            {tab === "setup" && <SetupTab r={r} settings={d.settings} save={save} />}
          </>
        )}
      </PageBody>
    </>
  );
}
