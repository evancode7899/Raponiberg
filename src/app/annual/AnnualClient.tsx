"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { ErrorNote, Loading, PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import type { FinancialProfileSettings } from "@/lib/profile/settings";
import { useCallback, useEffect, useState } from "react";
import { AnnualStatement } from "./AnnualStatement";
import { OneOffsTab } from "./OneOffsTab";

const TABS = ["statement", "one-offs"] as const;

/**
 * Annual report: the household's finances one calendar year per column — what was earned,
 * what was paid and kept, what it all added up to, and what moved net worth — plus the
 * one-off expenses that are kept out of a normal year's living cost.
 */
export function AnnualClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "statement");
  const [data, setData] = useState(() => cachedResponse<AnnualProfileReport>("/api/profile"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!api.ready) return;
    setLoading(true);
    setError(null);
    api
      .call<AnnualProfileReport>("/api/profile")
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [api, version]);

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
          <div className={`flex flex-col gap-4 ${loading ? "pointer-events-none opacity-60 transition-opacity" : ""}`}>
            <p className="-mt-1 text-xs text-muted">
              Calendar years, household level, from pay stubs and statements that pass every integrity check. A figure that can&apos;t be proven says why instead.
            </p>
            <AnnualStatement r={data} onGo={() => setTab("one-offs")} />
          </div>
        ) : (
          <OneOffsTab r={data} onSave={save} recalculating={loading} />
        )}
      </PageBody>
    </>
  );
}
