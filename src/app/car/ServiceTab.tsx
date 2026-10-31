"use client";

import { Badge, btn, Callout, Card, Drawer, Field, inputCls, StatCell, StatGrid, table, type Tone } from "@/components/ui/kit";
import type { CarReport, Milestone } from "@/lib/car/report";
import { newId, type ServiceRule } from "@/lib/car/settings";
import { formatPercentRatio } from "@/lib/formatMoney";
import { useState } from "react";
import type { CarCtx } from "./CarClient";
import { CentsInput, fmtDate, miles, NumInput, relative } from "./parts";

const STATUS: Record<Milestone["status"], { tone: Tone; label: string }> = {
  DONE: { tone: "pos", label: "done" },
  OVERDUE: { tone: "neg", label: "overdue" },
  SKIPPED: { tone: "neutral", label: "not logged" },
  NEXT: { tone: "accent", label: "next" },
  UPCOMING: { tone: "neutral", label: "upcoming" },
};

/** The work at a service in a line: what gets replaced or done, then how many inspections. */
export function summarize(items: string[]): string {
  const strip = (x: string) => x.replace(/\s*\(.*?\)\s*/g, " ").trim();
  const inspect = items.filter((x) => /^inspect/i.test(x));
  const work = items.filter((x) => !/^inspect/i.test(x)).map(strip);
  const head = work.length > 6 ? [...work.slice(0, 6), `${work.length - 6} more`] : work;
  return [...head, inspect.length ? `${inspect.length} inspection${inspect.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
}

/**
 * When the next service is due, in a sentence: whichever comes first of the months since
 * the last visit and the mileage, with the other limit after it.
 */
export function serviceDue(r: CarReport, months: number): { tone: Tone; headline: string; detail: string } | null {
  const sv = r.service;
  if (sv.dueMiles == null && !sv.dueByDate) return null;
  const toGo = sv.milesToNext;
  const milesText = sv.dueMiles != null ? `${miles(sv.dueMiles)} mi` : null;
  const last = sv.lastVisit ? `the last one was ${fmtDate(sv.lastVisit.date)}${sv.lastVisit.miles != null ? ` at ${miles(sv.lastVisit.miles)} mi` : ""}` : "";
  if (sv.overdue) {
    const why = toGo != null && toGo <= 0 ? `${miles(-toGo)} mi past ${milesText}` : `${months} months since the last service (${fmtDate(sv.dueByDate)})`;
    return { tone: "neg", headline: `Service overdue: ${why}`, detail: last };
  }
  if (sv.dueBy === "TIME" && sv.dueByDate) {
    const at = sv.odometerAtDue != null ? `, when you'll be near ${miles(sv.odometerAtDue)} mi` : "";
    return {
      tone: daysTo(sv.dueByDate, r.today) <= 45 ? "warn" : "info",
      headline: `Next service due by ${fmtDate(sv.dueByDate)} (${relative(sv.dueByDate, r.today)})`,
      detail: `${months} months after the last one comes first at your pace${at}. By miles it would be ${milesText}${toGo != null ? `, ${miles(toGo)} mi from now` : ""}.${last ? ` ${cap(last)}.` : ""}`,
    };
  }
  return {
    tone: (toGo ?? Infinity) <= 1000 ? "warn" : "info",
    headline: `Next service at ${milesText}${toGo != null ? ` — ${miles(toGo)} mi to go` : ""}`,
    detail: `${sv.nextDueDate ? `Around ${fmtDate(sv.nextDueDate)} at your pace` : "Log odometer readings to see when"}${sv.dueByDate ? `; by time, ${fmtDate(sv.dueByDate)}` : ""}.${last ? ` ${cap(last)}.` : ""}`,
  };
}

const daysTo = (iso: string, today: string) => (Date.parse(iso) - Date.parse(today)) / 86_400_000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ServiceTab({ ctx }: { ctx: CarCtx }) {
  const { report: r, car, saveCar, saving, markService } = ctx;
  const w = r.warranty;
  const sv = r.service;
  const [rules, setRules] = useState(false);
  const allItems = [...new Set(sv.milestones.flatMap((m) => m.items))];
  const order = car.serviceRules.map((x) => x.item);
  allItems.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const due = r.sold ? null : serviceDue(r, car.plan.serviceEveryMonths);

  const usedShare = w.milesLimit && r.odometer.current != null ? Math.min(1, r.odometer.current / w.milesLimit) : null;
  const timeShare =
    w.expiresOn && car.vehicle.inServiceDate ? Math.min(1, Math.max(0, (Date.parse(r.today) - Date.parse(car.vehicle.inServiceDate)) / (Date.parse(w.expiresOn) - Date.parse(car.vehicle.inServiceDate)))) : null;

  return (
    <>
      {due && (
        <Callout
          tone={due.tone === "neg" ? "bad" : due.tone === "warn" ? "warn" : "info"}
          title={due.headline}
          action={
            <button type="button" className={btn.secondary} onClick={() => markService(sv.next)}>
              Log this service
            </button>
          }
        >
          {due.detail}
          {sv.next && <div className="mt-1 text-xs">The {miles(sv.next.miles)}-mile service: {summarize(sv.next.items)}</div>}
        </Callout>
      )}

      {!r.sold && (
        <Card title="Warranty" subtitle={w.expiresOn ? `${car.plan.warrantyYears} years from ${fmtDate(car.vehicle.inServiceDate)} or ${miles(w.milesLimit)} miles, whichever comes first.` : "Set the in-service date and warranty terms under Car details."}>
          <StatGrid cols={4}>
            <StatCell proof={ctx.dp("warranty-miles-left")} label="Miles left" value={miles(w.milesLeft)} sub={usedShare != null ? `${formatPercentRatio(usedShare, 0)} of the miles used` : undefined} />
            <StatCell proof={ctx.dp("warranty-days-left")} label="Time left" value={w.daysLeft != null ? `${(w.daysLeft / 30.44).toFixed(1)} mo` : "—"} sub={w.expiresOn ? `to ${fmtDate(w.expiresOn)}${timeShare != null ? ` · ${formatPercentRatio(timeShare, 0)} used` : ""}` : undefined} />
            <StatCell proof={ctx.dp("warranty-break-even")}
              label="Break-even pace"
              value={w.breakEvenPerDay != null ? `${w.breakEvenPerDay.toFixed(1)} mi/day` : "—"}
              sub={r.odometer.recentPerDay != null ? `you drive ${r.odometer.recentPerDay.toFixed(1)} mi/day` : "miles a day that use it all up just in time"}
            />
            <StatCell proof={ctx.dp("warranty-ends-by")}
              label="Runs out"
              value={w.endsBy ? (w.endsBy === "TIME" ? "by time" : "by miles") : "—"}
              tone={w.endsBy === "MILES" ? "warn" : "neutral"}
              sub={w.endsOn ? `${fmtDate(w.endsOn)}${w.endsBy === "TIME" && w.odometerAtExpiry != null ? ` near ${miles(w.odometerAtExpiry)} mi (${miles(w.milesLimit - w.odometerAtExpiry)} unused)` : ""}` : undefined}
            />
          </StatGrid>
          {usedShare != null && timeShare != null && (
            <div className="mt-3 flex flex-col gap-1.5 text-xs">
              {(
                [
                  ["Miles", usedShare],
                  ["Time", timeShare],
                ] as const
              ).map(([l, v]) => (
                <div key={l} className="flex items-center gap-2">
                  <span className="w-10 text-muted">{l}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${v * 100}%` }} />
                  </div>
                  <span className="num w-10 text-right text-muted">{formatPercentRatio(v, 0)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card
        title="Service schedule"
        subtitle={`Every ${miles(sv.baseMiles)} miles${car.plan.serviceEveryMonths ? ` or ${car.plan.serviceEveryMonths} months` : ""}, whichever comes first. A service done early still counts as that column (a 56k service at 53k is the 56k service), and the next one is due ${miles(sv.baseMiles)} miles after it was really done.`}
        actions={
          <button type="button" className={btn.secondary} onClick={() => setRules(true)}>
            Edit schedule
          </button>
        }
      >
        {sv.milestones.length === 0 ? (
          <p className="text-xs text-muted">Add the car&apos;s odometer at purchase and a schedule to see what&apos;s due.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table} style={{ minWidth: `${16 + sv.milestones.length * 6}rem` }}>
              <thead>
                <tr className={table.head}>
                  <th className={`${table.th} sticky left-0 z-10 bg-surface`}>Miles</th>
                  {sv.milestones.map((m) => (
                    <th key={m.miles} className="whitespace-nowrap px-2 py-1.5 text-center font-semibold text-fg-2">
                      <div>{(m.miles / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k</div>
                      <div className="mt-0.5 font-normal normal-case">
                        <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allItems.map((item) => (
                  <tr key={item} className={table.tr}>
                    <td className={`${table.td} sticky left-0 z-10 max-w-[18rem] bg-surface text-xs`}>{item}</td>
                    {sv.milestones.map((m) => (
                      <td key={m.miles} className={`px-2 py-1 text-center ${m.status === "DONE" ? "text-pos" : m.status === "OVERDUE" ? "text-neg" : m.status === "NEXT" ? "text-accent" : "text-faint"}`}>
                        {m.items.includes(item) ? (m.status === "DONE" ? "✓" : "●") : ""}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-line-strong">
                  <td className={`${table.td} sticky left-0 z-10 bg-surface text-xs font-medium`}>Done</td>
                  {sv.milestones.map((m) => (
                    <td key={m.miles} className="px-2 py-1.5 text-center text-[11px]">
                      {m.visit ? (
                        <button type="button" className="text-pos hover:underline" title={[m.visit.odometer != null ? `at ${miles(m.visit.odometer)} mi` : "", m.visit.note].filter(Boolean).join(" · ") || "Edit"} onClick={() => markService(m)}>
                          {fmtDate(m.visit.date, "short")}
                        </button>
                      ) : (
                        <button type="button" className={btn.link} onClick={() => markService(m)}>
                          Mark done
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {rules && (
        <RulesEditor
          rules={car.serviceRules}
          saving={saving}
          onClose={() => setRules(false)}
          onSave={async (next, months) => (await saveCar({ ...car, serviceRules: next, plan: { ...car.plan, serviceEveryMonths: months } })) && setRules(false)}
          months={car.plan.serviceEveryMonths}
        />
      )}
    </>
  );
}

/** Logs a service as done (or changes or undoes it), optionally with what it cost. */
export function VisitEditor({ ctx, milestone, onClose }: { ctx: CarCtx; milestone: Milestone; onClose: () => void }) {
  const { settings: s, car, save, saving, report: r } = ctx;
  const existing = car.serviceVisits.find((v) => v.milestoneMiles === milestone.miles) ?? null;
  const [date, setDate] = useState(existing?.date ?? r.today);
  const [odometer, setOdometer] = useState<number | null>(existing?.odometer ?? r.odometer.current);
  const [note, setNote] = useState(existing?.note ?? "");
  const [cost, setCost] = useState<number | null>(null);
  const withCar = (visits: typeof car.serviceVisits) => s.cars.map((c) => (c.id === car.id ? { ...c, serviceVisits: visits } : c));
  const submit = async () => {
    const visit = { id: existing?.id ?? newId(), date, odometer, milestoneMiles: milestone.miles, note };
    const visits = [...car.serviceVisits.filter((v) => v.milestoneMiles !== milestone.miles), visit];
    const entries = cost
      ? [...s.entries, { id: newId(), carId: car.id, date, kind: "MAINTENANCE" as const, item: `${Math.round(milestone.miles / 1000)}k service`, note, cents: cost, gallons: null, odometer, partial: false, months: 1, links: [], rejected: [], offStatement: false }]
      : s.entries;
    if (await save({ ...s, cars: withCar(visits), entries })) onClose();
  };
  return (
    <Drawer open onClose={onClose} title={`${miles(milestone.miles)}-mile service${s.cars.length > 1 ? ` · ${r.name}` : ""}`} subtitle={summarize(milestone.items)} width="32rem">
      <div className="flex flex-col gap-4">
        <Field label="Date done">
          <input type="date" className={`${inputCls} w-44`} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Odometer" hint="The next service is counted from here. Also counts as an odometer reading.">
          <NumInput value={odometer} onChange={setOdometer} className="w-40" suffix="mi" />
        </Field>
        <Field label="Where / notes">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Dealer, what was done" />
        </Field>
        {!existing && (
          <Field label="Cost (optional)" hint="Adds a maintenance entry to the log. Leave blank if it's already logged or on a statement.">
            <CentsInput cents={cost} onChange={setCost} className="w-40" />
          </Field>
        )}
        <div className="flex justify-between gap-2 border-t border-line pt-3">
          {existing ? (
            <button type="button" className={btn.danger} disabled={saving} onClick={async () => (await save({ ...s, cars: withCar(car.serviceVisits.filter((v) => v.id !== existing.id)) })) && onClose()}>
              Not done
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={btn.secondary} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={btn.primary} disabled={saving || !date} onClick={() => void submit()}>
              Save
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

function RulesEditor({ rules, months, saving, onClose, onSave }: { rules: ServiceRule[]; months: number; saving: boolean; onClose: () => void; onSave: (r: ServiceRule[], months: number) => void }) {
  const [list, setList] = useState(rules);
  const [m, setM] = useState<number | null>(months);
  const set = (id: string, patch: Partial<ServiceRule>) => setList(list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  return (
    <Drawer open onClose={onClose} title="Service schedule" subtitle="Copy it from the owner's manual: each item and how often (miles). Columns are every shortest interval." width="44rem">
      <div className="flex flex-col gap-3">
        <Field label="Also due every" hint="Months after the last visit, whichever comes first (0 for miles only).">
          <NumInput value={m} onChange={setM} className="w-28" suffix="mo" />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem_auto] items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          <span>Item</span>
          <span>Every (mi)</span>
          <span>First at (mi)</span>
          <span />
        </div>
        {list.map((x) => (
          <div key={x.id} className="grid grid-cols-[minmax(0,1fr)_7rem_7rem_auto] items-center gap-2">
            <input className={inputCls} value={x.item} onChange={(e) => set(x.id, { item: e.target.value })} />
            {x.atMiles?.length ? (
              <input
                className={`${inputCls} col-span-2 text-xs`}
                title="Exact mileages, in thousands"
                defaultValue={x.atMiles.map((v) => v / 1000).join(", ")}
                onBlur={(e) => set(x.id, { atMiles: e.target.value.split(/[,\s]+/).map(Number).filter((v) => v > 0).map((v) => Math.round(v * 1000)) })}
              />
            ) : (
              <>
                <NumInput value={x.everyMiles} onChange={(n) => set(x.id, { everyMiles: n ?? 0 })} />
                <NumInput value={x.firstAtMiles} onChange={(n) => set(x.id, { firstAtMiles: n })} placeholder="same" />
              </>
            )}
            <button type="button" className={btn.ghost} aria-label="Remove" onClick={() => setList(list.filter((y) => y.id !== x.id))}>
              ✕
            </button>
          </div>
        ))}
        <div>
          <button type="button" className={btn.secondary} onClick={() => setList([...list, { id: newId(), item: "", everyMiles: 8000, firstAtMiles: null }])}>
            + Item
          </button>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btn.primary} disabled={saving} onClick={() => onSave(list.filter((x) => x.item.trim() && (x.everyMiles >= 500 || (x.atMiles?.length ?? 0) > 0)), m ?? 0)}>
            Save schedule
          </button>
        </div>
      </div>
    </Drawer>
  );
}
