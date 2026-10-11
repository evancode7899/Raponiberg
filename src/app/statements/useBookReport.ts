"use client";

import { cachedResponse, type Api } from "@/components/ledger/useApi";
import { notifyLedgerChanged } from "@/components/shell/AppShell";
import type { CoverageReport } from "@/lib/ledger/coverageReport";
import type { StatementPlan } from "@/lib/book/reports/statementPlan";
import type { BlockerTimeline } from "@/lib/book/reports/timeline";
import type { IntegrityReport } from "@/lib/book/types";
import { useCallback, useEffect, useState } from "react";

/** What /api/integrity returns: one Book load behind the To download, Issues, Coverage and Checks tabs. */
export type BookReport = IntegrityReport & {
  today: string;
  horizon: { cashFlow: string; netWorth: string };
  timeline: BlockerTimeline;
  /** The statements to download to unlock the periods past the horizon. */
  plan: StatementPlan;
  coverage: CoverageReport;
};

export type OnAccept = (id: string, note: string) => Promise<void>;
export type OnRetire = (id: string, reason: string) => Promise<void>;

/**
 * Loads the Book's report while a tab that shows it is open, and again after the ledger
 * changes (`version`). Accepting or retiring an exception returns the fresh report.
 */
export function useBookReport(api: Api, version: number, active: boolean) {
  const [state, setState] = useState<{ data: BookReport | null; error: string | null; version: number }>(() => ({ data: cachedResponse<BookReport>("/api/integrity"), error: null, version: -1 }));

  useEffect(() => {
    if (!api.ready || !active || state.version === version) return;
    let live = true;
    api
      .call<BookReport>("/api/integrity")
      .then((data) => live && setState({ data, error: null, version }))
      .catch((e: Error) => live && setState((s) => ({ ...s, error: e.message, version })));
    return () => {
      live = false;
    };
  }, [api, active, version, state.version]);

  const post = useCallback(
    async (json: Record<string, string>) => {
      try {
        const data = await api.call<BookReport>("/api/integrity", { method: "POST", json });
        setState((s) => ({ ...s, data, error: null }));
        notifyLedgerChanged();
      } catch (e) {
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [api],
  );
  const accept: OnAccept = useCallback((id, note) => post({ action: "accept", id, note }), [post]);
  const retire: OnRetire = useCallback((id, reason) => post({ action: "retire", id, reason }), [post]);

  return { data: state.data, error: state.error, accept, retire };
}
