"use client";

import { BlockedNote } from "@/components/ledger/Blocked";
import { btn, Loading, NotFigure, Segmented, usePersistentState, WhatIf } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofRef } from "@/components/ui/proof/context";
import { formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import { defaultHomeBudgetInputs, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import Link from "next/link";
import type { ReactNode } from "react";
import type { FundsState, Patch } from "./HomeBudgetClient";
import { Row } from "./parts";
import { fmtValue, RangeSlider, type SliderSpec } from "./RangeSlider";
import { FUNDS_SHARE_SPEC, spec } from "./specs";

const DEF = defaultHomeBudgetInputs();
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d).replace(/\.0+$/, "")}%`;
const kUsd = (v: number) => fmtValue(v, "usd");
const short = (v: number) => (Math.abs(v) >= 1_000_000 ? `$${+(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}k`);
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const LABELS: Partial<Record<keyof HomeBudgetInputs, string>> = {
  annualHouseholdSalary: "Household salary",
  housingCostMaxOfGross: "Housing limit (% of gross)",
  incomeTaxRate: "Income tax rate",
  minimumMonthlySavings: "Savings target / month",
  annualMortgageRate: "Interest rate",
  annualMortgageInsuranceRateOnLoan: "Mortgage insurance (% of loan)",
  annualPropertyTaxRate: "Property tax",
  annualInsuranceRateOnValue: "Home insurance",
  annualMaintenanceRate: "Maintenance",
  utilitiesMonthly: "Utilities / month",
  hoaMonthly: "HOA / month",
  closingCostsPctOfHomePrice: "Closing costs",
  renovationPctOfHomePrice: "Renovation / furnishing",
  budgetDownPaymentPct: "Down payment",
  capitalGainsTaxRate: "Capital gains tax",
};

type SectionId = "home" | "you" | "cash" | "mortgage" | "running" | "oneTime";
type OpenState = Record<SectionId, boolean>;
const defaultOpen = (): OpenState => ({ home: true, you: true, cash: false, mortgage: false, running: false, oneTime: false });

/**
 * Every input on one sticky, scrollable panel. Sections fold to a one-line summary so the
 * whole picture fits on screen; the results beside it update as anything moves.
 */
export function InputsPanel({
  ins,
  patch,
  funds,
  focus,
  home,
  onReset,
}: {
  ins: HomeBudgetInputs;
  patch: Patch;
  funds: FundsState;
  /** The price (and loan) the dollar hints are figured at: the max, or the target home. */
  focus: { price: number; loan: number; label: string };
  /** Target-home controls, on the price tab only. */
  home?: { priceSpec: SliderSpec; markers: { value: number; label: string }[]; allCashDownPct: number };
  onReset: () => void;
}) {
  const [open, setOpen] = usePersistentState<OpenState>("pf-home-budget-open", defaultOpen);
  const toggle = (id: SectionId) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const S = (k: keyof HomeBudgetInputs, extra?: Partial<Parameters<typeof RangeSlider>[0]>) => {
    const sp = spec(k);
    return (
      <RangeSlider
        compact
        key={k}
        label={LABELS[k] ?? k}
        hint={sp.hint}
        spec={sp}
        value={ins[k] as number}
        defaultValue={DEF[k] as number}
        onChange={(v) => patch(k, v as never)}
        {...extra}
      />
    );
  };
  const perMonth = (rate: number) => (
    <WhatIf inline why="a cost at the price you're looking at">
      = {formatUsd((focus.price * rate) / 12)}/mo at {focus.label}
    </WhatIf>
  );
  /** A section's one-line summary of inputs you typed. */
  const typedSummary = (s: string) => <NotFigure why="your inputs">{s}</NotFigure>;
  const savingsSpec = { ...spec("minimumMonthlySavings"), band: [Math.round((ins.annualHouseholdSalary / 12) * 0.05 / 100) * 100, Math.round((ins.annualHouseholdSalary / 12) * 0.15 / 100) * 100] as [number, number] };
  const loan = ins.budgetHomePrice * (1 - ins.budgetDownPaymentPct);

  return (
    <aside className="app-scroll order-last min-w-0 rounded-lg lg:order-first border border-line bg-surface shadow-[var(--shadow)] lg:sticky lg:top-14 lg:max-h-[calc(100dvh-4.5rem)] lg:overflow-y-auto">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-[13px] font-semibold text-fg">Inputs</span>
        <button type="button" className={`${btn.ghost} !px-2 !py-0.5 text-[11px]`} onClick={onReset} title="Every input back to its default, cash linked to net worth again">
          Reset all
        </button>
      </div>

      {home && (
        <Section id="home" title="Target home" open={open.home} onToggle={toggle} summary={typedSummary(`${short(ins.budgetHomePrice)} · ${pct(ins.budgetDownPaymentPct)} down`)} highlight>
          <RangeSlider
            compact
            label="Home price"
            spec={home.priceSpec}
            value={ins.budgetHomePrice}
            defaultValue={DEF.budgetHomePrice}
            markers={home.markers}
            onChange={(v) => patch("budgetHomePrice", Math.round(v))}
            hint="Type a number (e.g. 950k) or drag. Ticks mark your affordability tiers."
          />
          {S("budgetDownPaymentPct", {
            markers: home.allCashDownPct > 0 ? [{ value: home.allCashDownPct, label: "All your cash" }] : [],
            extra: (
              <>
                <WhatIf inline why="the target home you typed">
                  = {formatUsd(ins.budgetHomePrice * ins.budgetDownPaymentPct)} · loan {formatUsd(loan)}
                {home.allCashDownPct > 0 && Math.abs(home.allCashDownPct - ins.budgetDownPaymentPct) > 0.0025 && (
                  <button type="button" className="ml-1.5 text-accent hover:underline" onClick={() => patch("budgetDownPaymentPct", Math.floor(home.allCashDownPct * 200) / 200)}>
                    use all your cash ({pct(Math.floor(home.allCashDownPct * 200) / 200)})
                  </button>
                )}
                </WhatIf>
              </>
            ),
          })}
        </Section>
      )}

      <Section id="you" title="You" open={open.you} onToggle={toggle} summary={
          <>
            {funds.buy.salaryLinked ? <ProofValue proof={funds.proof("salary", ins.annualHouseholdSalary)}>{short(ins.annualHouseholdSalary)}</ProofValue> : typedSummary(short(ins.annualHouseholdSalary))} · limit{" "}
            {typedSummary(pct(ins.housingCostMaxOfGross))}
          </>
        }
      >
        {funds.buy.salaryLinked ? (
          <div className="py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-fg-2">{LABELS.annualHouseholdSalary}</span>
              <span className="num text-sm font-semibold text-fg">
                <ProofValue proof={funds.proof("salary", ins.annualHouseholdSalary)}>{formatUsd(ins.annualHouseholdSalary)}</ProofValue>
              </span>
            </div>
            <p className="text-[11px] leading-snug text-faint">
              Base pay in {funds.buy.year}, from the{" "}
              <Link href="/forecast" className="underline hover:text-fg">
                Forecast
              </Link>
              .{" "}
              <button type="button" className="text-accent hover:underline" onClick={() => { patch("annualHouseholdSalary", Math.round(ins.annualHouseholdSalary / 1000) * 1000); funds.setConfig({ ...funds.config, salary: "manual" }); }}>
                Type my own
              </button>
            </p>
          </div>
        ) : (
          S("annualHouseholdSalary", funds.buy.salary != null ? { extra: <button type="button" className="text-accent hover:underline" onClick={() => funds.setConfig({ ...funds.config, salary: "forecast" })}>use the Forecast ({formatUsd(funds.buy.salary)} in {funds.buy.year})</button> } : {})
        )}
        {S("housingCostMaxOfGross")}
        {funds.tax.income.linked ? (
          <EngineRate
            label={LABELS.incomeTaxRate!}
            value={ins.incomeTaxRate}
            proof={funds.proof("income-tax", null)}
            note={
              <>
                Federal + Connecticut income tax and payroll on <ProofValue proof={funds.proof("salary", ins.annualHouseholdSalary)}>{formatUsd(ins.annualHouseholdSalary)}</ProofValue> of wages,{" "}
                {funds.tax.year} law, from the tax engine.
              </>
            }
            onManual={() => {
              patch("incomeTaxRate", Math.round(ins.incomeTaxRate * 200) / 200);
              funds.setConfig({ ...funds.config, incomeTax: "manual" });
            }}
          />
        ) : (
          S("incomeTaxRate", funds.tax.income.engine != null ? { extra: <EngineLink rate={funds.tax.income.engine} onClick={() => funds.setConfig({ ...funds.config, incomeTax: "engine" })} /> } : {})
        )}
        <RangeSlider compact label={LABELS.minimumMonthlySavings!} hint={`${spec("minimumMonthlySavings").hint} Typical: 5–15% of gross.`} spec={savingsSpec} value={ins.minimumMonthlySavings} defaultValue={DEF.minimumMonthlySavings} onChange={(v) => patch("minimumMonthlySavings", v)} />
      </Section>

      <Section id="cash" title="Cash for the home" open={open.cash} onToggle={toggle}         summary={
          <>
            {funds.linked ? <ProofValue proof={funds.proof("cash", ins.cashForHome)}>{kUsd(ins.cashForHome)}</ProofValue> : typedSummary(kUsd(ins.cashForHome))} ·{" "}
            {funds.linked ? (
              funds.buy.key ? `forecast, ${monthYear(funds.buy.key)}` : "net worth"
            ) : funds.config.mode === "networth" && funds.loading ? (
              "loading net worth…"
            ) : funds.config.mode === "networth" && (funds.book?.blockers.length || funds.error) ? (
              <span className="text-warn">fixed — net worth blocked</span>
            ) : (
              "fixed"
            )}
          </>
        }
      >
        <FundsSection ins={ins} patch={patch} funds={funds} />
      </Section>

      <Section id="mortgage" title="Mortgage" open={open.mortgage} onToggle={toggle} summary={typedSummary(`${pct(ins.annualMortgageRate, 3)} · ${ins.mortgageTermYears} yr${ins.annualMortgageInsuranceRateOnLoan > 0 ? " · PMI" : ""}`)}>
        <div className="flex items-center justify-between py-1.5">
          <span className="text-xs font-medium text-fg-2">Term</span>
          <Segmented size="xs" ariaLabel="Mortgage term" options={[10, 15, 20, 30].map((y) => ({ value: String(y), label: `${y} yr` }))} value={String(ins.mortgageTermYears)} onChange={(v) => patch("mortgageTermYears", Number(v))} />
        </div>
        {S("annualMortgageRate")}
        {S("annualMortgageInsuranceRateOnLoan", { extra: ins.annualMortgageInsuranceRateOnLoan > 0 ? <>= {formatUsd((focus.loan * ins.annualMortgageInsuranceRateOnLoan) / 12)}/mo at {focus.label}</> : undefined })}
      </Section>

      <Section
        id="running"
        title="Running costs"
        open={open.running}
        onToggle={toggle}
        summary={typedSummary(`${pct(ins.annualPropertyTaxRate + ins.annualInsuranceRateOnValue + ins.annualMaintenanceRate, 2)}/yr + ${kUsd(ins.utilitiesMonthly + ins.hoaMonthly)}/mo`)}
      >
        <p className="pb-1 text-[11px] text-faint">Percentages are of the home&apos;s value, per year.</p>
        {S("annualPropertyTaxRate", { extra: perMonth(ins.annualPropertyTaxRate) })}
        {S("annualInsuranceRateOnValue", { extra: perMonth(ins.annualInsuranceRateOnValue) })}
        {S("annualMaintenanceRate", { extra: perMonth(ins.annualMaintenanceRate) })}
        {S("utilitiesMonthly")}
        {S("hoaMonthly")}
      </Section>

      <Section id="oneTime" title="One-time costs" open={open.oneTime} onToggle={toggle} summary={typedSummary(`${pct(ins.closingCostsPctOfHomePrice, 2)} closing · ${pct(ins.renovationPctOfHomePrice)} reno`)}>
        <p className="pb-1 text-[11px] text-faint">Paid in cash at purchase, out of the cash for the home.</p>
        {S("closingCostsPctOfHomePrice", { extra: <>= {formatUsd(focus.price * ins.closingCostsPctOfHomePrice)} at {focus.label}</> })}
        {S("renovationPctOfHomePrice", { extra: <>= {formatUsd(focus.price * ins.renovationPctOfHomePrice)} at {focus.label}</> })}
      </Section>
    </aside>
  );
}

function Section({
  id,
  title,
  summary,
  open,
  onToggle,
  highlight,
  children,
}: {
  id: SectionId;
  title: string;
  summary: ReactNode;
  open: boolean;
  onToggle: (id: SectionId) => void;
  highlight?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`relative border-b border-line last:border-b-0 ${highlight ? "bg-accent-soft/40" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(id)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      >
        <span className={`text-[10px] text-faint transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className={`text-xs font-semibold ${highlight ? "text-accent" : "text-fg"}`}>{title}</span>
      </button>
      {/* Beside the toggle, not in it: a summary figure opens its proof, and a button can't hold another. */}
      {!open && (
        <span onClick={() => onToggle(id)} className="num absolute right-4 top-2.5 max-w-[55%] cursor-pointer truncate text-right text-[11px] text-muted">
          {summary}
        </span>
      )}
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

function FundsSection({ ins, patch, funds }: { ins: HomeBudgetInputs; patch: Patch; funds: FundsState }) {
  const { config, setConfig, book, derived, linked, buy } = funds;
  const fc = book?.forecast ?? null;
  const blocked = book !== null && book.blockers.length > 0;
  const fromNetWorth = config.mode === "networth";
  const manualSpec = { min: 0, max: Math.max(1_500_000, Math.ceil(((derived?.afterTax ?? 0) * 1.25) / 100_000) * 100_000), step: 5_000, unit: "usd" as const };

  return (
    <>
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="text-[11px] text-faint">Down payment, closing and renovation.</span>
        <Segmented
          size="xs"
          ariaLabel="Source of the cash for the home"
          options={[
            { value: "networth", label: "Net worth" },
            { value: "manual", label: "Fixed" },
          ]}
          value={config.mode}
          onChange={(mode) => {
            // Start a fixed amount from the net-worth figure rather than an old number.
            if (mode === "manual" && linked) patch("cashForHome", Math.round(derived!.available / 1000) * 1000);
            setConfig({ ...config, mode });
          }}
        />
      </div>
      {fromNetWorth && fc && (
        <div className="flex items-center justify-between gap-2 py-1">
          <span className="whitespace-nowrap text-xs font-medium text-fg-2">Buying</span>
          <span className="flex items-center gap-1.5">
            <Segmented
              size="xs"
              ariaLabel="When you buy"
              options={[
                { value: "now", label: "Now" },
                { value: "later", label: "Later" },
              ]}
              value={buy.key ? "later" : "now"}
              onChange={(v) => setConfig({ ...config, buyAt: v === "now" ? null : (config.buyAt && config.buyAt > fc.startKey ? config.buyAt : nextYearKey(fc.startKey)) })}
            />
            {buy.key && (
              <input
                type="month"
                aria-label="Buy month"
                className="num rounded-md border border-line-strong bg-surface px-1.5 py-0.5 text-xs text-fg"
                min={fc.months[0]?.key}
                max={fc.months.at(-1)?.key}
                value={buy.key}
                onChange={(e) => e.target.value && setConfig({ ...config, buyAt: e.target.value })}
              />
            )}
          </span>
        </div>
      )}
      {fromNetWorth && funds.loading && <Loading label="Reading balances from the Book…" />}
      {fromNetWorth && blocked && (
        <div className="mb-2">
          <BlockedNote blockers={book!.blockers} what="current net worth" />
          <p className="mt-1 text-xs text-muted">Using the fixed amount below until it&apos;s proven.</p>
        </div>
      )}

      {fromNetWorth && derived && book && (
        <div className={blocked ? "opacity-50" : ""}>
          <details className="group rounded-md border border-line bg-surface-2 px-3 py-1">
            <summary className="flex cursor-pointer list-none items-baseline justify-between py-1 text-xs">
              <span className="text-fg-2">
                Liquid, after tax <span className="text-[10px] text-faint group-open:hidden">▸ how</span>
              </span>
              <span className="num font-semibold text-fg">{formatUsd(derived.afterTax)}</span>
            </summary>
            <Row label="Bank cash" value={formatUsd(book.cashCents / 100)} />
            <Row label="Taxable investments" value={formatUsd(book.investmentsCents / 100)} />
            {book.cardsCents !== 0 && <Row label="Card balances owed" value={formatUsd(book.cardsCents / 100)} tone="neg" />}
            {derived.buyKey && (
              <Row
                label={`Forecast adds by ${monthYear(derived.buyKey)}`}
                sub={`liquid savings and growth after ${longDate(book.asOf)}`}
                value={formatUsd(derived.added)}
                tone={derived.added < 0 ? "neg" : undefined}
              />
            )}
            <Row
              label={`Tax on ${formatUsd(derived.gain)} of gains`}
              sub={`${formatPercentRatio(ins.capitalGainsTaxRate, 1)} of growth since first statements${derived.buyKey ? `, incl. ${formatUsd(derived.gainAdded)} the forecast earns by then` : ""}`}
              value={formatUsd(-derived.taxOnGain)}
              tone="neg"
            />
            <p className="pb-1.5 text-[11px] leading-snug text-faint">
              Proven through {longDate(book.asOf)} (<Link href="/net-worth" className="underline hover:text-fg">net worth</Link>). Not counted:{" "}
              {book.excluded.map((e) => `${e.group.toLowerCase()} ${formatUsd(e.cents / 100)}`).join(", ") || "nothing"}.
              {book.untrackedBasisCents > 0 && ` ${formatUsd(book.untrackedBasisCents / 100)} of investments predate their first statement and are treated as cost basis, so the tax may be understated.`}
            </p>
          </details>
          <RangeSlider
            compact
            label="Share to put into the home"
            spec={FUNDS_SHARE_SPEC}
            value={config.share}
            defaultValue={0.8}
            onChange={(share) => setConfig({ ...config, share })}
            hint="The rest stays invested as your reserve."
            extra={<>{formatUsd(derived.afterTax - derived.available)} stays invested as reserve</>}
          />
          <GainsTaxControl ins={ins} patch={patch} funds={funds} />
        </div>
      )}

      {(!fromNetWorth || blocked || funds.error) && (
        <RangeSlider
          compact
          label="Fixed amount"
          spec={manualSpec}
          value={ins.cashForHome}
          onChange={(v) => patch("cashForHome", Math.round(v))}
          disabled={linked}
          markers={derived ? [{ value: derived.available, label: "From net worth" }] : []}
          hint="Your own number for down payment + closing + renovation."
        />
      )}
      <div className="mt-1.5 flex items-baseline justify-between rounded-md bg-accent-soft px-3 py-1.5">
        <span className="text-xs font-semibold text-accent">Cash for the home</span>
        <span className="num text-base font-semibold text-fg">
          <ProofValue proof={funds.proof("cash", ins.cashForHome)}>{formatUsd(ins.cashForHome)}</ProofValue>
        </span>
      </div>
    </>
  );
}

/** A rate the tax engine works out, shown read-only with a way to type your own. */
function EngineRate({ label, value, note, onManual, proof }: { label: string; value: number; note: ReactNode; onManual: () => void; proof: ProofRef }) {
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-fg-2">{label}</span>
        <span className="num text-sm font-semibold text-fg">
          <ProofValue proof={proof}>{formatPercentRatio(value, 1)}</ProofValue>
        </span>
      </div>
      <p className="text-[11px] leading-snug text-faint">
        {note}{" "}
        <button type="button" className="text-accent hover:underline" onClick={onManual}>
          Type my own
        </button>
      </p>
    </div>
  );
}

function EngineLink({ rate, onClick }: { rate: number; onClick: () => void }) {
  return (
    <button type="button" className="text-accent hover:underline" onClick={onClick}>
      use the tax engine ({formatPercentRatio(rate, 1)})
    </button>
  );
}

/** Capital-gains tax: from the engine (federal, NIIT, Connecticut) unless typed. Shared with Rent vs buy. */
export function GainsTaxControl({ ins, patch, funds, full }: { ins: HomeBudgetInputs; patch: Patch; funds: Pick<FundsState, "tax" | "config" | "setConfig" | "proof">; full?: boolean }) {
  const { gains, year } = funds.tax;
  if (gains.linked)
    return (
      <EngineRate
        label={LABELS.capitalGainsTaxRate!}
        value={ins.capitalGainsTaxRate}
        proof={funds.proof("gains-tax", null)}
        note={
          <>
            <NotFigure why="set by law">Federal 15/20% + 3.8% NIIT</NotFigure> + Connecticut on{" "}
            <ProofValue proof={funds.proof("gain", Math.max(50_000, gains.gain))}>{formatUsd(Math.max(50_000, gains.gain))}</ProofValue> of long-term gains on top of the salary, {year} law.
          </>
        }
        onManual={() => {
          patch("capitalGainsTaxRate", Math.round(ins.capitalGainsTaxRate * 1000) / 1000);
          funds.setConfig({ ...funds.config, gainsTax: "manual" });
        }}
      />
    );
  return (
    <RangeSlider
      compact={!full}
      label={LABELS.capitalGainsTaxRate!}
      hint={spec("capitalGainsTaxRate").hint}
      spec={spec("capitalGainsTaxRate")}
      value={ins.capitalGainsTaxRate}
      defaultValue={DEF.capitalGainsTaxRate}
      onChange={(v) => patch("capitalGainsTaxRate", v)}
      extra={gains.engine != null ? <EngineLink rate={gains.engine} onClick={() => funds.setConfig({ ...funds.config, gainsTax: "engine" })} /> : undefined}
    />
  );
}

/** "Mar 2028" from YYYY-MM. */
const monthYear = (key: string) => new Date(`${key}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });

/** Twelve months after `key` (YYYY-MM): the first "later" a buy date jumps to. */
const nextYearKey = (key: string) => `${Number(key.slice(0, 4)) + 1}${key.slice(4)}`;
