"use client";

import { btn, Callout, Card, Field, inputCls, Segmented } from "@/components/ui/kit";
import { carName, newId, type Car, type RentParking } from "@/lib/car/settings";
import { useState } from "react";
import type { CarCtx } from "./CarClient";
import { CentsInput, NumInput, usd2 } from "./parts";

type Draft = Pick<Car, "vehicle" | "purchase" | "plan" | "rentParking" | "sale">;

export function SetupTab({ ctx }: { ctx: CarCtx }) {
  const { car: s, settings: g, report: r, saveCar, save, saving } = ctx;
  const pick = (x: Car): Draft => ({ vehicle: x.vehicle, purchase: x.purchase, plan: x.plan, rentParking: x.rentParking, sale: x.sale });
  const [d, setD] = useState<Draft>(() => pick(s));
  // A different (or freshly saved) car resets the draft (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(s);
  if (s !== seen) {
    setSeen(s);
    setD(pick(s));
  }
  const dirty = JSON.stringify(d) !== JSON.stringify(pick(s));
  const v = d.vehicle;
  const p = d.purchase;
  const pl = d.plan;
  const setV = (patch: Partial<Draft["vehicle"]>) => setD({ ...d, vehicle: { ...v, ...patch } });
  const setP = (patch: Partial<Draft["purchase"]>) => setD({ ...d, purchase: { ...p, ...patch } });
  const setPl = (patch: Partial<Draft["plan"]>) => setD({ ...d, plan: { ...pl, ...patch } });
  const setRp = (id: string, patch: Partial<RentParking>) => setD({ ...d, rentParking: d.rentParking.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const allIn = p.priceCents + p.feesCents + p.warrantyCents + p.registrationCents + p.salesTaxCents;
  const own = g.entries.filter((e) => e.carId === s.id).length;
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    const cars = g.cars.filter((c) => c.id !== s.id);
    // Its own entries go with it; statement decisions and keywords naming it go back to the usual choice.
    const rowDecisions = Object.fromEntries(Object.entries(g.rowDecisions).map(([k, x]) => [k, x.carId === s.id ? { ...x, carId: null } : x]));
    const matchRules = g.matchRules.map((m) => (m.carId === s.id ? { ...m, carId: null } : m));
    await save({ ...g, cars, entries: g.entries.filter((e) => e.carId !== s.id), rowDecisions, matchRules, defaultCarId: g.defaultCarId === s.id ? null : g.defaultCarId });
  };

  return (
    <>
      <div className="sticky top-12 z-10 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface/95 px-4 py-2 shadow-[var(--shadow)] backdrop-blur">
        <span className="text-xs text-muted">{dirty ? "Unsaved changes" : `${carName(s, "This car")}: saved. Everything here stays in your database (and its backups).`}</span>
        <div className="flex gap-2">
          <button type="button" className={btn.secondary} disabled={!dirty || saving} onClick={() => setD(pick(s))}>
            Discard
          </button>
          <button type="button" className={btn.primary} disabled={!dirty || saving} onClick={() => void saveCar({ ...s, ...d })}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="The car">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Year">
              <NumInput value={v.year} onChange={(n) => setV({ year: n })} />
            </Field>
            <Field label="Make" hint="Charges from its dealer are suggested as service.">
              <input className={inputCls} value={v.make} onChange={(e) => setV({ make: e.target.value })} />
            </Field>
            <Field label="Model">
              <input className={inputCls} value={v.model} onChange={(e) => setV({ model: e.target.value })} />
            </Field>
            <Field label="Trim">
              <input className={inputCls} value={v.trim} onChange={(e) => setV({ trim: e.target.value })} />
            </Field>
            <Field label="Color">
              <input className={inputCls} value={v.color} onChange={(e) => setV({ color: e.target.value })} />
            </Field>
            <Field label="Nickname" hint="Optional.">
              <input className={inputCls} value={v.name} onChange={(e) => setV({ name: e.target.value })} />
            </Field>
            <Field label="VIN" className="col-span-2">
              <input className={`${inputCls} font-mono`} value={v.vin} onChange={(e) => setV({ vin: e.target.value.toUpperCase() })} maxLength={17} />
            </Field>
            <Field label="Gas tank" hint="For range.">
              <NumInput value={v.tankGallons} onChange={(n) => setV({ tankGallons: n })} suffix="gal" />
            </Field>
          </div>
        </Card>

        <Card title="Ownership">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bought on" hint="Costs, statements and per-mile figures start here.">
              <input type="date" className={inputCls} value={v.purchaseDate ?? ""} onChange={(e) => setV({ purchaseDate: e.target.value || null })} />
            </Field>
            <Field label="Odometer when bought">
              <NumInput value={v.purchaseOdometer} onChange={(n) => setV({ purchaseOdometer: n })} suffix="mi" />
            </Field>
            <Field label="In service since" hint="The car's first sale; the factory warranty clock starts here.">
              <input type="date" className={inputCls} value={v.inServiceDate ?? ""} onChange={(e) => setV({ inServiceDate: e.target.value || null })} />
            </Field>
            <div />
            <Field label="Warranty years">
              <NumInput value={pl.warrantyYears} onChange={(n) => setPl({ warrantyYears: n ?? 0 })} suffix="yr" />
            </Field>
            <Field label="Warranty miles">
              <NumInput value={pl.warrantyMiles} onChange={(n) => setPl({ warrantyMiles: n ?? 0 })} suffix="mi" />
            </Field>
          </div>
        </Card>

        <Card title="Purchase" subtitle={`All-in: ${usd2(allIn)}. Depreciation starts from this.`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Vehicle price">
              <CentsInput cents={p.priceCents} onChange={(c) => setP({ priceCents: c ?? 0 })} />
            </Field>
            <Field label="Dealer fees">
              <CentsInput cents={p.feesCents} onChange={(c) => setP({ feesCents: c ?? 0 })} />
            </Field>
            <Field label="Extended warranty">
              <CentsInput cents={p.warrantyCents} onChange={(c) => setP({ warrantyCents: c ?? 0 })} />
            </Field>
            <Field label="Registration">
              <CentsInput cents={p.registrationCents} onChange={(c) => setP({ registrationCents: c ?? 0 })} />
            </Field>
            <Field label="Sales tax">
              <CentsInput cents={p.salesTaxCents} onChange={(c) => setP({ salesTaxCents: c ?? 0 })} />
            </Field>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-3">
            <Field label="Down payment">
              <CentsInput cents={p.downPaymentCents} onChange={(c) => setP({ downPaymentCents: c ?? 0 })} />
            </Field>
            <Field label="Total loan interest" hint="Spread from purchase to payoff.">
              <CentsInput cents={p.interestCents} onChange={(c) => setP({ interestCents: c ?? 0 })} />
            </Field>
            <Field label="Loan paid off" hint="Blank if paid in cash or still paying.">
              <input type="date" className={inputCls} value={p.loanPaidOffDate ?? ""} onChange={(e) => setP({ loanPaidOffDate: e.target.value || null })} />
            </Field>
          </div>
        </Card>

        <Card title="Depreciation plan" subtitle="Planned depreciation spreads the all-in price, less what you expect to sell it for, evenly over the miles until then.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sell at odometer">
              <NumInput value={pl.sellAtMiles} onChange={(n) => setPl({ sellAtMiles: n ?? 0 })} suffix="mi" />
            </Field>
            <Field label="Expected resale then">
              <CentsInput cents={pl.residualCents} onChange={(c) => setPl({ residualCents: c ?? 0 })} />
            </Field>
            <Field label="Headline depreciation" className="col-span-2" hint={r.values.latest ? undefined : "Market needs at least one value check (Value tab)."}>
              <Segmented
                value={pl.depreciation}
                onChange={(x) => setPl({ depreciation: x })}
                options={[
                  { value: "PLANNED", label: "Planned (per mile)" },
                  { value: "MARKET", label: "Market value" },
                ]}
              />
            </Field>
          </div>
        </Card>
      </div>

      <Card
        title="Parking paid in the rent"
        subtitle="When parking comes with the apartment, the statements only show the rent. Say what the spot costs a month and it's counted as parking every month, except months already paid another way (a prepaid stretch in your log, a parking charge on a statement)."
      >
        <div className="flex flex-col gap-2">
          {d.rentParking.map((x) => (
            <div key={x.id} className="flex flex-wrap items-end gap-3">
              <Field label="From month">
                <input type="month" className={inputCls} value={x.fromMonth} onChange={(e) => setRp(x.id, { fromMonth: e.target.value })} />
              </Field>
              <Field label="Through month" hint="Blank: still paying.">
                <input type="month" className={inputCls} value={x.toMonth ?? ""} onChange={(e) => setRp(x.id, { toMonth: e.target.value || null })} />
              </Field>
              <Field label="Per month">
                <CentsInput cents={x.monthlyCents} onChange={(c) => setRp(x.id, { monthlyCents: c ?? 0 })} className="w-32" />
              </Field>
              <button type="button" className={btn.ghost} onClick={() => setD({ ...d, rentParking: d.rentParking.filter((y) => y.id !== x.id) })} aria-label="Remove">
                ✕
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className={btn.secondary}
              onClick={() => setD({ ...d, rentParking: [...d.rentParking, { id: newId(), fromMonth: (v.purchaseDate ?? r.today).slice(0, 7), toMonth: null, monthlyCents: 17_500 }] })}
            >
              + Parking in rent
            </button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Sold" subtitle="When the car goes, say when and for how much. Its figures stop there, depreciation becomes what it really lost, and statement charges after that go to your other cars.">
          {d.sale ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Sold on">
                <input type="date" className={inputCls} value={d.sale.date} onChange={(e) => e.target.value && setD({ ...d, sale: { ...d.sale!, date: e.target.value } })} />
              </Field>
              <Field label="Odometer then">
                <NumInput value={d.sale.odometer} onChange={(n) => setD({ ...d, sale: { ...d.sale!, odometer: n } })} suffix="mi" className="w-36" />
              </Field>
              <Field label="Sold for">
                <CentsInput cents={d.sale.priceCents} onChange={(c) => setD({ ...d, sale: { ...d.sale!, priceCents: c ?? 0 } })} className="w-36" />
              </Field>
              <button type="button" className={btn.ghost} onClick={() => setD({ ...d, sale: null })}>
                Not sold
              </button>
            </div>
          ) : (
            <button type="button" className={btn.secondary} onClick={() => setD({ ...d, sale: { date: r.today, odometer: r.odometer.current, priceCents: r.depreciation.marketValueNow ?? 0 } })}>
              Mark as sold
            </button>
          )}
        </Card>

        <Card title="Remove this car" subtitle="For a car added by mistake. A car you've sold should be marked sold instead, so its history stays in the totals.">
          {removing ? (
            <Callout
              tone="bad"
              title={`Remove ${carName(s, "this car")}?`}
              action={
                <div className="flex gap-2">
                  <button type="button" className={btn.secondary} onClick={() => setRemoving(false)}>
                    Keep it
                  </button>
                  <button type="button" className={btn.danger} disabled={saving} onClick={() => void remove()}>
                    Remove
                  </button>
                </div>
              }
            >
              Its details and its {own} log entr{own === 1 ? "y" : "ies"} are deleted. Shared entries stay with the other cars.
            </Callout>
          ) : (
            <button type="button" className={btn.danger} onClick={() => setRemoving(true)}>
              Remove car…
            </button>
          )}
        </Card>
      </div>
    </>
  );
}
