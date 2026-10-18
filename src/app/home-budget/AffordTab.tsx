"use client";

import { useChartPalette } from "@/components/shell/chartPalette";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, btn, Callout, Card, Segmented } from "@/components/ui/kit";
import type { HomeSpending } from "@/lib/book/reports/homeFunds";
import { formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import { computeBudgetScenario, computeMaxApproval, defaultHomeBudgetInputs, type HomeBudgetInputs, type MaxApprovalResult } from "@/lib/home-budget/homeBudgetModel";
import { useMemo } from "react";
import type { HomeProof, LenderState, Patch } from "./HomeBudgetClient";
import { spendingFit, StackBar, tiersFor, type TierKey } from "./parts";
import { RangeSlider } from "./RangeSlider";
import { spec } from "./specs";

// Floor, so a quoted "up to" price never lands past the limit.
const round1k = (v: number) => Math.floor(v / 1000) * 1000;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${formatUsd(Math.abs(v))}`;

/** Max price and the budget at it, for one housing limit. */
function maxAt(ins: HomeBudgetInputs, share = ins.housingCostMaxOfGross) {
  const i = { ...ins, housingCostMaxOfGross: share };
  const max = computeMaxApproval(i);
  const at = computeBudgetScenario({ ...i, budgetHomePrice: max.impliedMaxHomeValue, budgetDownPaymentPct: max.downPaymentPctOfHome });
  return { max, at };
}

/** One-step nudges to the inputs, and how far each moves the most you can afford. */
const LEVERS: { label: string; apply: (i: HomeBudgetInputs) => Partial<HomeBudgetInputs> }[] = [
  { label: "Earn $10k more a year", apply: (i) => ({ annualHouseholdSalary: i.annualHouseholdSalary + 10_000 }) },
  { label: "Put in $50k more cash", apply: (i) => ({ cashForHome: i.cashForHome + 50_000 }) },
  { label: "Rate 0.5 pt lower", apply: (i) => ({ annualMortgageRate: Math.max(0, i.annualMortgageRate - 0.005) }) },
  { label: "Limit 1 pt higher", apply: (i) => ({ housingCostMaxOfGross: i.housingCostMaxOfGross + 0.01 }) },
  { label: "Property tax 0.25 pt lower", apply: (i) => ({ annualPropertyTaxRate: Math.max(0, i.annualPropertyTaxRate - 0.0025) }) },
  { label: "A $300/mo HOA", apply: (i) => ({ hoaMonthly: i.hoaMonthly + 300 }) },
  { label: "No renovation budget", apply: () => ({ renovationPctOfHomePrice: 0 }) },
];

export function AffordTab({
  ins,
  patch,
  proof,
  testPrice,
  lender,
  lenderMax,
  spending,
}: {
  ins: HomeBudgetInputs;
  patch: Patch;
  proof: HomeProof;
  testPrice: (price: number, downPct: number) => void;
  lender: LenderState;
  lenderMax: MaxApprovalResult;
  spending: HomeSpending | null;
}) {
  const chart = useChartPalette();
  const tiers = useMemo(() => tiersFor(ins.housingCostMaxOfGross).map((t) => ({ ...t, ...maxAt(ins, t.share) })), [ins]);
  const mine = tiers.find((t) => t.key === "limit")!;
  const { max, at } = mine;
  const maxValue = max.impliedMaxHomeValue;
  const levers = useMemo(
    () => LEVERS.map((l) => ({ label: l.label, delta: computeMaxApproval({ ...ins, ...l.apply(ins) }).impliedMaxHomeValue - maxValue })),
    [ins, maxValue],
  );
  const biggest = Math.max(1, ...levers.map((l) => Math.abs(l.delta)));
  const price = round1k(max.impliedMaxHomeValue);
  const takeHome = at.monthlyIncome * (1 - ins.incomeTaxRate);

  const issues: { tone: "bad" | "warn"; title: string; body: string }[] = [];
  if (max.impliedDownPayment < 0)
    issues.push({ tone: "bad", title: "Not enough cash for closing and renovation", body: `Closing and renovation alone take ${formatUsd(-max.impliedDownPayment)} more than the cash for the home. Commit more cash or trim the renovation budget.` });
  if (at.remainingDiscretionaryMonthly < 0)
    issues.push({ tone: "bad", title: `${formatUsd(-at.remainingDiscretionaryMonthly)} a month short at this price`, body: "Income tax, housing at your limit and the savings target add up to more than gross pay. Lower the housing limit or the savings target." });
  if (max.downPaymentPctOfHome < 0.2 && max.downPaymentPctOfHome >= 0 && ins.annualMortgageInsuranceRateOnLoan === 0)
    issues.push({ tone: "warn", title: `Only ${formatPercentRatio(max.downPaymentPctOfHome, 1)} down — expect mortgage insurance`, body: "Lenders usually charge PMI under 20% down. Add it under Mortgage to see its real effect on the price." });

  const housingSegments = [
    { key: "pmt", label: "Mortgage (P&I)", value: at.monthlyMortgagePayment, color: chart.series[0]! },
    { key: "tax", label: "Property tax", value: at.monthlyPropertyTax, color: chart.series[1]! },
    { key: "ins", label: "Insurance", value: at.monthlyInsurance, color: chart.series[2]! },
    { key: "maint", label: "Maintenance", value: at.monthlyMaintenance, color: chart.series[3]! },
    { key: "util", label: "Utilities", value: at.monthlyUtilities, color: chart.series[4]! },
    { key: "hoa", label: "HOA", value: at.monthlyHoa, color: chart.series[6]! },
    { key: "mi", label: "Mortgage insurance", value: at.monthlyMortgageInsurance, color: chart.series[7]! },
  ];
  const cashSegments = [
    { key: "down", label: `Down payment (${formatPercentRatio(Math.max(0, at.downPaymentPct), 1)})`, value: Math.max(0, at.downPaymentDollars), color: chart.series[0]! },
    { key: "closing", label: "Closing costs", value: at.closingCostsDollars, color: chart.series[1]! },
    { key: "reno", label: "Renovation / furnishing", value: at.renovationDollars, color: chart.series[3]! },
  ];
  const paySegments = [
    { key: "tax", label: "Income tax", value: at.incomeTaxMonthly, color: chart.neutral },
    { key: "housing", label: "Housing", value: at.monthlyTotalHousing, color: chart.series[0]! },
    { key: "save", label: "Savings target", value: ins.minimumMonthlySavings, color: chart.series[2]! },
    { key: "left", label: "Left to spend", value: Math.max(0, at.remainingDiscretionaryMonthly), color: chart.series[3]! },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* The answer. */}
      <section className="min-w-0 rounded-lg border border-accent/40 bg-surface p-5 shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">You can afford up to</div>
            <div className="num mt-1 text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
              <ProofValue proof={proof("max-price", max.impliedMaxHomeValue)}>{formatUsd(price)}</ProofValue>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-2">
              <span className="num font-semibold text-fg">{formatUsd(at.monthlyTotalHousing)}</span>/mo all-in — {formatPercentRatio(ins.housingCostMaxOfGross, 1)} of gross,{" "}
              {formatPercentRatio(takeHome > 0 ? at.monthlyTotalHousing / takeHome : 0, 0)} of take-home. Every dollar of the{" "}
              <span className="num font-semibold text-fg">{formatUsd(ins.cashForHome)}</span> cash goes in:{" "}
              <span className="num font-semibold text-fg">{formatUsd(Math.max(0, max.impliedDownPayment))}</span> down ({formatPercentRatio(Math.max(0, max.downPaymentPctOfHome), 1)}), loan{" "}
              <span className="num font-semibold text-fg">{formatUsd(max.impliedMaxLoan)}</span> at {formatPercentRatio(ins.annualMortgageRate, 3)} over {ins.mortgageTermYears} years.
            </p>
            <p className="mt-1 text-sm text-fg-2">
              Leaves <span className={`num font-semibold ${at.remainingDiscretionaryMonthly < 0 ? "text-neg" : "text-pos"}`}>{formatUsd(at.remainingDiscretionaryMonthly)}</span>/mo to spend after tax and{" "}
              {formatUsd(ins.minimumMonthlySavings)} of savings.
            </p>
            {spending && <SpendCheck left={at.remainingDiscretionaryMonthly} spending={spending} />}
          </div>
          <button type="button" className={btn.primary} onClick={() => testPrice(price, Math.max(0.03, max.downPaymentPctOfHome))}>
            Stress-test this price →
          </button>
        </div>

        {/* Tiers. */}
        <div className={`mt-5 grid gap-2 ${tiers.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          {tiers.map((t) => (
            <TierCard
              key={t.key}
              tierKey={t.key}
              label={t.label}
              note={t.note}
              share={t.share}
              price={round1k(t.max.impliedMaxHomeValue)}
              monthly={t.at.monthlyTotalHousing}
              left={t.at.remainingDiscretionaryMonthly}
              onTest={() => testPrice(round1k(t.max.impliedMaxHomeValue), Math.max(0.03, t.max.downPaymentPctOfHome))}
            />
          ))}
        </div>
      </section>

      {issues.map((i) => (
        <Callout key={i.title} tone={i.tone} title={i.title}>
          {i.body}
        </Callout>
      ))}

      <div className="flex min-w-0 flex-col gap-4">
        <Card title={`What ${formatUsd(price)} looks like`} subtitle="At your limit, with all of the cash for the home put in.">
          <div className="flex flex-col gap-5">
            <Figure title="Every month" value={`${formatUsd(at.monthlyTotalHousing)}/mo`}>
              <StackBar segments={housingSegments} />
            </Figure>
            <Figure title="At closing" value={formatUsd(at.cashNeeded)}>
              <StackBar segments={cashSegments} />
            </Figure>
            <Figure title="A month of pay" value={`${formatUsd(at.monthlyIncome)} gross`}>
              <StackBar segments={paySegments} scale={Math.max(at.monthlyIncome, at.incomeTaxMonthly + at.monthlyTotalHousing + ins.minimumMonthlySavings)} />
            </Figure>
          </div>
        </Card>

        <LenderCard ins={ins} patch={patch} proof={proof} lender={lender} max={lenderMax} comfortMax={maxValue} testPrice={testPrice} />

        <Card title="What moves the number" subtitle="Change in the most you can afford from one step on each input.">
          <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            {levers.map((l) => (
              <li key={l.label} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-fg-2">{l.label}</span>
                  <span className={`num shrink-0 font-semibold ${l.delta >= 0 ? "text-pos" : "text-neg"}`}>{signed(round1k(l.delta))}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div className={`h-full rounded-full ${l.delta >= 0 ? "bg-pos/70" : "bg-neg/70"}`} style={{ width: `${(Math.abs(l.delta) / biggest) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

const TIER_STYLE: Record<TierKey, { ring: string; tone: "pos" | "accent" | "warn" }> = {
  comfortable: { ring: "border-line", tone: "pos" },
  limit: { ring: "border-accent ring-1 ring-accent/40", tone: "accent" },
  stretch: { ring: "border-line", tone: "warn" },
};

function TierCard({
  tierKey,
  label,
  note,
  share,
  price,
  monthly,
  left,
  onTest,
}: {
  tierKey: TierKey;
  label: string;
  note: string;
  share: number;
  price: number;
  monthly: number;
  left: number;
  onTest: () => void;
}) {
  const s = TIER_STYLE[tierKey];
  return (
    <button
      type="button"
      onClick={onTest}
      title="Stress-test this price"
      className={`group min-w-0 rounded-md border bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft/40 ${s.ring}`}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone={s.tone}>{label}</Badge>
        <span className="text-[11px] text-faint">
          {formatPercentRatio(share, 1)} · {note}
        </span>
      </div>
      <div className="num mt-1.5 text-xl font-semibold text-fg">{formatUsd(price)}</div>
      <div className="mt-0.5 text-[11px] text-muted">
        <span className="num">{formatUsd(monthly)}</span>/mo housing · <span className={`num ${left < 0 ? "text-neg" : ""}`}>{formatUsd(left)}</span>/mo left
      </div>
      <div className="mt-1 text-[11px] font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100">Stress-test →</div>
    </button>
  );
}

function Figure({ title, value, children }: { title: string; value: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</span>
        <span className="num text-sm font-semibold text-fg">{value}</span>
      </div>
      {children}
    </div>
  );
}

/** Today's spending outside housing next to what this price leaves, with a verdict. */
export function SpendCheck({ left, spending }: { left: number; spending: HomeSpending }) {
  const spend = spending.monthlyCents / 100;
  const fit = spendingFit(left, spend);
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
      <span>
        You spend <span className="num font-semibold text-fg">{formatUsd(spend)}</span>/mo today outside housing
        <span className="text-xs text-faint"> (last {spending.months} months, one-offs out)</span>
      </span>
      {fit.label && <Badge tone={fit.tone}>{fit.label}</Badge>}
    </p>
  );
}

const DEF = defaultHomeBudgetInputs();

/**
 * The lender's view: the most a lender would likely approve. Not a target — it counts
 * only the costs a lender does, on base pay plus (optionally) the two-year bonus average.
 */
function LenderCard({
  ins,
  patch,
  proof,
  lender,
  max,
  comfortMax,
  testPrice,
}: {
  ins: HomeBudgetInputs;
  patch: Patch;
  proof: HomeProof;
  lender: LenderState;
  max: MaxApprovalResult;
  comfortMax: number;
  testPrice: (price: number, downPct: number) => void;
}) {
  const price = round1k(max.impliedMaxHomeValue);
  const counted = max.monthlyMortgagePayment + max.monthlyPropertyTax + max.monthlyInsurance + ins.hoaMonthly + max.monthlyMortgageInsurance;
  const sp = spec("lenderMaxDti");
  return (
    <Card
      title="Lender view"
      subtitle="The most a lender would likely approve — a ceiling, not a target. Counts only the loan payment, property tax, insurance, HOA and mortgage insurance (no utilities or upkeep)."
      actions={
        <button type="button" className={btn.ghost} onClick={() => testPrice(price, Math.max(0.03, max.downPaymentPctOfHome))}>
          Stress-test →
        </button>
      }
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="num text-3xl font-semibold tracking-tight text-fg">
            <ProofValue proof={proof("lender-max", max.impliedMaxHomeValue)}>{formatUsd(price)}</ProofValue>
          </div>
          <p className="mt-1 text-xs text-fg-2">
            <span className="num font-semibold text-fg">{formatUsd(counted)}</span>/mo counted against{" "}
            <span className="num font-semibold text-fg">
              <ProofValue proof={proof("lender-income", lender.income)}>{formatUsd(lender.income)}</ProofValue>
            </span>
            /yr of income ({formatPercentRatio(ins.lenderMaxDti, 1)}) ·{" "}
            <span className="num">{signed(round1k(max.impliedMaxHomeValue - comfortMax))}</span> vs your limit
          </p>
        </div>
        {lender.bonus && (
          <div className="flex flex-col items-end gap-1">
            <Segmented
              size="xs"
              ariaLabel="Income the lender counts"
              options={[
                { value: "bonus", label: "Base + bonus" },
                { value: "base", label: "Base only" },
              ]}
              value={lender.countBonus ? "bonus" : "base"}
              onChange={(v) => lender.setCountBonus(v === "bonus")}
            />
            <span className="text-[11px] text-faint">
              Bonus {formatUsd(lender.bonus.annual)}/yr: average of {lender.bonus.years.join(" and ")}
            </span>
          </div>
        )}
      </div>
      <div className="mt-3 max-w-md">
        <RangeSlider compact label="Lender's limit (% of gross)" hint={sp.hint} spec={sp} value={ins.lenderMaxDti} defaultValue={DEF.lenderMaxDti} onChange={(v) => patch("lenderMaxDti", v)} />
      </div>
    </Card>
  );
}
