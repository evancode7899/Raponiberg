"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cashFlowDerived } from "@/lib/book/derived/cashFlow";
import { derivedTarget, derivedText } from "@/lib/book/derived/types";
import { unswept } from "@/lib/book/proof/clearance";
import { cachedResponse, seedResponse, useApi, type Api } from "@/components/ledger/useApi";
import type { FirstData } from "@/lib/cashFlowPayload";
import { useChartPalette, type ChartPalette } from "@/components/shell/chartPalette";
import { btn, Drawer, EmptyState, ErrorNote, Loading, PageBody, scrollToTop, Segmented, selectCls, Tabs, usePersistentState, useTabParam } from "@/components/ui/kit";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CategoryDrill, MerchantDrill, MonthDrill } from "./Drills";
import { monthKey, proofTarget, sliceRange, type ProofOptions, type RangeId, type Report, type Slice } from "./model";
import type { ProofRef } from "@/components/ui/proof/context";
import type { CashFlowMetric } from "@/lib/book/proof/cashFlowProof";
import type { SpendingMonth } from "@/lib/book/reports/spending";
import { OverviewTab } from "./OverviewTab";
import { BudgetTab, IncomeTab, MerchantsTab, PatternsTab, RecurringTab, SpendingTab, TrendsTab, UnusualTab, YoyTab } from "./lazyTabs";
import { WithheldStrip } from "./parts";
import { withMerchants, type CashFlowMerchants } from "@/lib/cashFlowParts";

const TABS = ["overview", "spending", "trends", "patterns", "yoy", "merchants", "recurring", "unusual", "budget", "income"] as const;
export type CashTab = (typeof TABS)[number];

export type Drill =
  /** `external`: a category of money to or from untracked accounts (a name like "Other income" can be both). */
  | { kind: "category"; category: string; external?: boolean }
  | { kind: "merchant"; key: string; name: string; lane: "EXPENSE" | "INCOME" }
  /** One month, audited: its figures, bands, categories and credits, each opening its rows. */
  | { kind: "month"; start: string };

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
  proof: (metric: CashFlowMetric, months: SpendingMonth[], o: ProofOptions) => ProofRef;
  /** A derived figure's proof (derived/cashFlow.ts): swept on every account, so withheld under an account filter. */
  dp: (figure: string, key?: string) => ProofRef;
  /** A derived figure's words as the list states them (a merchant's pattern), for the page to draw. */
  words: (figure: string, key?: string) => string;
};

type View = { range: RangeId; from: string; to: string };
const defaultView = (): View => ({ range: "12m", from: "", to: "" });

export function CashFlowClient({ requiresApiSecret, first = null }: { requiresApiSecret: boolean; first?: FirstData | null }) {
  const api = useApi(requiresApiSecret);
  const chart = useChartPalette();
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [view, setView] = usePersistentState<View>("pf-cash-flow-view", defaultView);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // Every tab but Merchants and Year over year, and no drill-down, reads the report without its merchant lists (most of its bytes): those come apart, when asked for.
  const [data, setData] = useState(() => seedResponse<Report>(first) ?? cachedResponse<Report>("/api/dashboard/cash-flow?parts=lean"));
  const [merch, setMerch] = useState<CashFlowMerchants | null>(() => cachedResponse<CashFlowMerchants>("/api/dashboard/cash-flow?parts=merchants"));
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
    sp.set("parts", "lean");
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

  // The merchant lists, for the tabs that draw them, read for the same accounts as the report.
  // Merchants and Year over year list merchants, and every drill-down does (a category's merchants, a month's biggest, a merchant's months).
  const needMerchants = tab === "merchants" || tab === "yoy" || drill != null;
  const [merchFor, setMerchFor] = useState<string | null>(null);
  const merchKey = `${[...excluded].sort().join(",")}|${version}`;
  useEffect(() => {
    if (!api.ready || !needMerchants || merchFor === merchKey) return;
    const sp = new URLSearchParams();
    if (excluded.size && accountsRef.current.length) sp.set("accountIds", accountsRef.current.filter((a) => !excluded.has(a.id)).map((a) => a.id).join(","));
    sp.set("parts", "merchants");
    let live = true;
    api
      .call<CashFlowMerchants>(`/api/dashboard/cash-flow?${sp}`)
      .then((m) => {
        if (!live) return;
        setMerch(m);
        setMerchFor(merchKey);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [api, needMerchants, merchFor, merchKey, excluded]);
  const merchReady = merch != null && (merchFor === merchKey || (merchFor == null && !excluded.size && version === 0));
  const full = useMemo(() => (data && merch && merchReady ? withMerchants(data, merch) : data), [data, merch, merchReady]);
  const slice = useMemo(() => (full ? sliceRange(full, view.range, { from: view.from, to: view.to }) : null), [full, view]);
  const goTo = (t: CashTab, category?: string) => {
    if (category) setFocus(category);
    setTab(t);
    scrollToTop();
  };

  // The accounts the report was asked for (none: every account), so a proof covers the same ones.
  const accountIds = excluded.size && allAccounts.length ? allAccounts.filter((a) => !excluded.has(a.id)).map((a) => a.id) : undefined;
  const monthOptions = data?.months.map((m) => ({ value: monthKey(m.start), label: m.label })) ?? [];
  const drillMonth = drill?.kind === "month" ? [...(data?.months ?? []), ...(data?.current ? [data.current] : [])].find((m) => m.start === drill.start) : undefined;
  const derived = useMemo(() => (full ? cashFlowDerived(full) : []), [full]);
  const ctx: Ctx | null =
    full && slice && slice.months.length
      ? { api, report: full, slice, chart, open: setDrill, goTo, reload: () => setVersion((v) => v + 1), focus, setFocus, proof: (metric, months, o) => proofTarget(metric, months, accountIds, o), dp: (figure, key) => (accountIds ? unswept("an account filter: derived figures are swept on every account") : derivedTarget("cash-flow", derived, figure, key)), words: (figure, key) => derivedText(derived, figure, key) }
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
          { id: "unusual", label: "Unusual" },
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
            view={{ skip: ["custom"], why: "a custom range is any months you pick: the sweep holds the preset ranges, not every pair of months" }}
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
              {slice.priorLabel ? ` · compared with ${slice.priorLabel}` : ""}
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
          merchReady ? <YoyTab ctx={ctx} /> : <Loading label="Reading each month's merchants…" />
        ) : tab === "merchants" ? (
          merchReady ? <MerchantsTab ctx={ctx} /> : <Loading label="Reading each month's merchants…" />
        ) : tab === "recurring" ? (
          <RecurringTab ctx={ctx} />
        ) : tab === "unusual" ? (
          <UnusualTab ctx={ctx} />
        ) : tab === "budget" ? (
          <BudgetTab ctx={ctx} />
        ) : (
          <IncomeTab ctx={ctx} />
        )}
      </PageBody>
      <Drawer
        open={drill != null && ctx != null}
        onClose={() => setDrill(null)}
        title={drill ? (drill.kind === "category" ? drill.category : drill.kind === "month" ? (drillMonth?.label ?? "Month") : drill.name) : ""}
        subtitle={drill?.kind === "month" ? "One month, figure by figure: click any amount for the rows behind it" : slice?.label}
        width="60rem"
      >
        {drill &&
          ctx &&
          (!merchReady ? (
            <Loading label="Reading each month's merchants…" />
          ) : drill.kind === "category" ? (
            <CategoryDrill ctx={ctx} category={drill.category} external={drill.external} />
          ) : drill.kind === "month" ? (
            drillMonth && <MonthDrill ctx={ctx} month={drillMonth} />
          ) : (
            <MerchantDrill ctx={ctx} drill={drill} />
          ))}
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
