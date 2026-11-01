"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { btn, ErrorNote, PageBody, Tabs, useSavedState, useTabParam } from "@/components/ui/kit";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { HomeFigure } from "@/lib/book/proof/planningProof";
import { computeLenderMax, computeMaxApproval, defaultHomeBudgetInputs, type HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import { defaultFunds, linkHome, type FundsBook, type FundsConfig, type HomeLinked } from "@/lib/home-budget/homeLinked";
import { useEffect, useMemo, useState } from "react";
import { AffordTab } from "./AffordTab";
import { InputsPanel } from "./InputsPanel";
import { PriceTab } from "./PriceTab";
import { RentVsBuyTab } from "./RentVsBuyTab";
import { SensitivityTab } from "./SensitivityTab";

const TABS = ["afford", "price", "rent", "sensitivity"] as const;
export type HomeTab = (typeof TABS)[number];

export type { FundsBook, FundsConfig, LinkedRate } from "@/lib/home-budget/homeLinked";

/** Where the cash for the home comes from, as shown in the Cash card. */
export type FundsState = Pick<HomeLinked, "derived" | "buy" | "linked" | "tax" | "returns"> & {
  config: FundsConfig;
  setConfig: (c: FundsConfig) => void;
  /** Book figures (null while loading or on error). */
  book: FundsBook | null;
  loading: boolean;
  error: string | null;
  /** A linked figure's proof, on the page's typed inputs and funds choices. */
  proof: HomeProof;
};

/** A Home budget figure's proof ("planning" kind); `dollars` is the figure as the page has it. */
export type HomeProof = (figure: HomeFigure, dollars: number | null) => ProofTarget;

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

  // The buy month, the forecast's salary then, liquid money then, the engine's tax rates: the inputs the model runs on.
  const { buy, derived, tax, linked, returns, ins, lender: lend } = useMemo(() => linkHome(book, stored, config), [book, stored, config]);

  const patch: Patch = (key, v) => setStored((s) => ({ ...s, [key]: v }));
  const proof: HomeProof = (figure, dollars) => ({
    descriptor: { report: "planning", page: "home", figure, inputs: stored, funds: config },
    shownCents: dollars == null ? null : Math.round(dollars * 100),
  });
  const funds: FundsState = { config, setConfig, book, loading: api.ready && !book && !error, error, derived, linked, buy, tax, returns, proof };
  const lender: LenderState = { ...lend, setCountBonus: (v) => setConfig({ ...config, lenderBonus: v }) };
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
              <AffordTab ins={ins} patch={patch} proof={proof} testPrice={testPrice} lender={lender} lenderMax={lenderMax} spending={book?.spending ?? null} />
            ) : (
              <PriceTab ins={ins} patch={patch} maxPrice={max.impliedMaxHomeValue} lenderMaxPrice={lenderMax.impliedMaxHomeValue} allCashDownPct={allCashDownPct} spendMonthly={spendMonthly} proof={proof} />
            )}
          </div>
        ) : (
          <>
            {tab === "rent" ? <RentVsBuyTab ins={ins} patch={patch} goToBudget={() => setTab("price")} funds={funds} /> : <SensitivityTab ins={ins} proof={proof} salaryLinked={funds.buy.salaryLinked} />}
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
