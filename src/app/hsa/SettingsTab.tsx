"use client";

import { btn, Card, Field, inputCls } from "@/components/ui/kit";
import { formatPercentRatio } from "@/lib/formatMoney";
import type { HsaReport } from "@/lib/hsa/report";
import type { HsaSettings } from "@/lib/hsa/store";
import { useState } from "react";
import type { Send } from "./HsaClient";

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
        <Field label="HSA opened on" hint="Expenses before this can't be reimbursed: they're flagged and left out of the totals and suggestions.">
          <input type="date" className={inputCls} value={f.opened} onChange={set("opened")} />
        </Field>
        <Field
          label="Growth rate (% a year)"
          hint={`Total return, the same investments in the HSA and the taxable account. Blank: ${r.hsa.measuredReturn != null ? `your HSA's measured return (${formatPercentRatio(r.hsa.measuredReturn, 1)})` : "7%, as no HSA return can be measured yet"}.`}
        >
          {rateInput("growth", r.hsa.measuredReturn ?? 0.07)}
        </Field>
        <Field label="Marginal tax rate (%)" hint={`Federal + state income tax on your next dollar of pay. Blank: ${r.growth.marginalSource === "RETIREMENT" ? "from the Account limits page" : "32%"}.`}>
          {rateInput("marginal", r.growth.marginalSource === "SETTING" ? 0.32 : r.growth.marginalRate)}
        </Field>
        <Field label="Reimburse the backlog in" hint="The year you expect to draw the receipts down (retirement, a big purchase). Blank: 20 years out.">
          <input className={`${inputCls} num text-right`} inputMode="numeric" value={f.plan} onChange={(e) => setF((x) => ({ ...x, plan: e.target.value.replace(/\D/g, "").slice(0, 4) }))} placeholder={String(thisYear + 20)} />
        </Field>
        <Field label="Payroll tax saved (%)" hint="Contributions through payroll skip Medicare (1.45%) and, below the Social Security wage base, Social Security (6.2%). 0 if you contribute outside payroll. Blank: 1.45%.">
          {rateInput("payroll", 0.0145)}
        </Field>
        <Field label="Dividend yield (%)" hint="The part of the return a taxable account pays out, and is taxed on, each year. Blank: 1.5% (a broad stock index).">
          {rateInput("dividend", 0.015)}
        </Field>
        <Field label="Taxable account tax (%)" hint="On dividends and on the gain when sold: long-term capital gains + 3.8% NIIT + state. Blank: 20%.">
          {rateInput("taxable", 0.2)}
        </Field>
        <Field label="Medical bills will cover the growth" hint="A receipt only frees its own amount. Yes: later bills (retiree care, Medicare premiums) take the growth out tax-free too. Blank: yes.">
          <select className={inputCls} value={f.covered} onChange={set("covered")}>
            <option value="">Yes (default)</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
        {f.covered === "no" && (
          <Field label="Tax on uncovered growth (%)" hint="Taken out after 65 with no receipt, it's ordinary income (before 65, plus a 20% penalty). Blank: your marginal rate.">
            {rateInput("exit", r.growth.marginalRate)}
          </Field>
        )}
      </div>
    </Card>
  );
}
