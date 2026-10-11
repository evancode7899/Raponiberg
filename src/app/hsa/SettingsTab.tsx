"use client";

import { btn, Card, Field, inputCls } from "@/components/ui/kit";
import { formatPercentRatio } from "@/lib/formatMoney";
import type { HsaReport } from "@/lib/hsa/report";
import type { HsaSettings } from "@/lib/hsa/store";
import { useEffect, useState } from "react";
import type { Send } from "./HsaClient";

const pct = (v: number | null) => (v == null ? "" : String(+(v * 100).toFixed(2)));
const ratio = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s) / 100);

export function SettingsTab({ r, send }: { r: HsaReport; send: Send }) {
  const [opened, setOpened] = useState(r.settings.openedOn ?? "");
  const [growth, setGrowth] = useState(pct(r.settings.growthRate));
  const [marginal, setMarginal] = useState(pct(r.settings.marginalRate));
  const [plan, setPlan] = useState(r.settings.planYear ? String(r.settings.planYear) : "");
  useEffect(() => {
    setOpened(r.settings.openedOn ?? "");
    setGrowth(pct(r.settings.growthRate));
    setMarginal(pct(r.settings.marginalRate));
    setPlan(r.settings.planYear ? String(r.settings.planYear) : "");
  }, [r.settings]);

  const save = () => {
    const settings: HsaSettings = { openedOn: opened || null, growthRate: ratio(growth), marginalRate: ratio(marginal), planYear: plan ? Number(plan) : null };
    void send({ op: "settings", settings });
  };
  const thisYear = Number(r.today.slice(0, 4));

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
          <input type="date" className={inputCls} value={opened} onChange={(e) => setOpened(e.target.value)} />
        </Field>
        <Field
          label="Growth rate (% a year)"
          hint={`Blank: ${r.hsa.measuredReturn != null ? `your HSA's measured return (${formatPercentRatio(r.hsa.measuredReturn, 1)})` : "7%, as no HSA return can be measured yet"}.`}
        >
          <input className={`${inputCls} num text-right`} inputMode="decimal" value={growth} onChange={(e) => setGrowth(e.target.value)} placeholder={pct(r.hsa.measuredReturn ?? 0.07)} />
        </Field>
        <Field label="Marginal tax rate (%)" hint={`Federal + state on your next dollar. Blank: ${r.growth.marginalSource === "RETIREMENT" ? "from the Account limits page" : "32%"}.`}>
          <input className={`${inputCls} num text-right`} inputMode="decimal" value={marginal} onChange={(e) => setMarginal(e.target.value)} placeholder={pct(r.growth.marginalSource === "SETTING" ? 0.32 : r.growth.marginalRate)} />
        </Field>
        <Field label="Reimburse the backlog in" hint="The year you expect to draw the receipts down (retirement, a big purchase). Blank: 20 years out.">
          <input className={`${inputCls} num text-right`} inputMode="numeric" value={plan} onChange={(e) => setPlan(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder={String(thisYear + 20)} />
        </Field>
      </div>
    </Card>
  );
}
