"use client";

import { Segmented, ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { useChanged } from "@/components/useChanged";
import { ErrorNote, Loading, PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import { BlockedNote } from "@/components/ledger/Blocked";
import type { TaxReport, TaxReportBlocked } from "@/lib/tax/buildTaxReport";
import type { TaxProfile } from "@/lib/tax/profile";
import { useCallback, useEffect, useState } from "react";
import { TaxComparison } from "./TaxComparison";
import { TaxFiled } from "./TaxFiled";
import { TaxIncome } from "./TaxIncome";
import { TaxInputs } from "./TaxInputs";
import { TaxOverview } from "./TaxOverview";
import { TaxPayments } from "./TaxPayments";
import { TaxWorksheet } from "./TaxWorksheet";

export type TaxResponse = (TaxReport | TaxReportBlocked) & { supportedYears: number[] };
export type ProvenTaxResponse = TaxReport & { supportedYears: number[] };
const TABS = ["overview", "worksheet", "compare", "income", "payments", "filed", "inputs"] as const;

/**
 * Taxes: what the household will owe for the year, filing jointly vs separately,
 * the dependent's effect, withholding vs the safe harbor, and every input behind it.
 */
export function TaxClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(() => cachedResponse<TaxResponse>(`/api/tax?year=${new Date().getFullYear()}`));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  // A link can open a given year (/taxes?tab=filed&year=2025).
  useEffect(() => {
    const y = Number(new URLSearchParams(window.location.search).get("year"));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount: the server render can't see the URL, so reading it during render would mismatch hydration
    if (y >= 2000 && y <= 2100) setYear(y);
  }, []);

  if (useChanged([api, year, version]) && api.ready) {
    setLoading(true);
    setError(null);
  }
  useEffect(() => {
    if (!api.ready) return;
    // A slower answer for a year no longer selected must not replace the current one.
    let current = true;
    api
      .call<TaxResponse>(`/api/tax?year=${year}`)
      .then((r) => {
        if (!current) return;
        setData(r);
        if (r.year !== year) setYear(r.year);
      })
      .catch((e: Error) => current && setError(e.message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [api, year, version]);

  const saveProfile = useCallback(
    async (profile: TaxProfile) => {
      await api.call<TaxProfile>("/api/tax/profile", { method: "PUT", json: profile });
      setVersion((v) => v + 1);
    },
    [api],
  );

  // A year filed Single (before the marriage) has no joint-vs-separate choice.
  const single = !!data && !data.blocked && data.filingStatus === "SINGLE";

  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "worksheet", label: "Worksheet" },
          ...(single ? [] : [{ id: "compare" as const, label: "Joint vs separate" }]),
          { id: "income", label: "Income & W-2" },
          { id: "payments", label: "Payments" },
          { id: "filed", label: "Filed return" },
          { id: "inputs", label: "Inputs" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            From your pay stubs, investment statements and bank ledger; a finished year uses its W-2s, 1099s and K-1s from the tax documents folder and is checked against the filed return.
          </p>
          <Segmented
            ariaLabel="Tax year"
            options={(data?.supportedYears ?? [year]).map((y) => ({ value: String(y), label: String(y) }))}
            value={String(year)}
            onChange={(v) => setYear(Number(v))}
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        {!api.ready ? null : !data ? (
          loading && <Loading label="Reading pay stubs and statements…" />
        ) : data.blocked ? (
          <div className={`flex flex-col gap-4 ${loading ? "pointer-events-none opacity-60 transition-opacity" : ""}`}>
            <BlockedNote what={`${data.year} taxes`} blockers={data.blockers} limit={12} withheld />
            {tab === "inputs" ? (
              <TaxInputs r={data} onSave={saveProfile} />
            ) : (
              <p className="text-xs text-muted">
                Household details and deductions can still be edited on the{" "}
                <button type="button" className="text-accent underline" onClick={() => setTab("inputs")}>
                  Inputs
                </button>{" "}
                tab.
              </p>
            )}
          </div>
        ) : (
          <div className={`flex flex-col gap-4 ${loading ? "pointer-events-none opacity-60 transition-opacity" : ""}`}>
            <BlockedNote
              what={`${data.year} taxes`}
              title={data.isCurrentYear || data.year > Number(data.today.slice(0, 4)) ? `Forecast — some ${data.year} documents aren't cross-checked yet` : `Open ledger findings for ${data.year} — the year's filed return and forms are used instead`}
              blockers={data.unverified}
              limit={4}
            />
            {tab === "overview" || (tab === "compare" && single) ? (
              <TaxOverview r={data} onGo={setTab} />
            ) : tab === "worksheet" ? (
              <TaxWorksheet r={data} />
            ) : tab === "compare" ? (
              <TaxComparison r={data} />
            ) : tab === "income" ? (
              <TaxIncome r={data} />
            ) : tab === "payments" ? (
              <TaxPayments r={data} onSave={saveProfile} />
            ) : tab === "filed" ? (
              <TaxFiled r={data} onSave={saveProfile} />
            ) : (
              <TaxInputs r={data} onSave={saveProfile} />
            )}
          </div>
        )}
      </PageBody>
    </>
  );
}
