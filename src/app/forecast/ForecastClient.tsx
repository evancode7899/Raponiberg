"use client";

import { BlockedNote } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { btn, Callout, ErrorNote, Loading, PageBody } from "@/components/ui/kit";
import { fiYear } from "@/lib/fire/fire";
import { balancesAt, buildForecast, type Forecast } from "@/lib/forecast/forecast";
import type { ForecastData } from "@/lib/forecast/load";
import type { OutlookSeeds } from "@/lib/profile/basePay";
import { DEFAULT_OUTLOOK, type FinancialProfileSettings, type OutlookAssumptions } from "@/lib/profile/settings";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ForecastInputs } from "./ForecastInputs";
import { BonusPayments, ForecastLedger } from "./ForecastLedger";
import { monthLabel, short } from "./forecastUi";

const keyLabel = (key: string) => monthLabel(Number(key.slice(0, 4)), Number(key.slice(5, 7)));

/**
 * The forecast engine: one path from the latest proven balances, on one set of drivers,
 * that FIRE, Taxes, Home budget and Goals all read. Left: the drivers (the only place
 * they're set). Top: what each page takes from it. Below: the ledger the path is made of,
 * actual years and the year to date alongside, so every figure adds up.
 */
export function ForecastClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [data, setData] = useState(() => cachedResponse<ForecastData>("/api/forecast"));
  const [error, setError] = useState<string | null>(null);
  const [a, setA] = useState<OutlookAssumptions | null>(() => cachedResponse<ForecastData>("/api/forecast")?.profile.settings.outlook ?? null);

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

  return (
    <PageBody>
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!api.ready ? null : !data || !a ? (
        !error && <Loading label="Proving the starting point and running the forecast…" />
      ) : !data.profile.seeds ? (
        <BlockedNote what="the forecast's starting point" blockers={data.profile.seedBlockers} limit={12} withheld />
      ) : (
        <Body data={data} s={data.profile.seeds} a={a} setA={setA} onSave={save} />
      )}
    </PageBody>
  );
}

function Body({ data, s, a, setA, onSave }: { data: ForecastData; s: OutlookSeeds; a: OutlookAssumptions; setA: (a: OutlookAssumptions) => void; onSave: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saved = data.profile.settings.outlook;
  const dirty = JSON.stringify(a) !== JSON.stringify(saved);
  const set = <K extends keyof OutlookAssumptions>(k: K, v: OutlookAssumptions[K]) => {
    setA({ ...a, [k]: v });
    setMsg(null);
  };
  const f = useMemo(() => buildForecast({ seeds: s, bonusFacts: data.bonusFacts }, a), [s, data.bonusFacts, a]);

  const doSave = async () => {
    setBusy(true);
    try {
      await onSave();
      setMsg({ ok: true, text: "Saved — every page uses these now" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] font-semibold text-fg">Drivers</span>
        <span className="ml-auto flex gap-1">
          <button
            type="button"
            className={`${btn.ghost} !px-2 !py-0.5 text-[11px]`}
            title="Every driver back to its default: figures from your stubs and statements, standard rates (FIRE's own settings are kept)"
            onClick={() =>
              setA({
                ...DEFAULT_OUTLOOK,
                horizonYear: Math.max(DEFAULT_OUTLOOK.horizonYear, s.start.year + 1),
                walkAwayYear: a.walkAwayYear,
                withdrawalRate: a.withdrawalRate,
                stateTaxRate: a.stateTaxRate,
                retirementAge: a.retirementAge,
                volatility: a.volatility,
              })
            }
          >
            Defaults
          </button>
          <button type="button" className={`${btn.ghost} !px-2 !py-0.5 text-[11px]`} disabled={!dirty || busy} onClick={() => setA(saved)} title="Back to the saved drivers">
            Discard
          </button>
          <button type="button" className={`${btn.primary} !px-2.5 !py-0.5 text-[11px]`} disabled={!dirty || busy} onClick={() => void doSave()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
      {(dirty || msg) && (
        <div className={`mt-0.5 text-[11px] ${msg ? (msg.ok ? "text-pos" : "text-neg") : "text-warn"}`}>{msg ? msg.text : "Unsaved: other pages still use the saved drivers"}</div>
      )}
    </div>
  );

  return (
    <div className="grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
      <ForecastInputs s={s} a={a} set={set} f={f} header={header} />
      <div className="flex min-w-0 flex-col gap-3">
        {data.lettersError && <Callout tone="warn" title="Bonus letters couldn't be read">{data.lettersError} The forecast uses stubs and estimates only until it&apos;s fixed.</Callout>}
        <Feeds f={f} s={s} dirty={dirty} />
        <ForecastLedger f={f} r={data.profile} provable={!dirty} />
        <BonusPayments f={f} throughYear={s.currentYear + 2} />
      </div>
    </div>
  );
}

/** What each page that looks ahead takes from this forecast, on the drivers shown. */
function Feeds({ f, s, dirty }: { f: Forecast; s: OutlookSeeds; dirty: boolean }) {
  const fi = useMemo(() => fiYear(f.plan), [f.plan]);
  const cy = s.currentYear;
  const bonusLeft = f.schedule.filter((b) => b.counted && b.source !== "PAID" && b.key.startsWith(`${cy}-`)).reduce((t, b) => t + b.gross, 0);
  const year1 = f.months.slice(0, 12);
  const liquidPerMonth = year1.length ? Math.round(year1.reduce((t, m) => t + m.saved - m.deferrals - m.employerMatch, 0) / year1.length) : 0;
  const next = f.milestones.filter((m) => !m.reached && m.key).slice(0, 2);
  const ageAt = (key: string) => (f.plan.birthYear != null ? `age ${Number(key.slice(0, 4)) - f.plan.birthYear}` : "");
  const basis = f.pay.people.map((p) => `${p.name} ${p.basis === "LATEST" ? "latest" : "typical"} check`).join(" · ");

  return (
    <section aria-label="What other pages read" className="rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
      <div className="flex items-baseline gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Feeds</span>
        <span className={`truncate text-[11px] ${dirty ? "text-warn" : "text-faint"}`}>{dirty ? "these follow your unsaved edits; the pages update when you save" : "what each page reads from this forecast"}</span>
      </div>
      <div className="grid grid-cols-2 divide-line sm:grid-cols-3 xl:grid-cols-5 xl:divide-x">
        <Feed href="/fire" page="FIRE · FI year" value={fi ?? "60+ yrs"} sub={`${fi && f.plan.birthYear != null ? `age ${fi - f.plan.birthYear} · ` : ""}this path + withdrawal rules`} />
        <Feed href="/taxes" page={`Taxes · bonus to come ${cy}`} value={short(bonusLeft)} sub={basis} />
        <Feed href="/home-budget" page={`Home budget · liquid Dec ${cy + 1}`} value={short(balancesAt(f, `${cy + 1}-12`).liquid)} sub="cash for a buy in any month" />
        <Feed href="/goals" page="Goals · into liquid / mo" value={short(liquidPerMonth)} sub="average, next 12 months" negative={liquidPerMonth < 0} />
        <Feed
          href="/fire"
          page={next[0] ? `Net worth ${next[0].label}` : "Milestones"}
          value={next[0] ? keyLabel(next[0].key!) : "—"}
          sub={next[0] ? [ageAt(next[0].key!), next[1] && `${next[1].label} ${keyLabel(next[1].key!)}`].filter(Boolean).join(" · ") : "none ahead"}
        />
      </div>
    </section>
  );
}

function Feed({ href, page, value, sub, negative }: { href: string; page: string; value: ReactNode; sub: ReactNode; negative?: boolean }) {
  return (
    <Link href={href} className="group min-w-0 px-3 py-1.5 hover:bg-surface-2">
      <div className="truncate text-[11px] text-muted group-hover:text-accent" title={page}>{page} →</div>
      <div className={`num truncate text-sm font-semibold ${negative ? "text-neg" : "text-fg"}`}>{value}</div>
      <div className="truncate text-[11px] text-muted" title={typeof sub === "string" ? sub : undefined}>
        {sub}
      </div>
    </Link>
  );
}
