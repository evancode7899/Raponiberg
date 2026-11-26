"use client";

import type { ResolvedPerson } from "@/lib/profile/basePay";
import type { OutlookPlan } from "@/lib/profile/outlook";
import type { ScenarioRun } from "@/lib/scenarios/engine";
import { personChange, type BuyHome, type PersonChange, type Scenario, type ScenarioModel } from "@/lib/scenarios/types";
import type { ReactNode } from "react";
import { Block, Dollars, Line, money, MonthField, Pct, tiny, Whole } from "./ui";

/**
 * The controls for one scenario: each starts from today's plan (blank = the forecast's
 * figure, shown greyed), and only what's filled in changes anything.
 */

const uid = () => Math.random().toString(36).slice(2, 10);

type Props = {
  s: Scenario;
  onChange: (s: Scenario) => void;
  people: ResolvedPerson[];
  plan: OutlookPlan;
  run: ScenarioRun | null;
  buy: Omit<BuyHome, "at">;
  /** The month after the proven-through date: the earliest a change can start. */
  firstKey: string;
};

export function Editor({ s, onChange, people, plan, run, buy, firstKey }: Props) {
  const set = (patch: Partial<Scenario>) => onChange({ ...s, ...patch });
  const person = (id: string) => s.people.find((c) => c.personId === id) ?? personChange(id);
  const setPerson = (c: PersonChange) => set({ people: [...s.people.filter((x) => x.personId !== c.personId), c] });
  const used = run?.used;

  return (
    <div>
      {people.map((p) => {
        const c = person(p.personId);
        return (
          <Block key={p.personId} title={p.name} right={<span className="num text-[11px] text-faint">{money(p.salary)}/yr today</span>}>
            <Line label="Raise / yr">
              <Pct label={`${p.name}'s yearly raise`} value={c.raise} placeholder={plan.salaryGrowth} onChange={(raise) => setPerson({ ...c, raise })} />
              <span className="ml-2 text-[11px] text-muted">bonus</span>
              <Pct label={`${p.name}'s estimated bonuses, % of today's plan`} value={c.bonusLevel === 1 ? null : c.bonusLevel} placeholder={1} onChange={(v) => setPerson({ ...c, bonusLevel: v ?? 1 })} />
            </Line>
            <Line label="New job" hint="From this month: a new base salary (raises each January after), and its bonus as a % of base (blank: today's bonus, scaled with pay)">
              <MonthField label={`${p.name}: new job from`} value={c.jobChange?.from ?? null} onChange={(from) => setPerson({ ...c, jobChange: from ? { salary: c.jobChange?.salary ?? p.salary, bonusPct: c.jobChange?.bonusPct ?? null, from } : null })} />
              {c.jobChange && (
                <>
                  <Dollars label={`${p.name}: new salary`} plain value={c.jobChange.salary} onChange={(v) => setPerson({ ...c, jobChange: { ...c.jobChange!, salary: v ?? 0 } })} />
                  <Pct label={`${p.name}: new job's bonus, % of salary`} value={c.jobChange.bonusPct} placeholder={p.bonusPct} onChange={(bonusPct) => setPerson({ ...c, jobChange: { ...c.jobChange!, bonusPct } })} />
                </>
              )}
            </Line>
            <Line label="Part-time" hint="From this month: this share of full pay (bonus, retirement saving and benefits scale down with it)">
              <MonthField label={`${p.name}: part-time from`} value={c.partTime?.from ?? null} onChange={(from) => setPerson({ ...c, partTime: from ? { share: c.partTime?.share ?? 0.6, from } : null })} />
              {c.partTime && <Pct label={`${p.name}: share of full pay`} plain value={c.partTime.share} onChange={(v) => setPerson({ ...c, partTime: { ...c.partTime!, share: Math.max(0, Math.min(1, v ?? 0.6)) } })} />}
            </Line>
            <Line label="Stops work" hint="From this month: no pay, bonuses or retirement saving">
              <MonthField label={`${p.name}: stops working from`} value={c.stop?.from ?? null} onChange={(from) => setPerson({ ...c, stop: from ? { endsCare: c.stop?.endsCare ?? true, from } : null })} />
              {c.stop && (
                <label className="flex items-center gap-1 text-[11px] text-fg-2" title="Childcare needed because both adults work stops from the same month (untick if it carries on)">
                  <input type="checkbox" checked={c.stop.endsCare} onChange={(e) => setPerson({ ...c, stop: { ...c.stop!, endsCare: e.target.checked } })} />
                  childcare stops too
                </label>
              )}
            </Line>
          </Block>
        );
      })}

      <Block
        title="Children"
        right={
          <button type="button" className={tiny} onClick={() => set({ children: { ...s.children, added: [...s.children.added, { id: uid(), label: `Child ${s.children.added.length + 1}`, born: addMonths(firstKey, 9) }] } })}>
            + Add a child
          </button>
        }
      >
        {s.children.added.map((c) => (
          <Line key={c.id} label={<input aria-label="Child's label" className="w-full bg-transparent text-[11px] text-fg-2 outline-none" value={c.label} onChange={(e) => set({ children: { ...s.children, added: s.children.added.map((x) => (x.id === c.id ? { ...x, label: e.target.value.slice(0, 40) } : x)) } })} />}>
            <MonthField label={`${c.label}: expected`} value={c.born} onChange={(born) => born && set({ children: { ...s.children, added: s.children.added.map((x) => (x.id === c.id ? { ...x, born } : x)) } })} />
            <button type="button" className={tiny} aria-label={`Remove ${c.label}`} onClick={() => set({ children: { ...s.children, added: s.children.added.filter((x) => x.id !== c.id) } })}>
              ✕
            </button>
          </Line>
        ))}
        <label className="flex items-center gap-1.5 py-[3px] text-[11px] text-fg-2" title="Today's plan keeps today's childcare as it is; tick to have today's children leave care by the age bands below">
          <input type="checkbox" checked={s.children.ageOut} onChange={(e) => set({ children: { ...s.children, ageOut: e.target.checked } })} />
          Today&apos;s children leave care as they grow
        </label>
        {used && (
          <p className="text-[11px] text-muted">
            Care for one child full time: <span className="num text-fg-2">{money(used.carePerChild)}/yr</span> ({used.careFrom === "LEDGER" ? "from your statements" : used.careFrom === "TYPED" ? "typed below" : "a typical figure: type yours below"})
          </p>
        )}
      </Block>

      <Block title="Housing">
        <div className="mb-1 inline-flex rounded border border-line-strong p-0.5" role="radiogroup" aria-label="Rent or buy">
          {(["rent", "buy"] as const).map((m) => {
            const on = m === "buy" ? !!s.housing.buy : !s.housing.buy;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                className={`rounded-[3px] px-2 py-0.5 text-[11px] font-medium ${on ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
                onClick={() => set({ housing: { ...s.housing, buy: m === "buy" ? (s.housing.buy ?? { ...buy, at: addMonths(firstKey, 12) }) : null } })}
              >
                {m === "rent" ? "Keep renting" : "Buy a home"}
              </button>
            );
          })}
        </div>
        <Line label="Rent growth" hint="Yearly rise in rent while renting (blank: like the rest of living cost)">
          <Pct label="Rent growth a year" value={s.housing.rentGrowth} placeholder={plan.livingGrowth} onChange={(rentGrowth) => set({ housing: { ...s.housing, rentGrowth } })} />
          {used && <span className="text-[11px] text-muted">rent + utilities {money(used.rent)}/mo{used.rentFrom === "LEDGER" ? " from statements" : used.rentFrom === "NONE" ? " (none found)" : ""}</span>}
        </Line>
        {s.housing.buy && <BuyFields b={s.housing.buy} inflation={run?.used.inflation ?? plan.inflation} onChange={(b) => set({ housing: { ...s.housing, buy: b } })} />}
      </Block>

      <Block
        title="Spending"
        right={
          <button type="button" className={tiny} onClick={() => set({ spending: { ...s.spending, oneOffs: [...s.spending.oneOffs, { id: uid(), label: "One-off", amount: 10_000_00, at: addMonths(firstKey, 6) }] } })}>
            + One-off
          </button>
        }
      >
        <Line label="Living / yr" hint="Annual living cost in today's dollars (blank: the forecast's)">
          <Dollars label="Annual living cost" value={s.spending.living} placeholder={plan.livingCost} onChange={(living) => set({ spending: { ...s.spending, living } })} />
          <span className="ml-1 text-[11px] text-muted">grows</span>
          <Pct label="Living cost growth a year" value={s.spending.growth} placeholder={plan.livingGrowth} onChange={(growth) => set({ spending: { ...s.spending, growth } })} />
        </Line>
        {s.spending.oneOffs.map((o) => {
          const upd = (patch: Partial<typeof o>) => set({ spending: { ...s.spending, oneOffs: s.spending.oneOffs.map((x) => (x.id === o.id ? { ...x, ...patch } : x)) } });
          return (
            <Line key={o.id} label={<input aria-label="One-off label" className="w-full bg-transparent text-[11px] text-fg-2 outline-none" value={o.label} onChange={(e) => upd({ label: e.target.value.slice(0, 80) })} />}>
              <MonthField label={`${o.label}: month`} value={o.at} onChange={(at) => at && upd({ at })} />
              <Dollars label={`${o.label}: amount`} plain value={o.amount} onChange={(v) => upd({ amount: v ?? 0 })} />
              <button type="button" className={tiny} aria-label={`Remove ${o.label}`} onClick={() => set({ spending: { ...s.spending, oneOffs: s.spending.oneOffs.filter((x) => x.id !== o.id) } })}>
                ✕
              </button>
            </Line>
          );
        })}
      </Block>

      <Block title="Assumptions">
        <Line label="Return / yr" hint="Nominal yearly return on everything invested (blank: the forecast's)">
          <Pct label="Market return a year" value={s.assumptions.returnRate} placeholder={plan.returnRate} onChange={(returnRate) => set({ assumptions: { ...s.assumptions, returnRate } })} />
          <span className="ml-2 text-[11px] text-muted">inflation</span>
          <Pct label="Inflation a year" value={s.assumptions.inflation} placeholder={plan.inflation} onChange={(inflation) => set({ assumptions: { ...s.assumptions, inflation } })} />
        </Line>
      </Block>
    </div>
  );
}

function BuyFields({ b, inflation, onChange }: { b: BuyHome; inflation: number; onChange: (b: BuyHome) => void }) {
  const set = (patch: Partial<BuyHome>) => onChange({ ...b, ...patch });
  const r = (v: number | null, d: number) => v ?? d;
  return (
    <>
      <Line label="Buy in">
        <MonthField label="Purchase month" value={b.at} onChange={(at) => at && set({ at })} />
        <Dollars label="Price" plain value={b.price} onChange={(v) => set({ price: v ?? b.price })} />
      </Line>
      <Line label="Down / closing">
        <Pct label="Down payment, % of price" plain value={b.downPct} onChange={(v) => set({ downPct: r(v, b.downPct) })} />
        <Pct label="Closing costs, % of price" plain value={b.closingPct} onChange={(v) => set({ closingPct: r(v, b.closingPct) })} />
        <span className="num text-[11px] text-muted">{money(Math.round(b.price * (b.downPct + b.closingPct)))} cash</span>
      </Line>
      <Line label="Mortgage">
        <Pct label="Mortgage rate" plain value={b.rate} onChange={(v) => set({ rate: r(v, b.rate) })} />
        <Whole label="Term in years" suffix="yr" value={b.termYears} onChange={(termYears) => set({ termYears: Math.max(1, Math.min(50, termYears)) })} />
      </Line>
      <Line label="Tax / upkeep" hint="Property tax and upkeep, each a % of the home's value a year">
        <Pct label="Property tax, % of value a year" plain value={b.taxRate} onChange={(v) => set({ taxRate: r(v, b.taxRate) })} />
        <Pct label="Upkeep, % of value a year" plain value={b.upkeepRate} onChange={(v) => set({ upkeepRate: r(v, b.upkeepRate) })} />
      </Line>
      <Line label="Insurance / yr">
        <Dollars label="Homeowner's insurance a year" plain value={b.insurance} onChange={(v) => set({ insurance: v ?? 0 })} className="w-[5.5rem]" />
      </Line>
      <Line label="HOA / utilities" hint="A month each">
        <Dollars label="HOA a month" plain value={b.hoa} onChange={(v) => set({ hoa: v ?? 0 })} className="w-[5rem]" />
        <Dollars label="Utilities a month" plain value={b.utilities} onChange={(v) => set({ utilities: v ?? 0 })} className="w-[5rem]" />
      </Line>
      <Line label="Value grows" hint="Yearly change in the home's value (blank: inflation)">
        <Pct label="Home value growth a year" value={b.appreciation} placeholder={inflation} onChange={(appreciation) => set({ appreciation })} />
      </Line>
    </>
  );
}

/** The shared modeling choices (every scenario uses them). */
export function ModelEditor({ model, onChange, run }: { model: ScenarioModel; onChange: (m: ScenarioModel) => void; run: ScenarioRun | null }): ReactNode {
  const set = (patch: Partial<ScenarioModel>) => onChange({ ...model, ...patch });
  return (
    <Block title="Model choices (all scenarios)">
      <Line label="Care / child" hint="Childcare a year for one child in full-time care, in today's dollars (blank: from your statements, else the typical figure)">
        <Dollars label="Childcare a year, one child full time" value={model.carePerChild} placeholder={run?.used.carePerChild ?? model.carePerChildDefault} onChange={(carePerChild) => set({ carePerChild })} />
      </Line>
      {model.careBands.map((b, i) => (
        <Line key={i} label={`Ages ${b.fromAge}–${b.toAge}`} hint="The share of full-time care a child this age needs">
          <Whole label="Band from age" value={b.fromAge} onChange={(fromAge) => set({ careBands: model.careBands.map((x, k) => (k === i ? { ...x, fromAge: Math.max(0, fromAge) } : x)) })} />
          <Whole label="Band to age" value={b.toAge} onChange={(toAge) => set({ careBands: model.careBands.map((x, k) => (k === i ? { ...x, toAge: Math.max(x.fromAge, toAge) } : x)) })} />
          <Pct label="Share of full-time care" plain value={b.share} onChange={(v) => set({ careBands: model.careBands.map((x, k) => (k === i ? { ...x, share: Math.max(0, v ?? x.share) } : x)) })} />
        </Line>
      ))}
      <Line label="Other / child" hint="Other costs of each added child a year (food, clothes, activities), in today's dollars, until this age">
        <Dollars label="Other costs per added child a year" plain value={model.otherPerChild} onChange={(v) => set({ otherPerChild: v ?? 0 })} />
        <span className="text-[11px] text-muted">until</span>
        <Whole label="Other costs until age" value={model.otherUntilAge} onChange={(otherUntilAge) => set({ otherUntilAge: Math.max(0, Math.min(30, otherUntilAge)) })} />
      </Line>
      <Line label="Rent / mo" hint="Rent and utilities a month, what buying replaces (blank: your statements' housing & utilities)">
        <Dollars label="Rent and utilities a month" value={model.rent} placeholder={run?.used.rent ?? null} onChange={(rent) => set({ rent })} />
      </Line>
    </Block>
  );
}

/** `key` (YYYY-MM) plus n months. */
export function addMonths(key: string, n: number): string {
  const t = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
