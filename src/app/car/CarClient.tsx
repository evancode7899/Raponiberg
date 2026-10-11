"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { useChartPalette, type ChartPalette } from "@/components/shell/chartPalette";
import { btn, Callout, EmptyState, ErrorNote, Loading, PageBody, Tabs, useTabParam } from "@/components/ui/kit";
import type { CarReport, GarageReport, Milestone } from "@/lib/car/report";
import { carName, newCar, ownedOn, type Car, type CarEntry, type GarageSettings } from "@/lib/car/settings";
import { useCallback, useEffect, useState } from "react";
import { CostsTab } from "./CostsTab";
import { blankEntry, EntryEditor, type LogMode } from "./EntryEditor";
import { FuelTab } from "./FuelTab";
import { LogTab } from "./LogTab";
import { OverviewTab } from "./OverviewTab";
import { miles } from "./parts";
import { ServiceTab, VisitEditor } from "./ServiceTab";
import { SetupTab } from "./SetupTab";
import { StatementsTab } from "./StatementsTab";
import { ValueTab } from "./ValueTab";

const TABS = ["overview", "log", "costs", "fuel", "value", "service", "statements", "setup"] as const;
export type CarTab = (typeof TABS)[number];

type Data = { report: GarageReport; settings: GarageSettings; /** Account names by id, to say which card a charge was on. */ accounts?: Record<string, string> };

/** What every tab gets: the garage, and the car being looked at. */
export type CarCtx = {
  garage: GarageReport;
  settings: GarageSettings;
  /** The selected car and its figures. */
  car: Car;
  report: CarReport;
  /** Account names by id. */
  accounts: Record<string, string>;
  chart: ChartPalette;
  /** Replaces the whole garage and reloads the figures. */
  save: (next: GarageSettings) => Promise<boolean>;
  /** Replaces one car. */
  saveCar: (next: Car) => Promise<boolean>;
  saving: boolean;
  goTo: (t: CarTab) => void;
  selectCar: (id: string) => void;
  /** Opens the log editor on an entry (new or existing). */
  editEntry: (e: CarEntry) => void;
  /** Starts a new log entry for the selected car. */
  logNew: (mode: LogMode) => void;
  /** Opens the service-visit form on a scheduled service (null: the next one due). */
  markService: (m: Milestone | null) => void;
};

/** The car picked in the URL (?car=…), else the first one still owned. */
function useCarParam(cars: Car[] | undefined): [string | null, (id: string) => void] {
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount: the server render can't see the URL, so reading it during render would mismatch hydration
    setPicked(new URLSearchParams(window.location.search).get("car"));
  }, []);
  const set = (id: string) => {
    setPicked(id);
    const url = new URL(window.location.href);
    url.searchParams.set("car", id);
    window.history.replaceState(null, "", url);
  };
  const id = cars?.find((c) => c.id === picked)?.id ?? cars?.find((c) => !c.sale)?.id ?? cars?.[0]?.id ?? null;
  return [id, set];
}

export function CarClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const chart = useChartPalette();
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [data, setData] = useState(() => cachedResponse<Data>("/api/car"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [carId, selectCar] = useCarParam(data?.settings.cars);
  const [editing, setEditing] = useState<CarEntry | null>(null);
  const [marking, setMarking] = useState<Milestone | null>(null);

  const load = useCallback(() => {
    api
      .call<Data>("/api/car")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    if (api.ready) load();
  }, [api, load]);

  const save = useCallback(
    async (next: GarageSettings) => {
      setSaving(true);
      try {
        await api.call("/api/car", { method: "PUT", json: data ? withRowKeys(next, data.report) : next });
        const d = await api.call<Data>("/api/car");
        setData(d);
        setError(null);
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [api, data],
  );

  const goTo = (t: CarTab) => {
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  const s = data?.settings;
  const car = s?.cars.find((c) => c.id === carId) ?? null;
  const report = data?.report.cars.find((c) => c.carId === carId) ?? null;

  const addCar = async () => {
    if (!s) return;
    const c = newCar();
    if (await save({ ...s, cars: [...s.cars, c] })) {
      selectCar(c.id);
      goTo("setup");
    }
  };

  const ctx: CarCtx | null =
    data && s && car && report
      ? {
          garage: data.report,
          settings: s,
          car,
          report,
          accounts: data.accounts ?? {},
          chart,
          save,
          saveCar: (next) => save({ ...s, cars: s.cars.map((c) => (c.id === next.id ? next : c)) }),
          saving,
          goTo,
          selectCar,
          editEntry: setEditing,
          logNew: (mode) => setEditing(blankEntry(mode, car.id, data.report.today)),
          markService: (m) => {
            const next = m ?? report.service.next ?? report.service.milestones.at(-1) ?? null;
            if (next) setMarking(next);
            else goTo("service");
          },
        }
      : null;
  const showTab: CarTab = ctx && !report!.configured && tab !== "log" && tab !== "statements" ? "setup" : tab;
  const suggested = data?.report.statements.suggested ?? 0;

  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "log", label: "Log" },
          { id: "costs", label: "Costs" },
          { id: "fuel", label: "Fuel & driving" },
          { id: "value", label: "Value" },
          { id: "service", label: "Service & warranty", count: report && !report.sold && report.service.next && (report.service.overdue || (report.service.milesToNext ?? Infinity) <= 1000) ? 1 : null },
          { id: "statements", label: "From statements", count: suggested + (data?.report.statements.audit.notFound ?? 0) + (data?.report.statements.audit.toCheck ?? 0) || null },
          { id: "setup", label: "Car details" },
        ]}
        value={showTab}
        onChange={goTo}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data || !s ? (
          api.ready && !error && <Loading label="Adding up what the cars cost…" />
        ) : !ctx ? (
          <EmptyState
            title="No cars yet"
            action={
              <button type="button" className={btn.primary} disabled={saving} onClick={() => void addCar()}>
                + Add a car
              </button>
            }
          >
            Add the car you drive: its purchase, then log fill-ups, costs and odometer readings. Car charges on your statements are picked up on their own.
          </EmptyState>
        ) : (
          <>
            <GarageBar ctx={ctx} onAdd={() => void addCar()} />
            {!ctx.report.configured && showTab === "setup" && (
              <Callout tone="info" title={`Finish setting up ${ctx.report.name}`}>
                Add {ctx.report.missing.join(", ")} and save. The figures start from the purchase.
              </Callout>
            )}
            {showTab === "overview" && <OverviewTab ctx={ctx} />}
            {showTab === "log" && <LogTab ctx={ctx} />}
            {showTab === "costs" && <CostsTab ctx={ctx} />}
            {showTab === "fuel" && <FuelTab ctx={ctx} />}
            {showTab === "value" && <ValueTab ctx={ctx} />}
            {showTab === "service" && <ServiceTab ctx={ctx} />}
            {showTab === "statements" && <StatementsTab ctx={ctx} />}
            {showTab === "setup" && <SetupTab key={ctx.car.id} ctx={ctx} />}
          </>
        )}
        {marking && ctx && <VisitEditor key={`${ctx.car.id}:${marking.miles}`} ctx={ctx} milestone={marking} onClose={() => setMarking(null)} />}
        {editing && s && (
          <EntryEditor
            key={editing.id}
            entry={editing}
            match={data?.report.statements.hints.find((h) => h.entryId === editing.id) ?? null}
            cars={s.cars}
            isNew={!s.entries.some((e) => e.id === editing.id)}
            saving={saving}
            onClose={() => setEditing(null)}
            onSave={async (e) => (await save({ ...s, entries: s.entries.some((x) => x.id === e.id) ? s.entries.map((x) => (x.id === e.id ? e : x)) : [...s.entries, e] })) && setEditing(null)}
            onDelete={async () => (await save({ ...s, entries: s.entries.filter((x) => x.id !== editing.id) })) && setEditing(null)}
          />
        )}
      </PageBody>
    </>
  );
}

/**
 * Decisions and links hold each row's key (its date, amount and description) as well as
 * its id, so they survive a re-import that gives rows new ids. Ones saved before keys
 * existed get theirs here, from the rows the report found.
 */
function withRowKeys(s: GarageSettings, report: GarageReport): GarageSettings {
  const keys = new Map(report.statements.charges.map((c) => [c.rowId, c.key]));
  for (const h of report.statements.hints) for (const r of [...h.rows, ...h.candidates]) keys.set(r.rowId, r.key);
  const rowDecisions = Object.fromEntries(Object.entries(s.rowDecisions).map(([id, d]) => [id, d.key ? d : { ...d, key: keys.get(id) ?? "" }]));
  const entries = s.entries.map((e) => (e.links.some((l) => !l.key) ? { ...e, links: e.links.map((l) => (l.key ? l : { ...l, key: keys.get(l.rowId) ?? "" })) } : e));
  return { ...s, rowDecisions, entries };
}

/**
 * The cars (pick one; every tab shows the one picked) and the log buttons, on every tab:
 * logging a fill-up, a cost or a reading is one click from anywhere on the page.
 */
function GarageBar({ ctx, onAdd }: { ctx: CarCtx; onAdd: () => void }) {
  const { settings: s, garage, car, report: r, logNew, selectCar, saving } = ctx;
  const today = garage.today;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-[var(--shadow)]">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="tablist" aria-label="Cars">
        {s.cars.map((c) => {
          const on = c.id === car.id;
          const cr = garage.cars.find((x) => x.carId === c.id);
          const sold = !!c.sale && c.sale.date <= today;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => selectCar(c.id)}
              className={`flex min-w-0 flex-col items-start rounded-md border px-3 py-1 text-left transition-colors ${on ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2"}`}
            >
              <span className={`text-[13px] font-semibold ${on ? "text-fg" : "text-fg-2"}`}>{carName(c, "New car")}</span>
              <span className="num text-[11px] text-muted">
                {sold ? `sold ${c.sale!.date.slice(0, 7)}` : !c.vehicle.purchaseDate ? "not set up" : cr?.odometer.current != null ? `${miles(cr.odometer.current)} mi` : ownedOn(c, today) ? "owned" : "not yet bought"}
              </span>
            </button>
          );
        })}
        <button type="button" className={`${btn.ghost} text-xs`} disabled={saving} onClick={onAdd}>
          + Add car
        </button>
      </div>
      {!r.sold && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted">Log for {s.cars.length > 1 ? carName(car) : "the car"}:</span>
          <button type="button" className={btn.primary} onClick={() => logNew("FUEL")}>
            + Fill-up
          </button>
          <button type="button" className={btn.secondary} onClick={() => logNew("COST")}>
            + Cost
          </button>
          <button type="button" className={btn.secondary} onClick={() => logNew("ODOMETER")}>
            + Odometer
          </button>
          <button type="button" className={btn.secondary} onClick={() => ctx.markService(null)}>
            Service done
          </button>
        </div>
      )}
    </div>
  );
}
