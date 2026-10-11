"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { useApi } from "@/components/ledger/useApi";
import { PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import { AppearancePanel } from "./AppearancePanel";
import { AppPasswordPanel } from "./AppPasswordPanel";
import { AuditPanel } from "./AuditPanel";
import { CodeLineCount } from "./CodeLineCount";
import { DataPanel } from "./DataPanel";
import { HouseholdPanel } from "./HouseholdPanel";

const TABS = ["general", "household", "data", "audit"] as const;

export function SettingsClient({ requiresApiSecret, requiresDbSecret }: { requiresApiSecret: boolean; requiresDbSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "general");
  return (
    <>
      <Tabs
        tabs={[
          { id: "general", label: "General" },
          { id: "household", label: "Household" },
          { id: "data", label: "Data & backups" },
          { id: "audit", label: "Audit log" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody width="medium">
        <ApiSecretField api={api} />
        {tab === "general" ? (
          <>
            <AppearancePanel />
            {api.ready && <AppPasswordPanel api={api} />}
            {api.ready && <CodeLineCount api={api} />}
          </>
        ) : !api.ready ? null : tab === "household" ? (
          <HouseholdPanel api={api} />
        ) : tab === "data" ? (
          <DataPanel api={api} requiresDbSecret={requiresDbSecret} />
        ) : (
          <AuditPanel api={api} />
        )}
      </PageBody>
    </>
  );
}
