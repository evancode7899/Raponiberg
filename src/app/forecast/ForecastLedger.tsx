"use client";

import { Badge, Card, Segmented, table, usePersistentState } from "@/components/ui/kit";
import type { ScheduledBonus } from "@/lib/forecast/bonusSchedule";
import type { Forecast } from "@/lib/forecast/forecast";
import { monthPeriods, yearPeriods, type Flows, type Period } from "@/lib/forecast/periods";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import { useMemo, useState } from "react";
import { monthLabel, pct, usd } from "./forecastUi";

type Row = {
  label: string;
  help: string;
  get: (x: Flows) => number | null;
  /** Shown negated (outflows). */
  out?: boolean;
  kind?: "sum" | "total" | "sub";
  /** Hidden when zero in every column shown. */
  optional?: boolean;
  /** Red when negative. */
  warnNegative?: boolean;
};

const ROWS: Row[] = [
  { label: "Base salary", help: "Regular pay before tax. Actual: pay stubs. Forecast: the drivers' base salary, raised each January.", get: (x) => x.salary },
  { label: "Bonuses", help: "Gross. Actual: pay stubs. Forecast: the payments listed below (paid, on a letter, or estimated). Hover a cell for its payments.", get: (x) => x.bonus },
  { label: "Interest & other", help: "Actual only. The forecast counts interest and dividends in growth.", get: (x) => x.otherIncome, optional: true },
  {
    label: "Taxes & deductions",
    help: "Income tax, FICA and payroll deductions (health, FSA, after-tax). Actual: withheld + paid − refunds + deductions. Forecast: owed on base pay at the take-home rate, and on bonuses at the bonus keep rate.",
    get: (x) => x.taxes,
    out: true,
  },
  { label: "Employer 401(k) & HSA", help: "Employer money into retirement accounts.", get: (x) => x.employer },
  { label: "Living cost", help: "Everything spent except tagged one-offs.", get: (x) => x.living, out: true },
  { label: "Bonus spent", help: "The part of bonuses kept after tax that isn't saved (the Bonus saved driver).", get: (x) => x.bonusSpent, out: true, optional: true },
  { label: "One-offs", help: "Actual: tagged one-off expenses. Forecast: planned one-offs.", get: (x) => x.oneOffs, out: true, optional: true },
  { label: "Saved", help: "Income − taxes & deductions + employer money − spending.", get: (x) => x.saved, kind: "sum" },
  { label: "to retirement", help: "Your 401(k)/HSA deferrals + employer money.", get: (x) => x.toRetirement, kind: "sub" },
  {
    label: "to liquid",
    help: "What lands in (or leaves) cash and brokerage.",
    get: (x) => (x.saved == null || x.toRetirement == null ? null : x.saved - x.toRetirement),
    kind: "sub",
    warnNegative: true,
  },
  { label: "Growth & other", help: "Actual: the change in net worth not explained by cash saved (markets, outside money, gaps). Forecast: investment returns.", get: (x) => x.growth },
  { label: "Change in net worth", help: "Saved + growth = closing − opening net worth.", get: (x) => x.change, kind: "sum" },
  { label: "Net worth, end", help: "Balances at the end of the column: Dec 31, or the month shown.", get: (x) => x.close?.netWorth ?? null, kind: "total" },
  { label: "liquid", help: "Cash and brokerage, less card balances.", get: (x) => x.close?.liquid ?? null, kind: "sub", warnNegative: true },
  { label: "illiquid", help: "Retirement accounts, HSA, everything else.", get: (x) => x.close?.illiquid ?? null, kind: "sub" },
];

const SOURCE: Record<ScheduledBonus["source"], { label: string; tone: "pos" | "info" | "neutral" }> = {
  PAID: { label: "paid", tone: "pos" },
  LETTER: { label: "letter", tone: "info" },
  ESTIMATE: { label: "estimate", tone: "neutral" },
};

const keyLabel = (key: string) => monthLabel(Number(key.slice(0, 4)), Number(key.slice(5, 7)));
const inPeriod = (p: Period, key: string) => key >= p.from && key <= p.through.slice(0, 7);

/**
 * The forecast as one ledger. Columns: proven years, the year in progress as actual to date
 * + the forecast's rest of the year = the year, then forecast years (or one year's months).
 * Rows are the same everywhere, so every total is the sum of its parts and every column
 * walks from income to saved to the change in net worth.
 */
export function ForecastLedger({ f, r }: { f: Forecast; r: AnnualProfileReport }) {
  const lastYear = f.months.at(-1)?.year ?? f.plan.start.year;
  const [view, setView] = usePersistentState<{ span: "5" | "10" | "all"; units: "k" | "usd" }>("pf-forecast-ledger", () => ({ span: "5", units: "k" }));
  const { span, units } = view;
  const money = (c: number) => (units === "usd" ? usd(c) : thousands(c));
  const [monthsOf, setMonthsOf] = useState<number | null>(null);
  const firstYear = f.months[0]?.year ?? f.plan.start.year;
  const through = span === "all" ? lastYear : r.currentYear + Number(span);
  const periods = useMemo(
    () => (monthsOf != null ? monthPeriods(f, r, monthsOf) : yearPeriods(f, r, { actualYears: 1, throughYear: through })),
    [f, r, monthsOf, through],
  );
  const counted = f.schedule.filter((b) => b.counted);
  const rows = ROWS.filter((row) => !row.optional || periods.some((p) => (row.get(p.flows) ?? 0) !== 0));
  const nearTerm = (p: Period) => monthsOf == null && p.kind === "FORECAST" && p.nearTerm && f.assumptions.bonus.estimates === "AFTER_NEAR_TERM";
  const drill = (p: Period) => (p.kind !== "ACTUAL" && monthsOf == null ? () => setMonthsOf(p.year) : undefined);

  return (
    <Card
      title={monthsOf != null ? `${monthsOf}, month by month` : "Forecast ledger"}
      subtitle={
        monthsOf != null
          ? "Each month's flows; the last column is the whole year (same as its year column)."
          : "Income − taxes − spending = saved; saved + growth = change in net worth. Click a forecast year for its months."
      }
      actions={
        monthsOf != null ? (
          <span className="flex items-center gap-1">
            <button type="button" className="rounded px-1.5 text-muted hover:text-fg disabled:opacity-30" disabled={monthsOf <= firstYear} onClick={() => setMonthsOf(monthsOf - 1)} aria-label="Previous year">
              ‹
            </button>
            <span className="num text-xs font-medium text-fg">{monthsOf}</span>
            <button type="button" className="rounded px-1.5 text-muted hover:text-fg disabled:opacity-30" disabled={monthsOf >= lastYear} onClick={() => setMonthsOf(monthsOf + 1)} aria-label="Next year">
              ›
            </button>
            <button type="button" className="ml-1 rounded-md border border-line-strong px-2 py-0.5 text-[11px] text-fg-2 hover:bg-surface-2" onClick={() => setMonthsOf(null)}>
              Years
            </button>
          </span>
        ) : (
          <Segmented
            size="xs"
            ariaLabel="Years shown"
            value={span}
            onChange={(v) => setView({ ...view, span: v })}
            options={[
              { value: "5", label: "5 yrs" },
              { value: "10", label: "10 yrs" },
              { value: "all", label: `to ${lastYear}` },
            ]}
          />
        )
      }
    >
      <div className={table.wrap}>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line-strong">
              <th className="sticky left-0 z-[1] bg-surface px-2 py-1 text-left align-bottom font-normal">
                <Segmented
                  size="xs"
                  ariaLabel="Units"
                  value={units}
                  onChange={(v) => setView({ ...view, units: v })}
                  options={[
                    { value: "k", label: "$k", title: "Thousands of dollars (hover a cell for the exact figure)" },
                    { value: "usd", label: "$", title: "Whole dollars" },
                  ]}
                />
              </th>
              {periods.map((p) => {
                const onClick = drill(p);
                return (
                  <th key={p.id} className={`whitespace-nowrap px-1.5 py-1 text-right align-bottom ${colCls(p)}`} title={p.note ?? (onClick ? `Show ${p.year} month by month` : undefined)}>
                    {onClick ? (
                      <button type="button" className="num font-semibold text-fg hover:text-accent hover:underline" onClick={onClick}>
                        {p.label}
                      </button>
                    ) : (
                      <span className="num font-semibold text-fg">{p.label}</span>
                    )}
                    <div className={`text-[10px] font-normal ${p.kind === "ACTUAL" ? "text-pos" : p.kind === "TOTAL" ? "text-fg-2" : "text-muted"}`}>
                      {nearTerm(p) ? <span title="Near term: no estimated bonus (Bonuses › Estimate awards)">near term</span> : p.sub}
                      {p.note ? " *" : ""}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className={row.kind === "sum" ? "border-t border-line-strong" : row.kind === "total" ? "border-t-[3px] border-double border-line-strong" : "border-t border-line"}>
                <th
                  scope="row"
                  title={row.help}
                  className={`sticky left-0 z-[1] cursor-help whitespace-nowrap bg-surface py-[3px] pr-2 text-left font-normal ${
                    row.kind === "sub" ? "pl-5 text-muted" : row.kind ? "pl-2 font-semibold text-fg" : "pl-2 text-fg-2"
                  }`}
                >
                  {row.label}
                </th>
                {periods.map((p) => {
                  const v = row.get(p.flows);
                  const shown = v == null ? null : row.out ? -v : v;
                  const bonuses = row.label === "Bonuses" && p.kind !== "ACTUAL" ? counted.filter((b) => inPeriod(p, b.key)) : [];
                  return (
                    <td
                      key={p.id}
                      title={bonuses.length ? bonuses.map((b) => `${keyLabel(b.key)} · ${b.personName} · ${SOURCE[b.source].label} · ${usd(b.gross)}\n  ${b.label}`).join("\n") : undefined}
                      className={`num whitespace-nowrap px-1.5 py-[3px] text-right ${colCls(p)} ${row.kind === "sub" ? "text-muted" : row.kind ? "font-semibold text-fg" : "text-fg-2"} ${
                        row.warnNegative && shown != null && shown < 0 ? "!text-neg" : ""
                      }`}
                    >
                      {shown == null ? <span className="text-faint">—</span> : shown === 0 && !row.kind ? <span className="text-faint">0</span> : money(shown)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-line">
              <th scope="row" title="Saved ÷ (salary + bonuses + other income)." className="sticky left-0 z-[1] cursor-help bg-surface py-[3px] pl-2 pr-2 text-left font-normal text-muted">
                Savings rate
              </th>
              {periods.map((p) => {
                const x = p.flows;
                const gross = x.salary == null || x.bonus == null || x.otherIncome == null ? null : x.salary + x.bonus + x.otherIncome;
                return (
                  <td key={p.id} className={`num px-1.5 py-[3px] text-right text-muted ${colCls(p)}`}>
                    {gross && x.saved != null ? pct(x.saved / gross, 0) : "—"}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      {periods.some((p) => p.note) && <p className="mt-1.5 text-[11px] text-muted">* {periods.find((p) => p.note)!.note}</p>}
    </Card>
  );
}

/** Thousands of dollars from cents: 1,234 · (56) for outflows. */
const thousands = (c: number) => {
  const k = Math.round(Math.abs(c) / 100_000).toLocaleString("en-US");
  return c < 0 ? `(${k})` : k;
};

const colCls = (p: Period) => (p.kind === "ACTUAL" ? "bg-surface-2/70" : p.kind === "TOTAL" ? "border-x border-line-strong bg-accent-soft/40" : "");

/** Every bonus payment the forecast knows about in the next few years, counted or not. */
export function BonusPayments({ f, throughYear }: { f: Forecast; throughYear: number }) {
  const [all, setAll] = useState(false);
  const shown = f.schedule.filter((b) => b.key <= `${throughYear}-12` && (all || b.counted));
  const hidden = f.schedule.filter((b) => b.key <= `${throughYear}-12` && !b.counted).length;
  return (
    <Card
      title="Bonus payments"
      subtitle={`What the Bonuses row is made of, through ${throughYear}. Taxes reads the ones still to come this year. Kept after tax ${pct(f.pay.bonus.keepRate)}, saved ${pct(f.assumptions.bonus.savedShare, 0)} of that.`}
      actions={
        hidden > 0 ? (
          <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => setAll(!all)}>
            {all ? "Counted only" : `+${hidden} not counted`}
          </button>
        ) : undefined
      }
    >
      {shown.length === 0 ? (
        <p className="text-xs text-muted">None: no bonus paid since the start, none on a letter, and no estimate.</p>
      ) : (
        <div className={table.wrap}>
          <table className="w-full border-collapse text-xs">
            <tbody>
              {shown.map((b, i) => (
                <tr key={i} className={`border-t border-line first:border-t-0 ${b.counted ? "" : "text-muted"}`}>
                  <td className="num whitespace-nowrap py-[3px] pr-2">{keyLabel(b.key)}</td>
                  <td className="whitespace-nowrap pr-2">{b.personName}</td>
                  <td className="pr-2">
                    <Badge tone={SOURCE[b.source].tone}>{SOURCE[b.source].label}</Badge>
                  </td>
                  <td className="w-full pr-2 text-fg-2">
                    {b.label}
                    {!b.counted && b.why ? <span className="text-muted"> — not counted: {b.why}</span> : null}
                  </td>
                  <td className={`num whitespace-nowrap text-right ${b.counted ? "font-medium text-fg" : "line-through"}`}>{usd(b.gross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
