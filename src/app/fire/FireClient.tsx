"use client";

import { BlockedNote } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { btn, ErrorNote, Loading, PageBody, Tabs, usePersistentState, useTabParam } from "@/components/ui/kit";
import { analyzeFire, firePlans } from "@/lib/fire/fire";
import { buildForecast } from "@/lib/forecast/forecast";
import type { ForecastData } from "@/lib/forecast/load";
import type { OutlookSeeds } from "@/lib/profile/basePay";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import { projectOutlook, walkAwayTable } from "@/lib/profile/outlook";
import { DEFAULT_OUTLOOK, type FinancialProfileSettings, type OutlookAssumptions } from "@/lib/profile/settings";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FireInputs } from "./FireInputs";
import { LeversTab } from "./LeversTab";
import { OverviewTab } from "./OverviewTab";
import { PlanTab } from "./PlanTab";
import { PlaybookTab } from "./PlaybookTab";
import { StressTab } from "./StressTab";
import type { Dollars } from "./ui";
import { WalkAwayTab } from "./WalkAwayTab";

const TABS = ["overview", "plan", "walk-away", "levers", "stress", "playbook"] as const;
export type FireTab = (typeof TABS)[number];

/**
 * FIRE: the household's path to financial independence on the shared forecast
 * (lib/forecast) — the same pay, bonuses, spending and returns every other page uses —
 * plus FIRE's own settings (walk-away year, withdrawal rate…), which are edited here and
 * kept only when saved. The math is the outlook engine plus the FIRE analysis built on it
 * (lib/fire/fire.ts).
 */
export function FireClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [data, setData] = useState(() => cachedResponse<ForecastData>("/api/forecast"));
  const [error, setError] = useState<string | null>(null);
  const [a, setA] = useState<OutlookAssumptions | null>(() => cachedResponse<ForecastData>("/api/forecast")?.profile.settings.outlook ?? null);
  const [view, setView] = usePersistentState<{ dollars: Dollars }>("pf-fire-view", () => ({ dollars: "nominal" }));

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<ForecastData>("/api/forecast")
      .then((r) => {
        setData(r);
        setA(r.profile.settings.outlook);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const save = useCallback(async () => {
    if (!a || !data) return;
    const saved = await api.call<FinancialProfileSettings>("/api/profile/settings", { method: "PUT", json: { outlook: a } });
    setData({ ...data, profile: { ...data.profile, settings: saved } });
    setA(saved.outlook);
  }, [a, api, data]);

  const playbook = tab === "playbook";
  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "plan", label: "Plan" },
          { id: "walk-away", label: "Walk-away income" },
          { id: "levers", label: "Levers" },
          { id: "stress", label: "Stress test" },
          { id: "playbook", label: "FIRE playbook" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!api.ready ? null : !data || !a ? (
          !error && <Loading label="Proving the starting point and running the plan…" />
        ) : !data.profile.seeds ? (
          playbook ? <PlaybookTab f={null} /> : <BlockedNote what="the FIRE plan's starting point" blockers={data.profile.seedBlockers} limit={12} withheld />
        ) : (
          <Fire data={data} r={data.profile} s={data.profile.seeds} a={a} setA={setA} onSave={save} tab={tab} setTab={setTab} dollars={view.dollars} setDollars={(d) => setView({ dollars: d })} />
        )}
      </PageBody>
    </>
  );
}

function Fire({
  data,
  r,
  s,
  a,
  setA,
  onSave,
  tab,
  setTab,
  dollars,
  setDollars,
}: {
  data: ForecastData;
  r: AnnualProfileReport;
  s: OutlookSeeds;
  a: OutlookAssumptions;
  setA: (a: OutlookAssumptions) => void;
  onSave: () => Promise<void>;
  tab: FireTab;
  setTab: (t: FireTab) => void;
  dollars: Dollars;
  setDollars: (d: Dollars) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saved = r.settings.outlook;
  const dirty = JSON.stringify(a) !== JSON.stringify(saved);
  const set = <K extends keyof OutlookAssumptions>(k: K, v: OutlookAssumptions[K]) => {
    setA({ ...a, [k]: v });
    setMsg(null);
  };

  const forecast = useMemo(() => buildForecast({ seeds: s, bonusFacts: data.bonusFacts }, a), [s, data.bonusFacts, a]);
  const pay = forecast.pay;
  const plans = useMemo(() => firePlans(forecast), [forecast]);
  const f = useMemo(() => analyzeFire(plans.full, plans.base, { asOf: s.start.asOf, retirementAge: a.retirementAge, baristaMonthly: a.baristaMonthly }), [plans, s.start.asOf, a.retirementAge, a.baristaMonthly]);
  const outFull = useMemo(() => projectOutlook(plans.full), [plans.full]);
  const outBase = useMemo(() => (plans.base === plans.full ? outFull : projectOutlook(plans.base)), [plans, outFull]);
  const walkBase = useMemo(() => (plans.base === plans.full ? null : walkAwayTable(plans.base)), [plans]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave();
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (tab === "playbook") return <PlaybookTab f={f} />;
  const props = { f, dollars, setDollars };
  const header = (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
      <span className="text-[13px] font-semibold text-fg">FIRE settings</span>
      {dirty && <span className="text-[11px] text-warn">unsaved</span>}
      {msg && <span className={`text-[11px] ${msg.ok ? "text-pos" : "text-neg"}`}>{msg.text}</span>}
      <span className="ml-auto flex gap-1.5">
        <button
          type="button"
          className={`${btn.ghost} !px-2 !py-0.5 text-[11px]`}
          title="FIRE's settings back to their defaults (the forecast's assumptions are changed on the Forecast page)"
          onClick={() => {
            const d = DEFAULT_OUTLOOK;
            setA({ ...a, walkAwayYear: d.walkAwayYear, withdrawalRate: d.withdrawalRate, stateTaxRate: d.stateTaxRate, retirementAge: d.retirementAge, baristaMonthly: d.baristaMonthly, volatility: d.volatility });
          }}
        >
          Defaults
        </button>
        <button type="button" className={`${btn.ghost} !px-2 !py-0.5 text-[11px]`} disabled={!dirty || busy} onClick={() => setA(saved)} title="Back to the saved assumptions">
          Discard
        </button>
        <button type="button" className={`${btn.primary} !px-2.5 !py-0.5 text-[11px]`} disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </span>
    </div>
  );

  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <FireInputs s={s} a={a} set={set} f={forecast} header={header} />
      <div className="flex min-w-0 flex-col gap-4">
        {tab === "overview" ? (
          <OverviewTab {...props} r={r} s={s} livingLabel={pay.living.typed ? "typed in" : (pay.living.seed?.label ?? "")} livingTyped={pay.living.typed} onGo={setTab} />
        ) : tab === "plan" ? (
          <PlanTab f={f} r={r} s={s} full={outFull} base={outBase} forecast={forecast} />
        ) : tab === "walk-away" ? (
          <WalkAwayTab {...props} walkBase={walkBase} />
        ) : tab === "levers" ? (
          <LeversTab {...props} />
        ) : (
          <StressTab {...props} volatility={a.volatility} />
        )}
      </div>
    </div>
  );
}
