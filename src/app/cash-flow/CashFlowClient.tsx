"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi, type Api } from "@/components/ledger/useApi";
import { useChartPalette, type ChartPalette } from "@/components/shell/chartPalette";
import { btn, Drawer, EmptyState, ErrorNote, Loading, PageBody, Segmented, selectCls, Tabs, usePersistentState, useTabParam } from "@/components/ui/kit";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BudgetTab } from "./BudgetTab";
import { CategoryDrill, MerchantDrill } from "./Drills";
import { IncomeTab } from "./IncomeTab";
import { MerchantsTab } from "./MerchantsTab";
import { monthKey, proofTarget, sliceRange, type ProofOptions, type RangeId, type Report, type Slice } from "./model";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { CashFlowMetric } from "@/lib/book/proof/cashFlowProof";
import type { SpendingMonth } from "@/lib/book/reports/spending";
import { OverviewTab } from "./OverviewTab";
import { PatternsTab } from "./PatternsTab";
import { WithheldStrip } from "./parts";
import { RecurringTab } from "./RecurringTab";
import { SpendingTab } from "./SpendingTab";
import { TrendsTab } from "./TrendsTab";
import { YoyTab } from "./YoyTab";

const TABS = ["overview", "spending", "trends", "patterns", "yoy", "merchants", "recurring", "budget", "income"] as const;
export type CashTab = (typeof TABS)[number];

export type Drill = { kind: "category"; category: string } | { kind: "merchant"; key: string; name: string; lane: "EXPENSE" | "INCOME" };

/** What every tab gets: the report, the selected months and how to open a drill-down. */
export type Ctx = {
  api: Api;
  report: Report;
  slice: Slice;
  chart: ChartPalette;
  open: (d: Drill) => void;
  goTo: (tab: CashTab, category?: string) => void;
  reload: () => void;
  /** Category the Spending tab should focus (set from an insight). */
  focus: string | null;
  setFocus: (c: string | null) => void;
  /** The proof target for a figure over some of the selected months (see model.proofTarget), with the page's account filter. */
  proof: (metric: CashFlowMetric, months: SpendingMonth[], o?: ProofOptions) => ProofTarget | undefined;
};

type View = { range: RangeId; from: string; to: string };
const defaultView = (): View => ({ range: "12m", from: "", to: "" });

export function CashFlowClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const chart = useChartPalette();
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [view, setView] = usePersistentState<View>("pf-cash-flow-view", defaultView);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [data, setData] = useState(() => cachedResponse<Report>("/api/dashboard/cash-flow?"));
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [version, setVersion] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  // Every account from the first answer, so the filter keeps listing accounts after some are
  // excluded. The ref serves the fetch; the state copy is what renders.
  const accountsRef = useRef<Report["accounts"]>(data?.accounts ?? []);
  const [allAccounts, setAllAccounts] = useState<Report["accounts"]>(data?.accounts ?? []);

  useEffect(() => {
    if (!api.ready) return;
    const sp = new URLSearchParams();
    if (excluded.size && accountsRef.current.length) sp.set("accountIds", accountsRef.current.filter((a) => !excluded.has(a.id)).map((a) => a.id).join(","));
    api
      .call<Report>(`/api/dashboard/cash-flow?${sp}`)
      .then((r) => {
        if (!accountsRef.current.length) {
          accountsRef.current = r.accounts;
          setAllAccounts(r.accounts);
        }
        setData(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, excluded, version]);

  const slice = useMemo(() => (data ? sliceRange(data, view.range, { from: view.from, to: view.to }) : null), [data, view]);
  const goTo = (t: CashTab, category?: string) => {
    if (category) setFocus(category);
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  // The accounts the report was asked for (none: every account), so a proof covers the same ones.
  const accountIds = excluded.size && allAccounts.length ? allAccounts.filter((a) => !excluded.has(a.id)).map((a) => a.id) : undefined;
  const monthOptions = data?.months.map((m) => ({ value: monthKey(m.start), label: m.label })) ?? [];
  const ctx: Ctx | null =
    data && slice && slice.months.length
      ? { api, report: data, slice, chart, open: setDrill, goTo, reload: () => setVersion((v) => v + 1), focus, setFocus, proof: (metric, months, o) => proofTarget(metric, months, accountIds, o) }
      : null;

  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "spending", label: "Spending" },
          { id: "trends", label: "Trends" },
          { id: "patterns", label: "Patterns" },
          { id: "yoy", label: "Year over year" },
          { id: "merchants", label: "Merchants" },
          { id: "recurring", label: "Recurring", count: data?.recurring.filter((c) => c.kind === "bill" && c.active && c.changeCents && c.changeCents > 0).length || null },
          { id: "budget", label: "Budget" },
          { id: "income", label: "Income & savings" },
        ]}
        value={tab}
        onChange={(t) => goTo(t)}
      />
      <PageBody>
        <ApiSecretField api={api} />
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Months shown"
            options={[
              { value: "3m", label: "3M" },
              { value: "6m", label: "6M" },
              { value: "12m", label: "12M" },
              { value: "ytd", label: "YTD" },
              { value: "all", label: "All" },
              { value: "custom", label: "Custom" },
            ]}
            value={view.range}
            onChange={(range) =>
              setView((v) => ({
                ...v,
                range,
                // Seed a custom range with what's on screen.
                ...(range === "custom" && slice?.months.length && !v.from ? { from: monthKey(slice.months[0]!.start), to: monthKey(slice.months.at(-1)!.start) } : {}),
              }))
            }
          />
          {view.range === "custom" && monthOptions.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <select className={selectCls} aria-label="From month" value={view.from || monthOptions[0]!.value} onChange={(e) => setView((v) => ({ ...v, from: e.target.value }))}>
                {monthOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              to
              <select className={selectCls} aria-label="To month" value={view.to || monthOptions.at(-1)!.value} onChange={(e) => setView((v) => ({ ...v, to: e.target.value }))}>
                {monthOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {slice && slice.months.length > 0 && (
            <span className="text-xs text-muted">
              <span className="font-medium text-fg-2">{slice.label}</span> · {slice.months.length} month{slice.months.length === 1 ? "" : "s"}
              {slice.prior.length ? ` · compared with the ${slice.prior.length} before` : ""}
            </span>
          )}
          <div className="ml-auto">
            {allAccounts.length > 1 && <AccountFilter accounts={allAccounts} excluded={excluded} setExcluded={setExcluded} />}
          </div>
        </div>
        {data && <WithheldStrip after={data.withheldAfter} before={data.withheldBefore} through={data.window?.to ?? null} />}
        {error && <ErrorNote>{error}</ErrorNote>}

        {!data ? (
          api.ready && !error && <Loading label="Reading the Book…" />
        ) : data.accounts.length === 0 ? (
          <EmptyState
            title="No bank or card statements yet"
            action={
              <Link href="/statements" className={btn.primary}>
                Import statements
              </Link>
            }
          >
            Cash flow is read from bank and credit card statements: income and spending month by month, with transfers between your own accounts left out.
          </EmptyState>
        ) : !ctx ? (
          <EmptyState title="No proven months yet">
            Every month still has a missing statement or an unpaired transfer. Statements → Issues lists what to fetch; months appear here as soon as they&apos;re proven.
          </EmptyState>
        ) : tab === "overview" ? (
          <OverviewTab ctx={ctx} />
        ) : tab === "spending" ? (
          <SpendingTab ctx={ctx} />
        ) : tab === "trends" ? (
          <TrendsTab ctx={ctx} />
        ) : tab === "patterns" ? (
          <PatternsTab ctx={ctx} />
        ) : tab === "yoy" ? (
          <YoyTab ctx={ctx} />
        ) : tab === "merchants" ? (
          <MerchantsTab ctx={ctx} />
        ) : tab === "recurring" ? (
          <RecurringTab ctx={ctx} />
        ) : tab === "budget" ? (
          <BudgetTab ctx={ctx} />
        ) : (
          <IncomeTab ctx={ctx} />
        )}
      </PageBody>
      <Drawer
        open={drill != null && ctx != null}
        onClose={() => setDrill(null)}
        title={drill ? (drill.kind === "category" ? drill.category : drill.name) : ""}
        subtitle={slice?.label}
        width="60rem"
      >
        {drill && ctx && (drill.kind === "category" ? <CategoryDrill ctx={ctx} category={drill.category} /> : <MerchantDrill ctx={ctx} drill={drill} />)}
      </Drawer>
    </>
  );
}

function AccountFilter({ accounts, excluded, setExcluded }: { accounts: { id: string; name: string }[]; excluded: Set<string>; setExcluded: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const included = accounts.length - excluded.size;
  return (
    <div ref={ref} className="relative">
      <button type="button" className={btn.secondary} onClick={() => setOpen(!open)} aria-expanded={open}>
        Accounts: {excluded.size ? `${included} of ${accounts.length}` : "all"} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-72 rounded-md border border-line-strong bg-surface p-2 shadow-xl">
          <div className="mb-1 flex justify-between px-1 text-xs">
            <button type="button" className={btn.link} onClick={() => setExcluded(new Set())}>
              All
            </button>
            <button type="button" className={btn.link} onClick={() => setExcluded(new Set(accounts.map((a) => a.id)))}>
              None
            </button>
          </div>
          <ul className="app-scroll max-h-72 overflow-y-auto">
            {accounts.map((a) => (
              <li key={a.id}>
                <label className="flex items-center gap-2 rounded px-1 py-1 text-xs text-fg-2 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={!excluded.has(a.id)}
                    onChange={(e) => {
                      const next = new Set(excluded);
                      if (e.target.checked) next.delete(a.id);
                      else next.add(a.id);
                      setExcluded(next);
                    }}
                  />
                  {a.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
