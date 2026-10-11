"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { useApi } from "@/components/ledger/useApi";
import { PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import { useCallback, useState } from "react";
import { CategorizeQueue } from "./CategorizeQueue";
import { TransfersQueue } from "./TransfersQueue";

const TABS = ["categorize", "transfers"] as const;

/** Everything that wants a human decision, in one place. */
export function ReviewClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "categorize");
  const [counts, setCounts] = useState<{ categorize: number | null; transfers: number | null }>({ categorize: null, transfers: null });
  const setCategorize = useCallback((n: number) => setCounts((c) => ({ ...c, categorize: n })), []);
  const setTransfers = useCallback((n: number) => setCounts((c) => ({ ...c, transfers: n })), []);

  return (
    <>
      <Tabs
        tabs={[
          { id: "categorize", label: "Categorize", count: counts.categorize },
          { id: "transfers", label: "Transfers", count: counts.transfers },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody width="medium">
        <ApiSecretField api={api} />
        {api.ready && (tab === "categorize" ? <CategorizeQueue api={api} onCount={setCategorize} /> : <TransfersQueue api={api} onCount={setTransfers} />)}
      </PageBody>
    </>
  );
}
