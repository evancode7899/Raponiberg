"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";

import { Badge, Callout, Card, EmptyState, ErrorNote, Loading, PageBody, Segmented, Tabs, useTabParam } from "@/components/ui/kit";

import type { MedicalPage } from "@/lib/medical/page";

import type { Coverage } from "@/lib/medical/types";
import { Fragment, useEffect, useState } from "react";

import { URL, COVERAGE_LABEL, plural, useFigures } from "./parts";

const TABS = ["overview", "claims", "providers", "plan", "documents"] as const;
import { Overview } from "./OverviewTab";
import { Claims } from "./ClaimsTab";
import { Providers } from "./ProvidersTab";
import { Plans } from "./PlanTab";
import { Documents } from "./DocumentsTab";

export function MedicalClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [data, setData] = useState(() => cachedResponse<MedicalPage>(URL));
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<Coverage>("MEDICAL");
  const [pickedYear, setYear] = useState<string | null>(null);
  const fig = useFigures(data);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<MedicalPage>(URL)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const years = data?.years.filter((y) => y.coverage === coverage) ?? [];
  const year = years.find((y) => String(y.year) === pickedYear) ?? years[0] ?? null;
  const claims = data?.claims.filter((c) => c.coverage === coverage && c.year === year?.year) ?? [];
  const failing = data?.checks.filter((c) => !c.ok).length ?? 0;
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "claims" as const, label: "Claims", count: claims.length || null },
    { id: "providers" as const, label: "Providers & care" },
    { id: "plan" as const, label: "Plan & coverage" },
    { id: "documents" as const, label: "Documents", count: failing || null },
  ];
  const hasAny = !!data && (data.statements.length > 0 || data.plans.length > 0 || data.pending.length > 0 || data.planDocs.length > 0);

  return (
    <>
      {hasAny && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data ? (
          api.ready && !error && <Loading label="Reading the explanations of benefits…" />
        ) : !hasAny ? (
          <NothingYet scanned={data.scanned} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                view
                options={data.coverages.map((c) => ({ value: c.coverage, label: `${COVERAGE_LABEL[c.coverage]}${c.statements || c.plans ? "" : " · soon"}` }))}
                value={coverage}
                onChange={(c) => {
                  setCoverage(c);
                  setYear(null);
                }}
              />
              {years.length > 1 && tab !== "plan" && tab !== "documents" && (
                <Segmented view={{ nested: true }} options={years.map((y) => ({ value: String(y.year), label: String(y.year) }))} value={String(year!.year)} onChange={setYear} />
              )}
            </div>
            {data.errors.length > 0 && (
              <Callout tone="warn" title="Some explanations of benefits couldn't be read">
                <ul className="list-disc space-y-1 pl-4">
                  {data.errors.map((e) => (
                    <li key={e.file}>
                      <code className="text-fg-2">{e.file}</code>: {e.error}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {coverage !== "MEDICAL" && !years.length && tab !== "documents" ? (
              <ComingSoon data={data} coverage={coverage} />
            ) : (
              <>
                {tab === "overview" && (year ? <Overview y={year} fig={fig} /> : <NoClaims coverage={coverage} />)}
                {tab === "claims" && (year ? <Claims y={year} claims={claims} fig={fig} inHsaLog={data.inHsaLog} /> : <NoClaims coverage={coverage} />)}
                {tab === "providers" && (year ? <Providers y={year} fig={fig} accounts={data.accounts.filter((a) => a.coverage === coverage)} /> : <NoClaims coverage={coverage} />)}
                {tab === "plan" && <Plans plans={data.plans.filter((p) => p.coverage === coverage)} uses={data.planLimits} problems={data.planProblems} fig={fig} coverage={coverage} />}
              </>
            )}
            {tab === "documents" && <Documents data={data} coverage={coverage} fig={fig} />}
          </div>
        )}
      </PageBody>
    </>
  );
}

function NothingYet({ scanned }: { scanned: boolean }) {
  return (
    <EmptyState title="No health insurance documents found">
      {scanned
        ? "Save your insurer's Explanation of Benefits statements (EOBs) and the plan's documents (the Summary of Benefits and Coverage, the certificate or plan booklet) anywhere in your statements folder, then open this page again. Medical EOBs are read automatically; dental and vision readers are on the way."
        : "The statements folder wasn't found. Set STATEMENTS_DIR, then save the EOBs and plan documents there."}
    </EmptyState>
  );
}

function NoClaims({ coverage }: { coverage: Coverage }) {
  return <EmptyState title={`No ${COVERAGE_LABEL[coverage].toLowerCase()} claims yet`}>Claims appear here as the insurer&apos;s explanations of benefits are saved to the statements folder.</EmptyState>;
}

/** Dental and vision: what's already found, and what reading them needs. */
function ComingSoon({ data, coverage }: { data: MedicalPage; coverage: Coverage }) {
  const c = data.coverages.find((x) => x.coverage === coverage)!;
  const name = COVERAGE_LABEL[coverage].toLowerCase();
  return (
    <Card tone="overview" title={`${COVERAGE_LABEL[coverage]} coverage`} subtitle="Coming soon" actions={<Badge tone="info">Reader on the way</Badge>}>
      <div className="space-y-2 text-sm text-fg-2">
        <p>
          Save the {name} plan&apos;s explanations of benefits and its plan documents (summary of benefits, certificate or booklet) in the statements folder, in a folder of their own. The folder scan already looks for them: {name} EOBs are kept aside until their reader lands, and the plan documents are listed on the Documents tab.
        </p>
        <p>
          Found so far: {plural(c.pending, `${name} EOB`)} waiting for the reader, {plural(c.planDocs, "plan document")}, {plural(c.plans, "plan")} on file.
        </p>
        <p>
          Once they&apos;re there, ask Claude to read the plan documents into <code>data/medical-plans.json</code> (coverage <code>{coverage}</code>) and to add the {name} EOB reader. This tab then fills in the same way as Medical: claims, annual maximum and deductible, what&apos;s covered and how often.
        </p>
      </div>
    </Card>
  );
}
