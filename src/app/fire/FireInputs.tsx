"use client";

import { Field, MoneyInput, PercentInput } from "@/components/ui/kit";
import type { Forecast } from "@/lib/forecast/forecast";
import type { OutlookSeeds } from "@/lib/profile/basePay";
import type { OutlookAssumptions } from "@/lib/profile/settings";
import Link from "next/link";
import type { ReactNode } from "react";
import type { SetAssumption } from "@/app/forecast/ForecastInputs";
import { YearInput } from "@/app/forecast/forecastUi";
import { pct, short, usd } from "./ui";

/**
 * FIRE's own settings — how you'd retire on the forecast: walk-away year, withdrawal
 * rate, tax on draws, the Coast target age, Barista income, stress-test swings. Pay,
 * bonuses, living cost and returns are the forecast's and are only shown here, with a
 * link to change them on the Forecast page.
 */
export function FireInputs({ s, a, set, f, header }: { s: OutlookSeeds; a: OutlookAssumptions; set: SetAssumption; f: Forecast; header: ReactNode }) {
  const est = a.bonus.estimates === "NONE" ? "no estimates" : a.bonus.estimates === "NEXT_PAYOUT" ? "estimated from next payout" : `estimated from ${f.nearTermThrough + 1}`;
  return (
    <aside className="app-scroll order-last min-w-0 rounded-lg border border-line bg-surface shadow-[var(--shadow)] lg:sticky lg:top-14 lg:order-first lg:max-h-[calc(100dvh-4.5rem)] lg:overflow-y-auto">
      {header}
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-fg">The forecast</span>
          <Link href="/forecast" className="text-[11px] text-accent hover:underline">
            Change on Forecast →
          </Link>
        </div>
        <table className="mt-1.5 w-full text-[11px] text-fg-2">
          <tbody>
            {(
              [
                ["Starts from", `${short(s.start.liquid + s.start.illiquid)} on ${s.start.asOf}`],
                ["Base salary", `${usd(f.pay.salary)} · +${pct(a.salaryGrowth)}/yr`],
                ["Kept after tax", pct(f.pay.takeHomeRate)],
                ["Bonuses", `paid + letters · ${est}`],
                ["Living cost", `${usd(f.pay.living.cents)} · +${pct(a.livingGrowth)}/yr`],
                ["Return · inflation", `${pct(a.returnRate)} · ${pct(a.inflation)}`],
                ["One-offs", a.plannedExpenses.length ? `${a.plannedExpenses.length} planned` : "none"],
              ] as [string, string][]
            ).map(([k, v]) => (
              <tr key={k}>
                <td className="py-0.5 pr-2 text-muted">{k}</td>
                <td className="num py-0.5 text-right">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3">
        <span className="text-xs font-semibold text-accent">Retiring on it</span>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label="Walk-away year" hint="stop working Jan 1; blank = keep working">
            <YearInput value={a.walkAwayYear} min={s.start.year + 1} onChange={(v) => set("walkAwayYear", v)} />
          </Field>
          <Field label="Withdrawal rate" hint="of Jan 1 net worth">
            <PercentInput value={a.withdrawalRate} onChange={(v) => set("withdrawalRate", v)} />
          </Field>
          <Field label="State tax on draws" hint="federal uses brackets">
            <PercentInput value={a.stateTaxRate} onChange={(v) => set("stateTaxRate", v)} />
          </Field>
          <Field label="Retirement age" hint="Coast FIRE target">
            <YearInput value={a.retirementAge} min={40} max={80} onChange={(v) => v != null && set("retirementAge", v)} />
          </Field>
          <Field label="Yearly swings" hint="stress test (std. dev.)">
            <PercentInput value={a.volatility} onChange={(v) => set("volatility", v)} />
          </Field>
          <Field label="Barista income / mo" hint="part-time, after tax, today's $">
            <MoneyInput size="xs" cents={a.baristaMonthly} allowNegative={false} onChange={(v) => set("baristaMonthly", v ?? 0)} />
          </Field>
        </div>
      </div>
    </aside>
  );
}
