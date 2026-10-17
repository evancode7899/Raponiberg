"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { btn, ErrorNote, PageBody, Tabs, useSavedState, useTabParam } from "@/components/ui/kit";
import type { HomeFunds, HomeSpending } from "@/lib/book/reports/homeFunds";
import type { HomeForecast } from "@/lib/forecast/forecast";
import { cashForHomeFromNetWorth, computeLenderMax, computeMaxApproval, defaultHomeBudgetInputs, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import { gainsTaxRate, payTaxRate } from "@/lib/home-budget/homeTax";
import { useEffect, useMemo, useState } from "react";
import { AffordTab } from "./AffordTab";
import { InputsPanel } from "./InputsPanel";
import { PriceTab } from "./PriceTab";
import { RentVsBuyTab } from "./RentVsBuyTab";
import { SensitivityTab } from "./SensitivityTab";

const TABS = ["afford", "price", "rent", "sensitivity"] as const;
export type HomeTab = (typeof TABS)[number];

/**
 * Where the cash for the home comes from (net worth or a fixed amount) and when you buy:
 * null = today's proven balances, or a month (YYYY-MM) read from the shared forecast. The
 * household salary follows the forecast for that year unless typed (`salary: "manual"`);
 * the income and capital-gains tax rates come from the tax engine unless typed; the lender
 * view counts bonus unless `lenderBonus` is false.
 */
export type FundsConfig = {
  mode: "networth" | "manual";
  share: number;
  buyAt?: string | null;
  salary?: "forecast" | "manual";
  incomeTax?: "engine" | "manual";
  gainsTax?: "engine" | "manual";
  lenderBonus?: boolean;
};
const defaultFunds = (): FundsConfig => ({ mode: "networth", share: 0.8, buyAt: null, salary: "forecast", incomeTax: "engine", gainsTax: "engine", lenderBonus: true });

export type FundsBook = HomeFunds & { forecast: HomeForecast | null; spending: HomeSpending | null };

/** A tax rate from the engine (null when it can't be worked out) and whether the page uses it. */
export type LinkedRate = { engine: number | null; linked: boolean };

/** Where the cash for the home comes from, as shown in the Cash card. */
export type FundsState = {
  config: FundsConfig;
  setConfig: (c: FundsConfig) => void;
  /** Book figures (null while loading or on error). */
  book: FundsBook | null;
  loading: boolean;
  error: string | null;
  /** Liquid net worth after cards (at the buy date), its tax on gains, after-tax and the committed share. */
  derived: { liquid: number; gain: number; taxOnGain: number; afterTax: number; available: number; buyKey: string | null; added: number; gainAdded: number } | null;
  /** The buy month actually used (null = now), and the forecast's household base salary that year (dollars). */
  buy: { key: string | null; year: number; salary: number | null; salaryLinked: boolean };
  /** True when the cash for the home is the net-worth figure (linked, loaded, proven). */
  linked: boolean;
  /** Income tax on the salary and capital-gains tax, from the tax engine. */
  tax: { year: number | null; income: LinkedRate; gains: LinkedRate & { gain: number } };
};

/** What the lender view counts: base salary plus, when counted, the lender's two-year bonus average. */
export type LenderState = { bonus: { annual: number; years: number[] } | null; countBonus: boolean; setCountBonus: (v: boolean) => void; income: number };

export type Patch = <K extends keyof HomeBudgetInputs>(key: K, v: HomeBudgetInputs[K]) => void;

export function HomeBudgetClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "afford");
  const [stored, setStored] = useSavedState<HomeBudgetInputs>("pf-home-budget-inputs", defaultHomeBudgetInputs);
  const [config, setConfig] = useSavedState<FundsConfig>("pf-home-budget-funds", defaultFunds);
  const [book, setBook] = useState(() => cachedResponse<FundsBook>("/api/home-budget/funds"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<FundsBook>("/api/home-budget/funds")
      .then(setBook)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  // A buy month only means something with a forecast that reaches it.
  const fc = book?.forecast ?? null;
  const buyKey = fc && config.buyAt && config.buyAt > fc.startKey && fc.months.some((m) => m.key === config.buyAt) ? config.buyAt : null;
  const buyYear = buyKey ? Number(buyKey.slice(0, 4)) : fc ? Number(fc.startKey.slice(0, 4)) : new Date().getFullYear();
  const forecastSalary = fc?.salary[buyYear] != null ? fc.salary[buyYear]! / 100 : null;
  const salaryLinked = config.salary !== "manual" && forecastSalary != null;
  const buy = { key: buyKey, year: buyYear, salary: forecastSalary, salaryLinked };
  const salary = salaryLinked ? forecastSalary! : stored.annualHouseholdSalary;

  // At a future month: today's proven liquid money plus what the forecast adds by then, and the growth in it as more gain.
  const gains = useMemo(() => {
    if (!book) return null;
    const at = buyKey && fc ? fc.months.find((m) => m.key === buyKey)! : null;
    const added = at && fc ? (at.liquid - fc.startLiquid) / 100 : 0;
    const gainAdded = at && fc ? fc.months.filter((m) => m.key <= buyKey!).reduce((t, m) => t + m.liquidGrowth, 0) / 100 : 0;
    return { added, gainAdded, gain: book.gainCents / 100 + gainAdded };
  }, [book, fc, buyKey]);

  // Tax rates from the engine at this salary, unless typed.
  const tax = useMemo(() => {
    const basis = fc?.tax ?? null;
    const gain = gains?.gain ?? 0;
    const incomeEngine = basis ? payTaxRate(basis, salary) : null;
    const gainsEngine = basis ? gainsTaxRate(basis, salary, gain) : null;
    return {
      year: basis?.year ?? null,
      income: { engine: incomeEngine, linked: config.incomeTax !== "manual" && incomeEngine != null },
      gains: { engine: gainsEngine, linked: config.gainsTax !== "manual" && gainsEngine != null, gain },
    };
  }, [fc, salary, gains, config.incomeTax, config.gainsTax]);
  const capitalGainsTaxRate = tax.gains.linked ? tax.gains.engine! : stored.capitalGainsTaxRate;

  const derived = useMemo(() => {
    if (!book || !gains) return null;
    const liquid = (book.cashCents + book.investmentsCents + book.cardsCents) / 100 + gains.added;
    return { liquid, gain: gains.gain, buyKey, added: gains.added, gainAdded: gains.gainAdded, ...cashForHomeFromNetWorth({ liquid, gain: gains.gain, taxRate: capitalGainsTaxRate, share: config.share }) };
  }, [book, gains, buyKey, capitalGainsTaxRate, config.share]);

  const linked = config.mode === "networth" && derived !== null && book!.blockers.length === 0;
  // The model only sees one number each: the linked figure, or the typed amount.
  const ins = useMemo<HomeBudgetInputs>(
    () => ({
      ...stored,
      cashForHome: linked ? derived!.available : stored.cashForHome,
      annualHouseholdSalary: salary,
      incomeTaxRate: tax.income.linked ? tax.income.engine! : stored.incomeTaxRate,
      capitalGainsTaxRate,
    }),
    [stored, linked, derived, salary, tax, capitalGainsTaxRate],
  );

  const patch: Patch = (key, v) => setStored((s) => ({ ...s, [key]: v }));
  const funds: FundsState = { config, setConfig, book, loading: api.ready && !book && !error, error, derived, linked, buy, tax };
  const lenderBonus = fc?.lenderBonus ? { annual: fc.lenderBonus.annual / 100, years: fc.lenderBonus.years } : null;
  const countBonus = config.lenderBonus !== false && lenderBonus != null;
  const lender: LenderState = {
    bonus: lenderBonus,
    countBonus,
    setCountBonus: (v) => setConfig({ ...config, lenderBonus: v }),
    income: ins.annualHouseholdSalary + (countBonus ? lenderBonus!.annual : 0),
  };
  const lenderMax = useMemo(() => computeLenderMax(ins, lender.income), [ins, lender.income]);
  const spendMonthly = book?.spending ? book.spending.monthlyCents / 100 : null;
  const reset = () => {
    setStored(defaultHomeBudgetInputs());
    setConfig(defaultFunds());
  };

  const max = useMemo(() => computeMaxApproval(ins), [ins]);
  const at = (share: number) => computeMaxApproval({ ...ins, housingCostMaxOfGross: share }).impliedMaxHomeValue;
  // Down payment that uses exactly the cash for the home at the target price.
  const allCashDownPct =
    ins.budgetHomePrice > 0 ? Math.min(1, Math.max(0, ins.cashForHome / ins.budgetHomePrice - ins.closingCostsPctOfHomePrice - ins.renovationPctOfHomePrice)) : 0;
  const testPrice = (price: number, downPct: number) => {
    setStored((s) => ({ ...s, budgetHomePrice: price, budgetDownPaymentPct: downPct }));
    setTab("price");
  };

  return (
    <>
      <Tabs
        tabs={[
          { id: "afford", label: "What can I afford" },
          { id: "price", label: "Test a price" },
          { id: "rent", label: "Rent vs buy" },
          { id: "sensitivity", label: "Sensitivity" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>Couldn&apos;t load net worth for the cash default: {error}. Using the fixed amount instead.</ErrorNote>}
        {tab === "afford" || tab === "price" ? (
          <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
            <InputsPanel
              ins={ins}
              patch={patch}
              funds={funds}
              onReset={reset}
              focus={
                tab === "afford"
                  ? { price: max.impliedMaxHomeValue, loan: max.impliedMaxLoan, label: "your max" }
                  : { price: ins.budgetHomePrice, loan: ins.budgetHomePrice * (1 - ins.budgetDownPaymentPct), label: "this price" }
              }
              home={
                tab === "price"
                  ? {
                      priceSpec: {
                        min: 100_000,
                        max: Math.max(2_500_000, Math.ceil((at(0.43) * 1.3) / 100_000) * 100_000),
                        step: 5_000,
                        unit: "usd",
                        band: [Math.round(Math.min(at(0.28), max.impliedMaxHomeValue)), Math.round(max.impliedMaxHomeValue)],
                        sides: ["Conservative", "Aggressive"],
                      },
                      markers: [
                        { value: max.impliedMaxHomeValue, label: "Your max" },
                        { value: lenderMax.impliedMaxHomeValue, label: "Lender max" },
                      ],
                      allCashDownPct,
                    }
                  : undefined
              }
            />
            {tab === "afford" ? (
              <AffordTab ins={ins} patch={patch} testPrice={testPrice} lender={lender} lenderMax={lenderMax} spending={book?.spending ?? null} />
            ) : (
              <PriceTab ins={ins} patch={patch} maxPrice={max.impliedMaxHomeValue} lenderMaxPrice={lenderMax.impliedMaxHomeValue} allCashDownPct={allCashDownPct} spendMonthly={spendMonthly} />
            )}
          </div>
        ) : (
          <>
            {tab === "rent" ? <RentVsBuyTab ins={ins} patch={patch} goToBudget={() => setTab("price")} funds={funds} /> : <SensitivityTab ins={ins} />}
            <div className="flex justify-end">
              <button type="button" className={btn.ghost} onClick={reset} title="Every input back to its default, cash linked to net worth again">
                Reset all inputs
              </button>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
