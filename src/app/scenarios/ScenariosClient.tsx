"use client";

import type { ScenariosBook } from "@/app/api/scenarios/route";
import type { ScenariosFileBody } from "@/app/api/scenarios/file/route";
import { BlockedNote } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { useChartPalette } from "@/components/shell/chartPalette";
import { notify } from "@/components/ui/Feedback";
import { ErrorNote, Loading, PageBody, WhatIf } from "@/components/ui/kit";
import { buildForecast } from "@/lib/forecast/forecast";
import type { ForecastData } from "@/lib/forecast/load";
import { metricsOf } from "@/lib/scenarios/compare";
import { runScenario, type ScenarioContext, type ScenarioRun } from "@/lib/scenarios/engine";
import { emptyScenario, MAX_COMPARED, MAX_SCENARIOS, personChange, type BuyHome, type Scenario, type ScenarioFile } from "@/lib/scenarios/types";
import { taxYearParams } from "@/lib/tax/params";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { DifferenceTable, MonthTable, PathChart, type Col } from "./Compare";
import { addMonths, Editor, ModelEditor } from "./Editor";
import { dayLabel, monthLabel, tiny } from "./ui";

const TODAY = "today";
const TODAY_PLAN = emptyScenario(TODAY, "Today's plan");
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Scenarios: today's plan (the shared forecast) beside up to four named what-ifs — pay,
 * children, a home, spending, assumptions — each rerun on every edit by the scenario
 * engine (lib/scenarios), which lays the changes on the forecast's own engine. Saved in
 * data/scenarios.json as they're edited. Estimates only: nothing here is proven or enters
 * a proven total.
 */
export function ScenariosClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [fc, setFc] = useState(() => cachedResponse<ForecastData>("/api/forecast"));
  const [book, setBook] = useState(() => cachedResponse<ScenariosBook>("/api/scenarios"));
  const [saved, setSaved] = useState<ScenariosFileBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    Promise.all([api.call<ForecastData>("/api/forecast"), api.call<ScenariosBook>("/api/scenarios"), api.call<ScenariosFileBody>("/api/scenarios/file")])
      .then(([f, b, s]) => {
        setFc(f);
        setBook(b);
        setSaved(s);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const save = useCallback((file: ScenarioFile) => api.call<ScenarioFile>("/api/scenarios/file", { method: "PUT", json: file }), [api]);

  return (
    <PageBody>
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!api.ready ? null : !fc || !book || !saved ? (
        !error && <Loading label="Running today's plan and your scenarios…" />
      ) : !fc.profile.seeds ? (
        <BlockedNote what="today's plan (the forecast's starting point)" blockers={fc.profile.seedBlockers} limit={12} withheld />
      ) : (
        <Body fc={fc} book={book} initial={saved.file} buy={saved.buy} save={save} />
      )}
    </PageBody>
  );
}

function Body({ fc, book, initial, buy, save }: { fc: ForecastData; book: ScenariosBook; initial: ScenarioFile; buy: Omit<BuyHome, "at">; save: (f: ScenarioFile) => Promise<ScenarioFile> }) {
  const seeds = fc.profile.seeds!;
  const [file, setFile] = useState(initial);
  const [selected, setSelected] = useState<string>(initial.compare[0] ?? initial.scenarios[0]?.id ?? TODAY);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const palette = useChartPalette();

  // Save a moment after the last edit (only what differs from what's on disk).
  const onDisk = useRef(JSON.stringify(initial));
  useEffect(() => {
    const text = JSON.stringify(file);
    if (text === onDisk.current) return;
    setStatus("saving");
    const t = setTimeout(() => {
      save(file)
        .then(() => {
          onDisk.current = text;
          setStatus("saved");
        })
        .catch(() => setStatus("error"));
    }, 600);
    return () => clearTimeout(t);
  }, [file, save]);

  const forecast = useMemo(() => buildForecast({ seeds, bonusFacts: fc.bonusFacts }, fc.profile.settings.outlook), [seeds, fc]);
  const ctx = useMemo<ScenarioContext>(() => ({ forecast, seeds, facts: book.facts, model: file.model, params: taxYearParams(seeds.taxYear) }), [forecast, seeds, book.facts, file.model]);
  // One run per scenario object: an edit reruns only the scenario it changed.
  const runs = useMemo(() => ({ ctx, map: new WeakMap<Scenario, ScenarioRun>() }), [ctx]);
  const runOf = useCallback(
    (s: Scenario) => {
      let r = runs.map.get(s);
      if (!r) runs.map.set(s, (r = runScenario(runs.ctx, s)));
      return r;
    },
    [runs],
  );

  const shown = useDeferredValue(file);
  const startKey = forecast.startKey;
  const firstKey = addMonths(startKey, 1);
  const horizonYear = forecast.plan.horizonYear;
  const cols = useMemo<Col[]>(() => {
    const ids = [TODAY, ...shown.compare];
    return ids.flatMap((id) => {
      const s = id === TODAY ? TODAY_PLAN : shown.scenarios.find((x) => x.id === id);
      if (!s) return [];
      const run = runOf(s);
      return [{ id, name: s.name, run, today: id === TODAY, m: metricsOf(run, { startKey, window: run.firstChange ?? firstKey, horizonYear, goals: book.goals }) }];
    });
  }, [shown, runOf, startKey, firstKey, horizonYear, book.goals]);

  const current = file.scenarios.find((s) => s.id === selected) ?? null;
  const currentRun = current ? runOf(current) : runOf(TODAY_PLAN);
  const selectedCol = cols.find((c) => c.id === selected) ?? cols[0]!;

  const update = (s: Scenario) => setFile((f) => ({ ...f, scenarios: f.scenarios.map((x) => (x.id === s.id ? s : x)) }));
  const add = (s: Scenario) => {
    if (file.scenarios.length >= MAX_SCENARIOS) {
      notify(`Up to ${MAX_SCENARIOS} scenarios: delete one first`, { tone: "bad" });
      return;
    }
    setFile((f) => ({ ...f, scenarios: [...f.scenarios, s], compare: f.compare.length < MAX_COMPARED ? [...f.compare, s.id] : f.compare }));
    setSelected(s.id);
  };
  const toggleCompare = (id: string) =>
    setFile((f) => {
      if (f.compare.includes(id)) return { ...f, compare: f.compare.filter((x) => x !== id) };
      if (f.compare.length >= MAX_COMPARED) {
        notify(`Up to ${MAX_COMPARED} scenarios side by side`, { tone: "bad" });
        return f;
      }
      return { ...f, compare: [...f.compare, id] };
    });
  const remove = (s: Scenario) => {
    const before = file;
    setFile((f) => ({ ...f, scenarios: f.scenarios.filter((x) => x.id !== s.id), compare: f.compare.filter((x) => x !== s.id) }));
    if (selected === s.id) setSelected(TODAY);
    notify(`Deleted “${s.name}”`, { tone: "info", undo: () => setFile(before) });
  };
  const copy = (s: Scenario) => add({ ...structuredClone(s), id: uid(), name: `${s.name} (copy)`.slice(0, 60) });

  // Quick starts: one click to a scenario that already changes the one thing.
  const people = forecast.pay.people;
  const earner = [...people].sort((a, b) => b.salary - a.salary)[0];
  const partner = people.length > 1 ? [...people].sort((a, b) => a.salary - b.salary)[0] : null;
  const quick: { label: string; make: () => Scenario }[] = [
    {
      label: "Another child",
      make: () => ({ ...emptyScenario(uid(), "Another child"), children: { added: [{ id: uid(), label: "Child", born: addMonths(firstKey, 9) }], ageOut: false } }),
    },
    { label: "Buy a home", make: () => ({ ...emptyScenario(uid(), "Buy a home"), housing: { rentGrowth: null, buy: { ...buy, at: addMonths(firstKey, 12) } } }) },
    ...(partner
      ? [{ label: `${partner.name} stops work`, make: () => ({ ...emptyScenario(uid(), `${partner.name} stops work`), people: [{ ...personChange(partner.personId), stop: { from: addMonths(firstKey, 6), endsCare: true } }] }) }]
      : []),
    ...(earner
      ? [
          {
            label: `${earner.name}: new job`,
            make: () => ({ ...emptyScenario(uid(), `${earner.name}: new job`), people: [{ ...personChange(earner.personId), jobChange: { from: addMonths(firstKey, 6), salary: Math.round((earner.salary * 1.2) / 100_000) * 100_000, bonusPct: null } }] }),
          },
        ]
      : []),
    { label: "Blank", make: () => emptyScenario(uid(), `Scenario ${file.scenarios.length + 1}`) },
  ];

  const colorOf = (id: string) => {
    const i = [TODAY, ...file.compare].indexOf(id);
    return i < 0 ? "transparent" : i === 0 ? palette.lineBalance : palette.series[i % palette.series.length];
  };

  return (
    <>
      <p className="text-[12px] leading-snug text-muted">
        Each scenario is today&apos;s plan — the{" "}
        <Link href="/forecast" className="text-accent hover:underline">
          forecast
        </Link>{" "}
        from balances proven through <span className="text-fg-2">{dayLabel(seeds.start.asOf)}</span> — with only what you change. Nothing here enters a proven figure.
        <span className="ml-2 text-faint">{status === "saving" ? "saving…" : status === "error" ? "not saved: check the app is running" : "saved"}</span>
      </p>

      <WhatIf why="Scenarios: estimates on today's plan" className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Scenarios">
          <Chip id={TODAY} name="Today's plan" color={colorOf(TODAY)} on={selected === TODAY} compared onSelect={() => setSelected(TODAY)} />
          {file.scenarios.map((s) => (
            <Chip key={s.id} id={s.id} name={s.name} color={colorOf(s.id)} on={selected === s.id} compared={file.compare.includes(s.id)} onSelect={() => setSelected(s.id)} onCompare={() => toggleCompare(s.id)} />
          ))}
          <span className="mx-1 h-4 w-px bg-line-strong" aria-hidden />
          <span className="text-[11px] text-muted">New:</span>
          {quick.map((q) => (
            <button key={q.label} type="button" className={`${tiny} border border-line`} onClick={() => add(q.make())}>
              + {q.label}
            </button>
          ))}
        </div>

        <div className="grid min-w-0 gap-3 xl:grid-cols-[23rem_minmax(0,1fr)]">
          <aside className="min-w-0 self-start rounded-md border border-line bg-surface">
            {current ? (
              <>
                <div className="flex items-center gap-1 border-b border-line px-3 py-1.5">
                  <input
                    aria-label="Scenario name"
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-fg outline-none focus:underline"
                    value={current.name}
                    onChange={(e) => update({ ...current, name: e.target.value.slice(0, 60) })}
                    onBlur={(e) => !e.target.value.trim() && update({ ...current, name: "Scenario" })}
                  />
                  <button type="button" className={tiny} onClick={() => copy(current)} title="A copy to change separately">
                    Copy
                  </button>
                  <button type="button" className={`${tiny} hover:!text-neg`} onClick={() => remove(current)} title="Delete (you can undo)">
                    Delete
                  </button>
                </div>
                <Editor s={current} onChange={update} people={people} plan={forecast.plan} run={currentRun} buy={buy} firstKey={firstKey} />
              </>
            ) : (
              <div className="px-3 py-2 text-[12px] text-fg-2">
                <p className="font-semibold text-fg">Today&apos;s plan</p>
                <p className="mt-1 text-muted">
                  The forecast as its drivers stand (set them on the{" "}
                  <Link href="/forecast" className="text-accent hover:underline">
                    Forecast
                  </Link>{" "}
                  page). Start a scenario above, or copy one, to change pay, children, housing or spending and see what moves.
                </p>
                <p className="mt-2 text-muted">
                  From {monthLabel(firstKey)}; FI {currentRun.fiYear ?? "not within 60 years"}.
                </p>
              </div>
            )}
            <details className="border-t border-line">
              <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-fg">Model choices</summary>
              <ModelEditor model={file.model} onChange={(model) => setFile((f) => ({ ...f, model }))} run={currentRun} />
            </details>
          </aside>

          <div className="flex min-w-0 flex-col gap-3">
            <section className="rounded-md border border-line bg-surface py-1">
              <DifferenceTable cols={cols} goals={book.goals} startKey={startKey} selected={selected} onSelect={setSelected} />
            </section>
            <section className="rounded-md border border-line bg-surface px-3 py-2">
              <PathChart cols={cols} horizonYear={horizonYear} />
            </section>
            <section className="rounded-md border border-line bg-surface px-1 py-2">
              <MonthTable col={selectedCol} today={cols[0]!} />
            </section>
          </div>
        </div>
      </WhatIf>
    </>
  );
}

function Chip({ name, color, on, compared, onSelect, onCompare }: { id: string; name: string; color: string; on: boolean; compared: boolean; onSelect: () => void; onCompare?: () => void }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[12px] ${on ? "border-accent bg-surface-2 text-fg" : "border-line text-fg-2 hover:border-line-strong"}`}>
      {onCompare ? (
        <input type="checkbox" aria-label={`Compare ${name}`} title="Side by side with today's plan" checked={compared} onChange={onCompare} className="h-3 w-3" />
      ) : null}
      <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: color }} />
      <button type="button" className="max-w-[14rem] truncate outline-none focus-visible:underline" onClick={onSelect} aria-pressed={on}>
        {name}
      </button>
    </span>
  );
}
