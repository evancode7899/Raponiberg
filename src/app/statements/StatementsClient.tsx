"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { StatementPlan } from "@/components/ledger/StatementPlan";
import { useApi } from "@/components/ledger/useApi";
import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { ErrorNote, Loading, PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import { useCallback, useState } from "react";
import { AccountsPanel } from "./AccountsPanel";
import { CoveragePanel } from "./CoveragePanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { ChecksPanel, IssuesPanel, openIssues } from "./IntegrityPanels";
import { UploadPanel } from "./UploadPanel";
import { useBookReport } from "./useBookReport";

const TABS = ["import", "plan", "issues", "coverage", "checks", "documents", "accounts"] as const;
/** Tabs drawn from the Book's report (one load shared between them). */
const FROM_BOOK = new Set<(typeof TABS)[number]>(["plan", "issues", "coverage", "checks"]);

/**
 * Everything about the data behind the figures: upload statements, see what to download
 * next, what's wrong or missing and what it withholds, what's on file, every check and
 * exception, and the documents and accounts themselves. (Classifier questions and
 * transfers live on Review.)
 */
export function StatementsClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "import");
  // Bumped after anything that changes the ledger, so every panel reloads.
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    notifyLedgerChanged();
  }, []);
  const book = useBookReport(api, version, FROM_BOOK.has(tab));
  const r = book.data;
  const issues = r ? openIssues(r).inRange.length + r.stale.length : null;

  return (
    <>
      <Tabs
        tabs={[
          { id: "import", label: "Import" },
          { id: "plan", label: "To download" },
          { id: "issues", label: "Issues", count: issues },
          { id: "coverage", label: "Coverage" },
          { id: "checks", label: "Checks" },
          { id: "documents", label: "Documents" },
          { id: "accounts", label: "Accounts" },
        ]}
        value={tab}
        onChange={setTab}
      />
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
              <ChecksPanel r={r} onRetire={book.retire} />
            )}
          </>
        )}
      </PageBody>
    </>
  );
}
