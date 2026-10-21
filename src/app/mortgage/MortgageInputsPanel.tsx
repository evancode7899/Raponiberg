"use client";

import { Group } from "@/app/home-budget/parts";
import { fmtValue, RangeSlider } from "@/app/home-budget/RangeSlider";
import { LINKED_KEYS, type LinkedKey } from "@/lib/mortgage/inputs";
import type { MortgageLinks } from "./MortgageClient";
import { btn, Card, MoneyInput, Segmented, selectCls } from "@/components/ui/kit";
import { formatUsd } from "@/lib/formatMoney";
import type { ReactNode } from "react";
import { defaultInputs, fromHomeBudget, MONTHS, SPECS, type LumpRow, type MortgageInputs } from "./inputs";

const DEF = defaultInputs();

type NumKey = { [K in keyof MortgageInputs]: MortgageInputs[K] extends number ? K : never }[keyof MortgageInputs] & keyof typeof SPECS;

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
}

function Toggle<T extends string>({ label, hint, value, options, onChange }: { label: string; hint?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <span title={hint} className={`text-xs font-medium text-fg-2 ${hint ? "cursor-help underline decoration-line-strong decoration-dotted underline-offset-2" : ""}`}>
        {label}
      </span>
      <Segmented size="xs" ariaLabel={label} options={options} value={value} onChange={onChange} />
    </div>
  );
}

export function MortgageInputsPanel({
  ins,
  typed,
  links,
  set,
  payment,
  onReset,
}: {
  /** The inputs as the model runs them (linked figures put in). */
  ins: MortgageInputs;
  /** Linked inputs the owner typed over. */
  typed: Partial<Record<LinkedKey, true>>;
  links: MortgageLinks;
  set: (p: Partial<MortgageInputs>) => void;
  payment: number;
  onReset: () => void;
}) {
  const isLinked = (k: NumKey): k is LinkedKey => (LINKED_KEYS as readonly string[]).includes(k);
  /** Where a linked input comes from, or (typed) what the linked figure is, with a way back to it. */
  const linkNote = (k: NumKey): ReactNode => {
    if (!isLinked(k)) return null;
    const l = links[k];
    if (!l) return null;
    const shown = fmtValue(l.value, SPECS[k].unit, "digits" in SPECS[k] ? (SPECS[k] as { digits: number }).digits : 1);
    if (!typed[k]) return <span>Linked: {l.from} ({shown}).</span>;
    return (
      <span>
        Typed (an assumption). {l.from}: {shown}.{" "}
        <button type="button" className="font-medium text-accent hover:underline" onClick={() => set({ typed: { ...typed, [k]: undefined } })}>
          Use it
        </button>
      </span>
    );
  };
  const S = (k: NumKey, label: string, hint?: string, extra?: ReactNode, disabled?: boolean) => (
    <RangeSlider
      label={label}
      hint={hint}
      spec={SPECS[k]}
      value={ins[k]}
      defaultValue={DEF[k]}
      onChange={(v) => set({ [k]: v, ...(isLinked(k) && links[k] ? { typed: { ...typed, [k]: true } } : {}) })}
      extra={extra || isLinked(k) ? <>{extra}{extra && linkNote(k) ? " " : null}{linkNote(k)}</> : undefined}
      disabled={disabled}
    />
  );
  const setRow = (id: string, p: Partial<LumpRow>) => set({ lumps: ins.lumps.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  const addRow = () => {
    const year = ins.startYear + 1;
    set({ lumps: [...ins.lumps, { id: newId(), label: "", month: ins.startMonth, year, amount: 50_000, repeat: false, untilYear: year + 4 }] });
  };
  const homeBudget = () => {
    void fromHomeBudget().then((h) => {
      if (h) set(h);
    });
  };
  const taxable = ins.account === "taxable";

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-14 lg:max-h-[calc(100vh-4.5rem)] lg:self-start lg:overflow-y-auto">
      <Card
        title="The loan"
        subtitle={`Principal & interest ${formatUsd(payment)} a month.`}
        actions={
          <button type="button" className={btn.ghost} onClick={homeBudget} title="Loan amount, rate, term, return and property tax from the Home budget page's Test a price scenario">
            Use home budget
          </button>
        }
      >
        {S("principal", "Loan amount", "The balance the payment is sized for.")}
        {S("rate", "Interest rate")}
        {S("termYears", "Term")}
        <div className="flex items-center justify-between gap-2 py-2">
          <span className="text-xs font-medium text-fg-2">First payment</span>
          <div className="flex gap-1">
            <select aria-label="First payment month" className={selectCls} value={ins.startMonth} onChange={(e) => set({ startMonth: Number(e.target.value) })}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
            <input
              aria-label="First payment year"
              type="number"
              className={`${selectCls} num w-20`}
              value={ins.startYear}
              min={1990}
              max={2100}
              onChange={(e) => Number.isFinite(Number(e.target.value)) && set({ startYear: Math.round(Number(e.target.value)) })}
            />
          </div>
        </div>
      </Card>

      <Card title="Money you could send to the loan" subtitle="Every scenario spends this same cash; the only question is whether it goes to the loan or gets invested.">
        {S("extraMonthly", "Extra each month", "On top of the scheduled payment.")}
        <div className="pt-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-2">Lump sums</span>
            <button type="button" className={btn.link} onClick={addRow}>
              + Add
            </button>
          </div>
          {ins.lumps.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted">None — add a bonus, an inheritance or a sale to see what prepaying with it costs.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {ins.lumps.map((r) => (
                <li key={r.id} className="rounded-md border border-line bg-surface-2 p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      aria-label="Lump name"
                      placeholder="Name (bonus, RSUs…)"
                      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-fg outline-none placeholder:text-faint hover:border-line-strong focus:border-accent"
                      value={r.label}
                      onChange={(e) => setRow(r.id, { label: e.target.value })}
                    />
                    <button type="button" aria-label="Remove lump" onClick={() => set({ lumps: ins.lumps.filter((x) => x.id !== r.id) })} className="rounded px-1.5 text-sm text-faint hover:bg-surface-3 hover:text-neg">
                      ×
                    </button>
                  </div>
                  <div className="mt-1.5 grid grid-cols-[auto_4.5rem_minmax(0,1fr)] items-center gap-1.5">
                    <select aria-label="Month" className={`${selectCls} py-1`} value={r.month} onChange={(e) => setRow(r.id, { month: Number(e.target.value) })}>
                      {MONTHS.map((m, i) => (
                        <option key={m} value={i + 1}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Year"
                      type="number"
                      className={`${selectCls} num py-1`}
                      value={r.year}
                      onChange={(e) => {
                        const y = Math.round(Number(e.target.value));
                        if (Number.isFinite(y)) setRow(r.id, { year: y, untilYear: Math.max(y, r.untilYear) });
                      }}
                    />
                    <MoneyInput size="xs" ariaLabel="Amount" allowNegative={false} cents={Math.round(r.amount * 100)} onChange={(c) => setRow(r.id, { amount: Math.max(0, (c ?? 0) / 100) })} />
                  </div>
                  <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-fg-2">
                    <input type="checkbox" checked={r.repeat} onChange={(e) => setRow(r.id, { repeat: e.target.checked })} />
                    Every year through
                    <input
                      aria-label="Repeat until year"
                      type="number"
                      disabled={!r.repeat}
                      className={`${selectCls} num w-[4.5rem] py-0.5 disabled:opacity-40`}
                      value={r.untilYear}
                      onChange={(e) => {
                        const y = Math.round(Number(e.target.value));
                        if (Number.isFinite(y)) setRow(r.id, { untilYear: y });
                      }}
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card title="Investing instead">
        <Group title="Markets">
          {S("investReturn", "Expected return / year", "Compound annual total return before tax. The median market path in the simulation earns this.")}
          {S("volatility", "Volatility", "Standard deviation of annual returns: ~16% for a stock index, ~10% for 60/40. Drives the range of outcomes, not the expected line.")}
          {S("horizonYears", "Compare after", "When you'd sell or stop: both paths are valued at this point. Past the loan's term, both keep investing the full payment.")}
        </Group>
        <Group title="Account">
          <Toggle
            label="Account type"
            hint="Taxable brokerage, or a tax-free account (Roth, or room in a 401(k) you'd otherwise leave unused)."
            value={ins.account}
            options={[
              { value: "taxable", label: "Taxable" },
              { value: "taxFree", label: "Tax-free" },
            ]}
            onChange={(v) => set({ account: v })}
          />
          {S("fedGainsRate", "Federal tax on dividends & gains", "Qualified dividends and long-term gains: 20% at the top (15% below ~$614k joint) + 3.8% NIIT above $250k joint.", undefined, !taxable)}
          {S("ctGainsRate", "Connecticut tax on dividends & gains", "Connecticut taxes dividends and gains as ordinary income: 6.99% at the top. Set 0 for a state without income tax.", undefined, !taxable)}
          {S("dividendYield", "Dividend yield", "Taxed every year as paid; the rest of the return is unrealized gain, taxed only when sold.", undefined, !taxable)}
          <Toggle
            label="Value investments"
            hint="Net of the capital-gains tax if sold at the end (honest for spending the money), or before it (held for life and stepped up)."
            value={ins.sellAtHorizon ? "sold" : "held"}
            options={[
              { value: "sold", label: "After tax if sold" },
              { value: "held", label: "Held" },
            ]}
            onChange={(v) => set({ sellAtHorizon: v === "sold" })}
          />
        </Group>
      </Card>

      <Card title="Mortgage-interest deduction" subtitle="It lowers what the loan really costs — but only by the part of your itemized deductions above the standard deduction.">
        <Toggle
          label="Deduct interest"
          value={ins.deductInterest ? "yes" : "no"}
          options={[
            { value: "yes", label: "Itemize" },
            { value: "no", label: "Standard" },
          ]}
          onChange={(v) => set({ deductInterest: v === "yes" })}
        />
        {ins.deductInterest && (
          <>
            {S("fedMarginalRate", "Federal marginal rate", "The rate each deducted dollar saves. Connecticut has no itemized deductions, so the deduction saves no state tax.")}
            {S("standardDeduction", "Standard deduction", "2026: $32,200 joint, $16,100 single. Grows with inflation here.")}
            {S("stateIncomeTax", "State income tax a year", "Deductible as SALT together with property tax, capped at $40,400 through 2029 and $10,000 from 2030.")}
            {S("propertyTax", "Property tax a year", "On this home, in the first payment's year; SALT, so it shares the cap. Use home budget fills it from the price and tax rate.")}
            {S("charity", "Charity a year", "Itemized outside the SALT cap.")}
            <Toggle
              label="Deductible debt cap"
              hint="Interest on the balance above this isn't deductible."
              value={String(ins.debtCap)}
              options={[
                { value: "750000", label: "$750k" },
                { value: "375000", label: "$375k MFS" },
                { value: "1000000", label: "$1M pre-2018" },
              ]}
              onChange={(v) => set({ debtCap: Number(v) })}
            />
          </>
        )}
      </Card>

      <Card title="Display">
        <Toggle
          label="Dollars"
          hint="Today's dollars divide each year's figures by inflation since the first payment."
          value={ins.realDollars ? "real" : "nominal"}
          options={[
            { value: "nominal", label: "Future $" },
            { value: "real", label: "Today's $" },
          ]}
          onChange={(v) => set({ realDollars: v === "real" })}
        />
        {S("inflation", "Inflation", "For today's dollars and the standard deduction's growth.")}
        <div className="flex justify-end pt-2">
          <button type="button" className={btn.ghost} onClick={onReset}>
            Reset all inputs
          </button>
        </div>
      </Card>
    </div>
  );
}
