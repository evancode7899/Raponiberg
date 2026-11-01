"use client";

import { btn, Card, Field, inputCls, NotFigure } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { formatPercentRatio } from "@/lib/formatMoney";
import type { HsaReport } from "@/lib/hsa/report";
import type { HsaSettings } from "@/lib/hsa/store";
import { useState } from "react";
import type { Send } from "./HsaClient";
import { useHsaDerived } from "./derived";

/** Rates the hints name that aren't figures of yours: the tax law's, and the built-in fallbacks. */
const LAW = "set by tax law";
const BUILT_IN = "a built-in fallback, used only when nothing can be read off your data";

const pct = (v: number | null) => (v == null ? "" : String(+(v * 100).toFixed(2)));
const ratio = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s) / 100);

type Form = { opened: string; growth: string; marginal: string; plan: string; dividend: string; taxable: string; payroll: string; covered: string; exit: string };

const toForm = (s: HsaSettings): Form => ({
  opened: s.openedOn ?? "",
  growth: pct(s.growthRate),
  marginal: pct(s.marginalRate),
  plan: s.planYear ? String(s.planYear) : "",
  dividend: pct(s.dividendYield),
  taxable: pct(s.taxableRate),
  payroll: pct(s.payrollRate),
  covered: s.growthCovered == null ? "" : s.growthCovered ? "yes" : "no",
  exit: pct(s.exitRate),
});

export function SettingsTab({ r, send }: { r: HsaReport; send: Send }) {
  const [f, setF] = useState(() => toForm(r.settings));
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  // New settings from the server reset the form (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(r.settings);
  if (r.settings !== seen) {
    setSeen(r.settings);
    setF(toForm(r.settings));
  }

  const save = () => {
    const settings: HsaSettings = {
      openedOn: f.opened || null,
      growthRate: ratio(f.growth),
      marginalRate: ratio(f.marginal),
      planYear: f.plan ? Number(f.plan) : null,
      dividendYield: ratio(f.dividend),
      taxableRate: ratio(f.taxable),
      payrollRate: ratio(f.payroll),
      growthCovered: f.covered === "" ? null : f.covered === "yes",
      exitRate: ratio(f.exit),
    };
    void send({ op: "settings", settings });
  };
  const thisYear = Number(r.today.slice(0, 4));
  const dp = useHsaDerived(r);
  /** A blank setting's fallback read off your data, as its own figure. */
  const fallback = (key: string, v: number, digits: number) => <ProofValue proof={dp("default", key)}>{formatPercentRatio(v, digits)}</ProofValue>;
  const rateInput = (k: keyof Form, placeholder: number) => (
    <input className={`${inputCls} num text-right`} inputMode="decimal" value={f[k]} onChange={set(k)} placeholder={pct(placeholder)} />
  );

  return (
    <Card
      title="Settings"
      subtitle="Saved with the log in data/hsa-expenses.json (backed up with the rest of your data; every change is also journaled beside it)."
      actions={
        <button type="button" className={btn.primary} onClick={save}>
          Save
        </button>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="HSA opened on" hint={`Expenses before this can't be reimbursed: they're flagged and left out of the totals and suggestions. Blank: ${r.hsa.openedFrom === "STATEMENTS" ? `${r.hsa.openedOn}, when its first statement opens at $0` : "unknown (the statements on file don't reach back to the opening)"}.`}>
          <input type="date" className={inputCls} value={f.opened} onChange={set("opened")} />
        </Field>
        <Field
          label="Growth rate (% a year)"
          hint={
            <>
              Total return, the same investments in the HSA and the taxable account. Blank:{" "}
              {r.hsa.measuredReturn != null ? (
                <>your HSA&apos;s measured return ({fallback("growth", r.hsa.measuredReturn, 1)})</>
              ) : r.growth.rateSource === "FORECAST" ? (
                <>the forecast&apos;s return ({fallback("growth", r.growth.rate, 1)})</>
              ) : (
                <><NotFigure why={BUILT_IN}>7%</NotFigure>, as no return can be measured or read off the forecast</>
              )}
              .
            </>
          }
        >
          {rateInput("growth", r.hsa.measuredReturn ?? 0.07)}
        </Field>
        <Field label="Marginal tax rate (%)" hint={
            <>
              Federal + state income tax on your next dollar of pay. Blank:{" "}
              {r.growth.marginalSource === "RETIREMENT" ? (
                "from the Account limits page"
              ) : r.growth.marginalSource === "TAX_REPORT" ? (
                <>
                  the Taxes page&apos;s {fallback("marginal", r.growth.marginalRate, 1)} (federal, with the <NotFigure why={LAW}>0.9%</NotFigure> Medicare surtax, + state)
                </>
              ) : (
                "none proven, so the growth figures are withheld"
              )}
              .
            </>
          }
        >
          {rateInput("marginal", r.growth.marginalSource === "SETTING" ? 0.32 : r.growth.marginalRate)}
        </Field>
        <Field label="Reimburse the backlog in" hint="The year you expect to draw the receipts down (retirement, a big purchase). Blank: 20 years out.">
          <input className={`${inputCls} num text-right`} inputMode="numeric" value={f.plan} onChange={(e) => setF((x) => ({ ...x, plan: e.target.value.replace(/\D/g, "").slice(0, 4) }))} placeholder={String(thisYear + 20)} />
        </Field>
        <Field label="Payroll tax saved (%)" hint={
            <>
              Contributions through payroll skip Medicare (<NotFigure why={LAW}>1.45%</NotFigure>) and, below the Social Security wage base, Social Security (<NotFigure why={LAW}>6.2%</NotFigure>). 0 if you contribute outside payroll. Blank:{" "}
              {r.growth.payrollSource === "PAY_STUBS" ? "worked out from your pay stubs" : r.growth.payrollSource === "TAX_REPORT" ? "the Taxes page's" : "none proven, so the growth figures are withheld"}.
            </>
          }
        >
          {rateInput("payroll", r.growth.payrollSource === "SETTING" ? 0.0145 : r.growth.assumptions.payrollRate)}
        </Field>
        <Field label="Dividend yield (%)" hint={
            <>
              The part of the return a taxable account pays out, and is taxed on, each year. Blank:{" "}
              {r.growth.dividendSource === "STATEMENTS" ? (
                <>what your taxable statements show ({fallback("dividend", r.growth.assumptions.dividendYield, 2)})</>
              ) : (
                <><NotFigure why={BUILT_IN}>1.5%</NotFigure> (no taxable dividends on file to measure)</>
              )}
              .
            </>
          }
        >
          {rateInput("dividend", r.growth.dividendSource === "SETTING" ? 0.015 : r.growth.assumptions.dividendYield)}
        </Field>
        <Field label="Taxable account tax (%)" hint={
            <>
              On dividends and on the gain when sold: long-term capital gains + <NotFigure why={LAW}>3.8%</NotFigure> NIIT + state. Blank:{" "}
              {r.growth.taxableSource === "TAX_ENGINE" ? (
                <>the tax engine&apos;s rate on a gain at your forecast salary ({fallback("taxable", r.growth.assumptions.taxableRate, 1)})</>
              ) : (
                <><NotFigure why={BUILT_IN}>20%</NotFigure> (the tax engine can&apos;t price it yet)</>
              )}
              .
            </>
          }
        >
          {rateInput("taxable", r.growth.taxableSource === "SETTING" ? 0.2 : r.growth.assumptions.taxableRate)}
        </Field>
        <Field label="Medical bills will cover the growth" hint="A receipt only frees its own amount. Yes: later bills (retiree care, Medicare premiums) take the growth out tax-free too. Blank: yes.">
          <select className={inputCls} value={f.covered} onChange={set("covered")}>
            <option value="">Yes (default)</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
        {f.covered === "no" && (
          <Field label="Tax on uncovered growth (%)" hint={
              <>
                Taken out after 65 with no receipt, it&apos;s ordinary income (before 65, plus a <NotFigure why={LAW}>20%</NotFigure> penalty). Blank: your marginal rate.
              </>
            }>
            {rateInput("exit", r.growth.marginalRate)}
          </Field>
        )}
      </div>
    </Card>
  );
}
