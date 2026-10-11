"use client";

import { btn, Callout, Drawer, Field, inputCls, selectCls } from "@/components/ui/kit";
import type { HintMatch } from "@/lib/car/detect";
import { CAR_KINDS, carName, KIND_INFO, newId, ownedOn, SHARED, type Car, type CarEntry, type CarKind } from "@/lib/car/settings";
import { useState } from "react";
import { CentsInput, fmtDate, NumInput, usd2 } from "./parts";

/** What the quick-log buttons start: a fill-up, any other cost, or just an odometer reading. */
export type LogMode = "FUEL" | "COST" | "ODOMETER";

/** An odometer reading on its own: a zero-cost entry that only carries the reading. */
export const isReading = (e: Pick<CarEntry, "cents" | "kind">) => e.cents === 0 && e.kind === "OTHER";

export function blankEntry(mode: LogMode, carId: string, today: string): CarEntry {
  const kind: CarKind = mode === "FUEL" ? "FUEL" : "OTHER";
  return {
    id: newId(),
    carId,
    date: today,
    kind,
    item: mode === "FUEL" ? "Gas" : mode === "ODOMETER" ? "Odometer reading" : "",
    note: "",
    cents: 0,
    gallons: null,
    odometer: null,
    partial: false,
    months: KIND_INFO[kind].months,
    links: [],
    rejected: [],
    offStatement: false,
  };
}

/** The cars an entry on a day can go to: those owned then (else every car), plus Shared when it's not fuel. */
function carChoices(cars: Car[], day: string, fuel: boolean) {
  const owned = cars.filter((c) => ownedOn(c, day));
  const list = (owned.length ? owned : cars).map((c) => ({ id: c.id, label: carName(c) }));
  return fuel || cars.length < 2 ? list : [...list, { id: SHARED, label: "Shared — split between the cars" }];
}

export function EntryEditor({
  entry,
  match,
  cars,
  isNew,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  entry: CarEntry;
  /** What the entry matched on the statements, as last saved (null: new). */
  match: HintMatch | null;
  cars: Car[];
  isNew: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (e: CarEntry) => void;
  onDelete: () => void;
}) {
  const [e, setE] = useState(entry);
  const reading = isReading(e) && e.item === "Odometer reading";
  const fuel = e.kind === "FUEL";
  const choices = carChoices(cars, e.date, fuel);
  const carOk = choices.some((c) => c.id === e.carId);
  const title = isNew ? (reading ? "Odometer reading" : fuel ? "New fill-up" : "New cost") : reading ? "Odometer reading" : `Edit ${entry.item}`;
  const ready = !!e.date && carOk && (!reading || e.odometer != null);

  return (
    <Drawer open onClose={onClose} title={title} subtitle={e.links.length ? "Tied to the statement charge you picked: it counts once, at the statement's amount." : reading ? "A reading keeps miles driven, cost per mile and the service schedule current." : undefined} width="34rem">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" className={inputCls} value={e.date} onChange={(x) => setE({ ...e, date: x.target.value })} />
          </Field>
          {cars.length > 1 && (
            <Field label="Car">
              <select className={selectCls} value={carOk ? e.carId : ""} onChange={(x) => setE({ ...e, carId: x.target.value })}>
                {!carOk && <option value="">Pick a car</option>}
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {reading ? (
          <Field label="Odometer">
            <NumInput value={e.odometer} onChange={(n) => setE({ ...e, odometer: n })} suffix="mi" className="w-44" />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Kind">
                <select
                  className={selectCls}
                  value={e.kind}
                  onChange={(x) => {
                    const k = x.target.value as CarKind;
                    setE({ ...e, kind: k, months: KIND_INFO[k].months, gallons: k === "FUEL" ? e.gallons : null, partial: k === "FUEL" && e.partial, carId: k === "FUEL" && e.carId === SHARED ? "" : e.carId });
                  }}
                >
                  {CAR_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_INFO[k].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Item">
                <input className={inputCls} value={e.item} onChange={(x) => setE({ ...e, item: x.target.value })} placeholder={KIND_INFO[e.kind].label} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cost" hint="As you logged it; the statement charge it matches is what counts.">
                <CentsInput cents={e.cents} onChange={(c) => setE({ ...e, cents: c ?? 0 })} />
              </Field>
              <Field label="Odometer" hint={fuel ? "At the pump: gives MPG." : "Optional; any reading helps the per-mile figures."}>
                <NumInput value={e.odometer} onChange={(n) => setE({ ...e, odometer: n })} suffix="mi" />
              </Field>
            </div>
            {fuel ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Gallons">
                  <NumInput value={e.gallons} onChange={(n) => setE({ ...e, gallons: n })} step={0.001} suffix="gal" />
                </Field>
                <label className="mt-5 flex items-center gap-2 text-xs text-fg">
                  <input type="checkbox" checked={e.partial} onChange={(x) => setE({ ...e, partial: x.target.checked })} /> Didn&apos;t fill to full
                </label>
              </div>
            ) : (
              <Field label="Covers" hint="Months it pays for (a 6-month premium, a year of parking or car tax). Spread evenly in the monthly figures.">
                <NumInput value={e.months} onChange={(n) => setE({ ...e, months: Math.max(1, Math.round(n ?? 1)) })} className="w-28" suffix="mo" />
              </Field>
            )}
          </>
        )}
        <Field label="Note">
          <input className={inputCls} value={e.note} onChange={(x) => setE({ ...e, note: x.target.value })} />
        </Field>
        {!reading && e.cents !== 0 && <StatementMatch match={isNew ? null : match} entry={e} onChange={setE} />}
        {e.carId === SHARED && <Callout tone="info">Split evenly between the cars you owned on {e.date || "that day"} — for one bill that covers them all (a multi-car policy, a parking permit).</Callout>}
        {e.kind === "PAYMENT" && <Callout tone="info">Car payments pay for the purchase, which already counts through depreciation and interest, so they&apos;re cash out the door but not a separate cost.</Callout>}
        <div className="flex justify-between gap-2 border-t border-line pt-3">
          {!isNew ? (
            <button type="button" className={btn.danger} disabled={saving} onClick={onDelete}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={btn.secondary} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={btn.primary} disabled={saving || !ready} onClick={() => onSave({ ...e, item: e.item.trim() || KIND_INFO[e.kind].label })}>
              Save
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

/**
 * Which statement charge the entry is, and the one switch that lets an entry's own amount
 * count: paid outside the statements. Without it an entry with no charge counts nothing.
 */
function StatementMatch({ match: m, entry: e, onChange }: { match: HintMatch | null; entry: CarEntry; onChange: (e: CarEntry) => void }) {
  const rows = m?.rows ?? [];
  const off = (
    <label className="mt-2 flex items-start gap-2 text-xs text-fg">
      <input type="checkbox" className="mt-0.5" checked={e.offStatement} onChange={(x) => onChange({ ...e, offStatement: x.target.checked })} />
      <span>
        Paid outside my statements (cash, or an account the app doesn&apos;t have) — count the {usd2(e.cents)} I logged.
        <span className="block text-muted">Only for money that will never show up on a statement; otherwise it would count twice once it does.</span>
      </span>
    </label>
  );
  if (e.offStatement) return <Callout tone="info" title="Counted from your log">{off}</Callout>;
  if (!m) return <Callout tone="info">Once saved, it&apos;s matched to its charge on your statements, and the statement&apos;s amount is what counts. {off}</Callout>;
  if (m.status === "MATCHED" || m.status === "INSTALLMENTS")
    return (
      <Callout tone={m.confidence === "check" ? "warn" : "good"} title={m.status === "MATCHED" ? "On your statements as" : "Paid monthly"}>
        <ul className="flex flex-col gap-0.5">
          {rows.map((r) => (
            <li key={r.rowId} className="flex justify-between gap-3">
              <span className="truncate font-mono text-[11px]" title={r.payee}>
                {fmtDate(r.date)} · {r.payee}
              </span>
              <span className="num shrink-0">{usd2(r.cents)}</span>
            </li>
          ))}
        </ul>
        {m.note && <p className="mt-1 text-muted">{m.note}</p>}
        {m.with.length > 0 && <p className="mt-1 text-muted">The same payment covers {m.with.length} other log {m.with.length === 1 ? "entry" : "entries"}.</p>}
        <p className="mt-1 text-muted">To pick a different charge, use Car › From statements.</p>
      </Callout>
    );
  return (
    <Callout tone={m.status === "AWAITING" ? "info" : "warn"} title={m.status === "AWAITING" ? "Waiting for its statement" : "Not on your statements — counts nothing"}>
      {m.note}
      {off}
    </Callout>
  );
}
