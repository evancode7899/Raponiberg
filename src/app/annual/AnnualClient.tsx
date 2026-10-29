"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { useChanged } from "@/components/useChanged";
import { ErrorNote, Loading, PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import type { ForecastData } from "@/lib/forecast/load";
import type { FinancialProfileSettings } from "@/lib/profile/settings";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnualStatement } from "./AnnualStatement";
import { yearEstimate } from "./estimate";
import { OneOffsTab } from "./OneOffsTab";

const TABS = ["statement", "one-offs"] as const;

/**
 * Annual report: the household's finances one calendar year per column — what was earned,
 * what was paid and kept, what it all added up to, and what moved net worth, with the year
 * in progress estimated whole — plus the one-off expenses kept out of a normal year's
 * living cost. Reads the forecast's data (the annual profile and the bonus facts) so the
 * estimate runs the same forecast the Forecast page does.
 */
export function AnnualClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "statement");
  const [data, setData] = useState(() => cachedResponse<ForecastData>("/api/forecast"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  if (useChanged([api, version]) && api.ready) {
    setLoading(true);
    setError(null);
  }
  useEffect(() => {
    if (!api.ready) return;
    api
      .call<ForecastData>("/api/forecast")
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [api, version]);

  const est = useMemo(() => (data ? yearEstimate(data) : null), [data]);

  /** Saves only the fields given (the server keeps the rest), then recalculates. */
  const save = useCallback(
    async (patch: Partial<FinancialProfileSettings>) => {
      await api.call<FinancialProfileSettings>("/api/profile/settings", { method: "PUT", json: patch });
      setVersion((v) => v + 1);
    },
    [api],
  );

  return (
    <>
      <Tabs
        tabs={[
          { id: "statement", label: "Statement" },
          { id: "one-offs", label: "One-off expenses" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!api.ready ? null : !data ? (
          loading && <Loading label="Running every check…" />
        ) : tab === "statement" ? (
          <div className={loading ? "pointer-events-none opacity-60 transition-opacity" : ""}>
            <AnnualStatement r={data.profile} est={est} />
          </div>
        ) : (
          <OneOffsTab r={data.profile} onSave={save} recalculating={loading} />
        )}
      </PageBody>
    </>
  );
}
