"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { StatementPlan } from "@/components/ledger/StatementPlan";
import { useApi } from "@/components/ledger/useApi";
import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { ErrorNote, Loading, PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import { useCallback, useState } from "react";
import { AccountsPanel } from "./AccountsPanel";
import { CategorizeQueue } from "./CategorizeQueue";
import { CoveragePanel } from "./CoveragePanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { ChecksPanel, IssuesPanel, openIssues } from "./IntegrityPanels";
import { TransactionsPanel } from "./TransactionsPanel";
import { TransfersQueue } from "./TransfersQueue";
import { UploadPanel } from "./UploadPanel";
import { useBookReport } from "./useBookReport";

const TABS = ["import", "plan", "transactions", "categorize", "transfers", "issues", "coverage", "checks", "documents", "accounts"] as const;
type Tab = (typeof TABS)[number];
/** Tabs drawn from the Book's report (one load shared between them). */
const FROM_BOOK = new Set<Tab>(["plan", "issues", "coverage", "checks"]);

/**
 * Everything about the data behind the figures, in four clusters: get statements in (upload,
 * what to download next); the rows they hold (search every row, answer the classifier's
 * questions, settle transfers; once the Transactions and Review pages); what's wrong or
 * missing and every check and exception; and the documents and accounts themselves.
 */
export function StatementsClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTabParam] = useTabParam(TABS, "import");
  // Bumped after anything that changes the ledger, so every panel reloads.
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    notifyLedgerChanged();
  }, []);
  const book = useBookReport(api, version, FROM_BOOK.has(tab));
  const r = book.data;
  const issues = r ? openIssues(r).inRange.length + r.stale.length : null;
  const [queue, setQueue] = useState<{ categorize: number | null; transfers: number | null }>({ categorize: null, transfers: null });
  const setCategorize = useCallback((n: number) => setQueue((c) => ({ ...c, categorize: n })), []);
  const setTransfers = useCallback((n: number) => setQueue((c) => ({ ...c, transfers: n })), []);

  // The Transactions filters live in the URL; leaving that tab drops them, so another tab's address is just its tab.
  const setTab = (t: Tab) => {
    if (tab === "transactions" && t !== "transactions") window.history.replaceState(null, "", window.location.pathname);
    setTabParam(t);
  };

  return (
    <>
      <Tabs
        tabs={[
          { id: "import", label: "Import" },
          { id: "plan", label: "To download" },
          { id: "transactions", label: "Transactions", sep: true },
          { id: "categorize", label: "Categorize", count: queue.categorize },
          { id: "transfers", label: "Transfers", count: queue.transfers },
          { id: "issues", label: "Issues", count: issues, sep: true },
          { id: "coverage", label: "Coverage" },
          { id: "checks", label: "Checks" },
          { id: "documents", label: "Documents", sep: true },
          { id: "accounts", label: "Accounts" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "transactions" ? (
        <TransactionsPanel requiresApiSecret={requiresApiSecret} />
      ) : tab === "categorize" || tab === "transfers" ? (
        <PageBody width="medium">
          <ApiSecretField api={api} />
          {api.ready && (tab === "categorize" ? <CategorizeQueue api={api} onCount={setCategorize} /> : <TransfersQueue api={api} onCount={setTransfers} />)}
        </PageBody>
      ) : (
        <PageBody>
          <ApiSecretField api={api} />
          {!api.ready ? null : tab === "import" ? (
            <UploadPanel api={api} onChanged={changed} onGo={setTab} />
          ) : tab === "documents" ? (
            <DocumentsPanel api={api} version={version} onChanged={changed} />
          ) : tab === "accounts" ? (
            <AccountsPanel api={api} version={version} onChanged={changed} />
          ) : (
            <>
              {book.error && <ErrorNote>{book.error}</ErrorNote>}
              {!r ? (
                !book.error && <Loading label="Running every check…" />
              ) : tab === "plan" ? (
                <StatementPlan plan={r.plan} />
              ) : tab === "issues" ? (
                <IssuesPanel r={r} onAccept={book.accept} onRetire={book.retire} onGo={setTab} />
              ) : tab === "coverage" ? (
                <CoveragePanel r={r} onGo={setTab} />
              ) : (
                <ChecksPanel r={r} onRetire={book.retire} api={api} />
              )}
            </>
          )}
        </PageBody>
      )}
    </>
  );
}
