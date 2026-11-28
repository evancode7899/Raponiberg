"use client";

import { insuranceDerived } from "@/lib/book/derived/insurance";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { Callout, ErrorNote, Loading, PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import type { InsurancePage } from "@/lib/insurance/page";
import type { InsuranceNotes } from "@/lib/insurance/notes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AutoTab } from "./AutoTab";
import { HomeTab } from "./HomeTab";
import { LifeTab } from "./LifeTab";
import { OverviewTab } from "./OverviewTab";

/**
 * Insurance: every policy found in the statements folder, by line. Overview puts them
 * side by side; Life, Home and Auto each open into sections of their own (coverage, the
 * policy and its documents, payments).
 */

const URL = "/api/insurance";
const TABS = ["overview", "life", "home", "auto"] as const;

export function InsuranceClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [data, setData] = useState(() => cachedResponse<InsurancePage>(URL));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<InsurancePage>(URL)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const saveNotes = useCallback(
    async (next: InsuranceNotes) => {
      const saved = await api.call<InsuranceNotes>(URL, { method: "PUT", json: next });
      setData((d) => (d ? { ...d, notes: saved } : d));
    },
    [api],
  );

  // The coverage gap's years: saved with the notes, then the page read again (the gap is built on the server).
  const saveYears = useCallback(
    async (needYears: number) => {
      if (!data) return;
      await api.call<InsuranceNotes>(URL, { method: "PUT", json: { ...data.notes, needYears } });
      setData(await api.call<InsurancePage>(URL));
    },
    [api, data],
  );

  // One list of the page's figures: every tab draws from it, and the proof sweep holds the same list.
  const figs = useMemo(() => (data ? insuranceDerived(data) : []), [data]);
  const open = useCallback(
    (t: (typeof TABS)[number]) => {
      // A line's own section (?view=) belongs to the tab it was picked on.
      const url = new window.URL(window.location.href);
      url.searchParams.delete("view");
      window.history.replaceState(null, "", url);
      setTab(t);
    },
    [setTab],
  );

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "life" as const, label: "Life", count: data?.policies.length ?? null },
    { id: "home" as const, label: "Home", count: data?.homes.length ?? null },
    { id: "auto" as const, label: "Auto", count: data?.autos.length ?? null },
  ];

  return (
    <>
      <Tabs tabs={tabs} value={tab} onChange={open} />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data ? (
          api.ready && !error && <Loading label="Reading the policy documents…" />
        ) : (
          <div className="flex flex-col gap-4">
            {data.errors.length > 0 && (
              <Callout tone="warn" title="Some insurance documents couldn't be read">
                <ul className="list-disc space-y-1 pl-4">
                  {data.errors.map((e) => (
                    <li key={e.file}>
                      <code className="text-fg-2">{e.file}</code>: {e.error}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {tab === "overview" && <OverviewTab data={data} figs={figs} open={open} saveYears={saveYears} />}
            {tab === "life" && <LifeTab data={data} figs={figs} save={saveNotes} />}
            {tab === "home" && <HomeTab data={data} figs={figs} />}
            {tab === "auto" && <AutoTab data={data} figs={figs} />}
          </div>
        )}
      </PageBody>
    </>
  );
}
