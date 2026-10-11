"use client";

import { Badge, btn, Card, Segmented } from "@/components/ui/kit";
import type { BlockerTimeline, TimelineCell, TimelineFinding, TimelineLane, TimelinePeriod } from "@/lib/book/reports/timeline";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { Fragment, useMemo, useState, type ReactElement } from "react";

const LANES: { id: TimelineLane; label: string }[] = [
  { id: "cashFlow", label: "Cash flow" },
  { id: "netWorth", label: "Net worth" },
  { id: "tax", label: "Taxes" },
];
const laneLabel = (l: TimelineLane) => LANES.find((x) => x.id === l)!.label;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const date = (iso: string) => formatDisplayDateFromYmd(iso);

type Selection = { lane: TimelineLane; period: TimelinePeriod } | null;

/** Proven, failing (data contradicts itself), missing only, or awaiting statements. */
function tone(c: TimelineCell, byId: Map<string, TimelineFinding>): "pos" | "neg" | "warn" | "pending" {
  if (c.state === "proven") return "pos";
  if (c.state === "pending") return "pending";
  return c.blockers.some((id) => byId.get(id)?.status === "FAIL") ? "neg" : "warn";
}
const CELL: Record<ReturnType<typeof tone>, string> = {
  pos: "bg-pos-soft text-pos ring-1 ring-inset ring-pos/40",
  neg: "bg-neg text-white",
  warn: "bg-warn-soft text-warn ring-1 ring-inset ring-warn/40",
  pending: "bg-surface-3 text-muted",
};

/** Consecutive runs of periods, as "Mar 2023 – Jun 2023". */
function runs(periods: TimelinePeriod[], hit: (p: TimelinePeriod) => boolean): string[] {
  const out: string[] = [];
  let first: TimelinePeriod | null = null;
  let last: TimelinePeriod | null = null;
  const flush = () => {
    if (first && last) out.push(first === last ? first.label : `${first.label} – ${last.label}`);
    first = last = null;
  };
  for (const p of periods) {
    if (hit(p)) {
      first ??= p;
      last = p;
    } else flush();
  }
  flush();
  return out;
}

/**
 * Month-by-month timeline of which cash flow, net worth and tax figures are proven, and
 * which open findings withhold the rest — rolled up to quarters and years, with the
 * reverse view (each finding and every period it gates) below.
 */
export function Timeline({ t }: { t: BlockerTimeline }) {
  const byId = useMemo(() => new Map(t.findings.map((f) => [f.id, f])), [t.findings]);
  const [sel, setSel] = useState<Selection>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [laneFilter, setLaneFilter] = useState<TimelineLane | "all">("all");

  const years = useMemo(() => {
    return [...t.year].reverse().map((y) => ({
      y,
      months: t.month.filter((m) => m.start.slice(0, 4) === y.start.slice(0, 4)),
      quarters: t.quarter.filter((q) => q.start.slice(0, 4) === y.start.slice(0, 4)),
    }));
  }, [t]);

  const tally = (lane: TimelineLane, ps: TimelinePeriod[]) => `${ps.filter((p) => p[lane].state === "proven").length} / ${ps.length}`;

  // Each finding with every period it gates, most months first.
  const gating = useMemo(() => {
    const lanes = laneFilter === "all" ? LANES.map((l) => l.id) : [laneFilter];
    return t.findings
      .map((f) => {
        const per = lanes.map((lane) => {
          const hit = (p: TimelinePeriod) => p[lane].blockers.includes(f.id);
          return { lane, months: runs(t.month, hit), monthCount: t.month.filter(hit).length, quarters: runs(t.quarter, hit), years: runs(t.year, hit) };
        });
        return { f, per: per.filter((x) => x.monthCount || x.years.length), months: per.reduce((s, x) => s + x.monthCount, 0) };
      })
      .filter((g) => g.per.length)
      .sort((a, b) => (a.f.status === b.f.status ? b.months - a.months : a.f.status === "FAIL" ? -1 : 1));
  }, [t, laneFilter]);

  const cell: RenderCell = (lane, p, wide) => {
    if (!p) return <td className="p-0.5" />;
    const c = p[lane];
    const k = tone(c, byId);
    const isSel = sel?.lane === lane && sel.period.start === p.start && sel.period.end === p.end;
    const dim = focus && !c.blockers.includes(focus);
    const title = `${laneLabel(lane)} · ${p.label}: ${
      c.state === "proven" ? "proven" : c.state === "pending" ? `past the data edge, awaiting statements${c.awaiting.length ? ` (${c.awaiting.map((a) => a.account).join(", ")})` : ""}` : `withheld by ${c.blockers.length} finding${c.blockers.length === 1 ? "" : "s"}`
    }`;
    return (
      <td className="p-0.5">
        <button
          type="button"
          title={title}
          aria-label={title}
          aria-pressed={isSel}
          onClick={() => setSel(isSel ? null : { lane, period: p })}
          className={`num flex h-6 items-center justify-center rounded text-[10px] font-semibold outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-focus ${
            wide ? "w-12" : "w-7"
          } ${CELL[k]} ${isSel ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""} ${dim ? "opacity-25" : ""}`}
        >
          {c.state === "blocked" ? c.blockers.length : c.state === "pending" ? "…" : "✓"}
        </button>
      </td>
    );
  };

  return (
    <Card
      title="Proven figures"
      subtitle="Month by month: which cash flow, net worth and tax figures are proven, and which findings withhold the rest. Quarters and years roll up the same way the pages do — a year's taxes also need the bank statements through the April filing deadline. Click a cell for what's gating it; click a finding below to light up every period it gates."
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted">
        <Legend cls={CELL.pos} label="Proven" />
        <Legend cls={CELL.neg} label="Withheld — data contradicts itself" />
        <Legend cls={CELL.warn} label="Withheld — data missing" />
        <Legend cls={CELL.pending} label="Past the data edge — awaiting statements" />
        <span>Numbers are how many findings withhold the figure.</span>
      </div>

      <div className="mb-3 grid gap-2 text-xs sm:grid-cols-3">
        {LANES.map((l) => (
          <div key={l.id} className="rounded-md bg-surface-2 px-2.5 py-2">
            <div className="font-medium text-fg">{l.label} proven</div>
            <div className="num text-muted">
              {tally(l.id, t.month)} months · {tally(l.id, t.quarter)} quarters · {tally(l.id, t.year)} years
            </div>
          </div>
        ))}
      </div>

      <div className="app-scroll overflow-x-auto">
        <table className="border-separate border-spacing-0 text-[11px]">
          <tbody>
            {years.map(({ y, months, quarters }) => (
              <YearBlock key={y.start} y={y} months={months} quarters={quarters} cell={cell} />
            ))}
          </tbody>
        </table>
      </div>

      {focus && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Highlighting:</span>
          <span className="font-medium text-fg">{byId.get(focus)?.title}</span>
          <button type="button" className={btn.link} onClick={() => setFocus(null)}>
            Clear
          </button>
        </div>
      )}

      {sel && <CellDetail sel={sel} byId={byId} onFocus={setFocus} onClose={() => setSel(null)} />}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-fg">What&apos;s gating what ({gating.length})</h3>
          <p className="text-xs text-muted">Each open finding and every period it withholds. Clear the top ones first: they unlock the most.</p>
        </div>
        <Segmented
          ariaLabel="Figure"
          size="xs"
          value={laneFilter}
          onChange={setLaneFilter}
          options={[{ value: "all", label: "All" }, ...LANES.map((l) => ({ value: l.id, label: l.label }))]}
        />
      </div>
      {gating.length === 0 ? (
        <p className="mt-2 text-xs text-muted">Nothing is withheld.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {gating.map(({ f, per }) => (
            <li key={f.id} className={`rounded-md bg-surface-2 px-2.5 py-2 text-xs ${focus === f.id ? "ring-2 ring-accent" : ""}`}>
              <div className="flex flex-wrap items-start gap-2">
                <Badge tone={f.status === "FAIL" ? "neg" : "warn"}>{f.status === "FAIL" ? "clash" : "missing"}</Badge>
                <span className="min-w-0 flex-1 font-medium text-fg">{f.title}</span>
                <button type="button" className={btn.link} onClick={() => setFocus(focus === f.id ? null : f.id)}>
                  {focus === f.id ? "Unhighlight" : "Highlight"}
                </button>
              </div>
              <p className="mt-0.5 text-fg-2">{f.fix}</p>
              <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-[6rem_1fr]">
                {per.map((x) => (
                  <div key={x.lane} className="contents">
                    <dt className="font-medium text-muted">{laneLabel(x.lane)}</dt>
                    <dd className="text-fg-2">
                      {x.months.length > 0 && (
                        <span>
                          {x.months.join(", ")} <span className="text-faint">({x.monthCount} mo)</span>
                        </span>
                      )}
                      {x.quarters.length > 0 && <span className="text-muted"> · quarters {x.quarters.join(", ")}</span>}
                      {x.years.length > 0 && <span className="text-muted"> · years {x.years.join(", ")}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-3 w-4 rounded-sm ${cls}`} />
      {label}
    </span>
  );
}

type RenderCell = (lane: TimelineLane, p: TimelinePeriod | undefined, wide?: boolean) => ReactElement;

function YearBlock({ y, months, quarters, cell }: { y: TimelinePeriod; months: TimelinePeriod[]; quarters: TimelinePeriod[]; cell: RenderCell }) {
  const yr = y.start.slice(0, 4);
  const monthAt = (i: number) => months.find((m) => Number(m.start.slice(5, 7)) === i + 1);
  const quarterAt = (i: number) => quarters.find((q) => q.label.startsWith(`Q${i + 1} `));
  return (
    <>
      <tr>
        <th className="sticky left-0 z-10 bg-surface pb-0.5 pr-2 pt-3 text-left text-[13px] font-semibold text-fg">{yr}</th>
        {MONTHS.map((m) => (
          <th key={m} className="w-7 pb-0.5 pt-3 text-center font-medium text-muted">
            {m}
          </th>
        ))}
        <th className="w-3" />
        {[1, 2, 3, 4].map((q) => (
          <th key={q} className="pb-0.5 pt-3 text-center font-medium text-muted">
            Q{q}
          </th>
        ))}
        <th className="w-3" />
        <th className="pb-0.5 pt-3 text-center font-medium text-muted">Year</th>
      </tr>
      {LANES.map((l) => (
        <tr key={l.id}>
          <th className="sticky left-0 z-10 whitespace-nowrap bg-surface pr-2 text-left font-normal text-fg-2">{l.label}</th>
          {MONTHS.map((_, i) => (
            <Fragment key={i}>{cell(l.id, monthAt(i))}</Fragment>
          ))}
          <td />
          {[0, 1, 2, 3].map((i) => (
            <Fragment key={i}>{cell(l.id, quarterAt(i), true)}</Fragment>
          ))}
          <td />
          {cell(l.id, y, true)}
        </tr>
      ))}
    </>
  );
}

function CellDetail({ sel, byId, onFocus, onClose }: { sel: NonNullable<Selection>; byId: Map<string, TimelineFinding>; onFocus: (id: string) => void; onClose: () => void }) {
  const c = sel.period[sel.lane];
  const fs = c.blockers.map((id) => byId.get(id)!).sort((a, b) => (a.status === b.status ? 0 : a.status === "FAIL" ? -1 : 1));
  const edge = c.edge.map((id) => byId.get(id)!);
  return (
    <div className="mt-3 rounded-md border border-line bg-surface-2 p-3 text-xs">
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-semibold text-fg">
          {laneLabel(sel.lane)} · {sel.period.label}
          <span className="ml-2 font-normal text-muted">
            {date(sel.period.start)} – {date(sel.period.end)}
          </span>
        </span>
        <button type="button" className={btn.link} onClick={onClose}>
          Close
        </button>
      </div>
      {c.state === "proven" && <p className="mt-1 text-pos">Proven: nothing withholds it.</p>}
      {c.awaiting.length > 0 && (
        <div className="mt-1.5">
          <div className="font-medium text-fg">Awaiting statements</div>
          <ul className="mt-0.5 list-disc pl-4 text-muted">
            {c.awaiting.map((a) => (
              <li key={a.account}>
                {a.account} — latest statement ends {date(a.lastDay)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {edge.length > 0 && (
        <div className="mt-1.5">
          <div className="font-medium text-fg">Waiting on ({edge.length})</div>
          <ul className="mt-0.5 list-disc pl-4 text-muted">
            {edge.map((f) => (
              <li key={f.id}>
                <span className={f.status === "FAIL" ? "text-neg" : "text-fg-2"}>{f.title}</span> — {f.fix}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fs.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {fs.map((f) => (
            <li key={f.id} className="rounded bg-surface px-2.5 py-2">
              <div className="flex flex-wrap items-start gap-2">
                <Badge tone={f.status === "FAIL" ? "neg" : "warn"}>{f.status === "FAIL" ? "clash" : "missing"}</Badge>
                <span className="min-w-0 flex-1 font-medium text-fg">{f.title}</span>
                <button type="button" className={btn.link} onClick={() => onFocus(f.id)}>
                  Show every period it gates
                </button>
              </div>
              <p className="mt-0.5 text-muted">{f.detail}</p>
              <p className="mt-0.5 text-fg-2">Fix: {f.fix}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
