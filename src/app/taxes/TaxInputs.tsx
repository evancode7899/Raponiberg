"use client";

import { buttonPrimary, buttonSecondary, Card } from "@/components/ledger/LedgerBits";
import { ACCOUNT_KIND_LABEL, ACCOUNT_TAX_KINDS, type AccountTaxKind } from "@/lib/tax/facts/investments";
import {
  DEFAULT_PAY_FORECAST,
  EMPTY_EXTRAS,
  NY_CITY_KINDS,
  NY_STATE_KINDS,
  type NyResidency,
  type PayForecast,
  type PersonExtras,
  type Residency,
  type TaxProfile,
  type YearInputs,
} from "@/lib/tax/profile";
import { inputCls, PercentInput, selectCls } from "@/components/ui/kit";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { TaxResponse } from "./TaxClient";
import { formatDate, MoneyField, NullableMoneyField, usd } from "./taxUi";

const EXTRA_FIELDS: [keyof PersonExtras, string, string?][] = [
  ["expectedBonus", "Extra bonus not in the Forecast", "Gross, paid by the current employer before Dec 31, on top of what the Forecast already expects."],
  ["otherIncome", "Other taxable income", "Freelance, prizes, taxable state refunds, Schedule 1 line 8z…"],
  ["extraInterest", "Interest not in the statements", "An account the app doesn't track, or a 1099-INT it can't read"],
  [
    "usObligationIncome",
    "State-exempt US government interest",
    "Treasury or government money-fund income, already counted in interest or dividends, that New York and Connecticut don't tax (IT-201 line 28, CT Schedule 1 line 41).",
  ],
  ["extraShortTermGain", "Expected short-term gains (more sales)", "Gains (or losses, negative) from sales not yet on a statement."],
  ["extraLongTermGain", "Expected long-term gains (more sales)"],
  ["capitalLossCarryover", "Capital loss carried in from last year", "From last year's Schedule D carryover worksheet."],
  ["iraBasisCarryforward", "Non-deductible IRA basis from earlier years", "Form 8606 line 14 of last year's return."],
  ["hsaOutsidePayroll", "HSA contributions outside payroll"],
  ["otherAdjustments", "Other above-the-line deductions"],
  ["otherStateTax", "Tax owed to a state other than NY", "New York is worked out from the W-2s and stubs. Any other state's tax goes here: it's added to the total and credited against CT tax."],
  ["estimatedFederalExtra", "Federal estimated payments not in the ledger"],
  ["estimatedCtExtra", "CT estimated payments not in the ledger"],
];

/** Everything the statements can't tell: household, last year's return, extras, deductions. */
export function TaxInputs({ r, onSave }: { r: TaxResponse; onSave: (p: TaxProfile) => Promise<void> }) {
  const [draft, setDraft] = useState<TaxProfile>(() => withYear(r.profile, r.year, r.inputs));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "warn"; text: string } | null>(null);
  useEffect(() => setDraft(withYear(r.profile, r.year, r.inputs)), [r.profile, r.year, r.inputs]);
  const y = draft.years[String(r.year)]!;
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(withYear(r.profile, r.year, r.inputs)), [draft, r]);

  const update = (f: (p: TaxProfile, y: YearInputs) => void) =>
    setDraft((d) => {
      const next = structuredClone(d);
      f(next, next.years[String(r.year)]!);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await onSave(draft);
      setMsg({ tone: "good", text: "Saved — figures recalculated." });
    } catch (e) {
      setMsg({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  // A year that isn't proven has no report figures, but its inputs stay editable.
  const accounts = r.blocked ? [] : r.accounts;

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-[46px] z-10 shadow-sm flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
        <button type="button" className={buttonPrimary} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save & recalculate"}
        </button>
        <button type="button" className={buttonSecondary} disabled={!dirty || saving} onClick={() => setDraft(withYear(r.profile, r.year, r.inputs))}>
          Discard changes
        </button>
        {msg && <span className={`text-xs ${msg.tone === "good" ? "text-pos" : "text-neg"}`}>{msg.text}</span>}
      </div>

      <Card
        title="Household"
        subtitle="Names (matched against pay stubs and brokerage owner lines), dependents and who claims them when filing separately are household settings."
        actions={
          <Link href="/settings?tab=household" className={buttonSecondary}>
            Edit in Settings
          </Link>
        }
      >
        <p className="text-xs text-fg-2">
          {draft.persons.map((p) => p.name).join(" & ")}
          {draft.dependents.length ? ` · dependents: ${draft.dependents.map((d) => `${d.name} (${d.birthYear})`).join(", ")}` : " · no dependents"}
        </p>
      </Card>

      <PriorYearCard
        r={r}
        typed={y.priorYear}
        onChange={(k, c) => update((_, yy) => void (yy.priorYear[k] = c))}
      />

      <ResidencyCard
        year={r.year}
        residency={y.residency}
        effective={r.blocked ? null : r.residency}
        onChange={(res) => update((_, yy) => void (yy.residency = res))}
      />

      <NyResidencyCard
        year={r.year}
        residency={y.nyResidency}
        effective={r.blocked ? null : r.ny}
        onChange={(res) => update((_, yy) => void (yy.nyResidency = res))}
      />

      {r.blocked || !r.documents?.filed.federal ? (
        <Card
          title={`Filed ${r.year} return (optional)`}
          subtitle="Once you file, put the return in the tax documents folder and the Filed return tab checks the app against it line by line. Until then, you can type what you owed (positive) or got back (negative)."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <NullableMoneyField
              label="Federal owed (+) / refund (−)"
              cents={y.actual.federalBalance}
              onChange={(c) => update((_, yy) => void (yy.actual.federalBalance = c))}
            />
            <NullableMoneyField label="Connecticut owed (+) / refund (−)" cents={y.actual.ctBalance} onChange={(c) => update((_, yy) => void (yy.actual.ctBalance = c))} />
          </div>
        </Card>
      ) : null}

      {draft.persons.map((p) => {
        const person = y.people[p.id] ?? { extras: { ...EMPTY_EXTRAS }, pay: { ...DEFAULT_PAY_FORECAST } };
        const rp = r.blocked ? undefined : r.people.find((x) => x.id === p.id);
        const job = rp?.payroll.find((e) => e.active);
        const fc = rp?.fromForecast ?? null;
        const setPay = (f: (pay: PayForecast) => void) =>
          update((_, yy) => {
            yy.people[p.id] ??= { extras: { ...EMPTY_EXTRAS }, pay: { ...DEFAULT_PAY_FORECAST } };
            f(yy.people[p.id]!.pay);
          });
        return (
          <Card key={p.id} title={`${p.name}: ${r.year} extras`}>
            {(r.blocked || r.isCurrentYear) && (
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                {fc ? (
                  <div className="flex min-w-0 flex-col gap-1 text-xs">
                    <span className="font-medium text-fg-2">From the Forecast</span>
                    <span className="text-fg">
                      Rest of year paid at the {fc.paycheck === "TYPICAL" ? "typical recent" : "latest"} paycheck
                      {fc.paycheck === "TYPICAL" ? (job?.typicalRegular ? ` (${usd(job.typicalRegular.amounts.gross)} gross)` : "") : job?.latestRegular ? ` (${usd(job.latestRegular.amounts.gross)} gross)` : ""}
                      {fc.bonus > 0 ? `, plus ${usd(fc.bonus)} of bonus still expected` : ", no more bonus expected"}.
                    </span>
                    {fc.items.length > 0 && <span className="text-faint">{fc.items.map((b) => `${b.label}: ${usd(b.gross)}`).join("; ")}</span>}
                    <Link href="/forecast" className="text-accent hover:underline">
                      Change on the Forecast page →
                    </Link>
                  </div>
                ) : (
                  <label className="flex min-w-0 flex-col gap-1 text-xs">
                    <span className="font-medium text-fg-2">Rest of year paid at</span>
                    <select
                      className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm"
                      value={person.pay.paycheck}
                      onChange={(e) => setPay((pay) => void (pay.paycheck = e.target.value === "TYPICAL" ? "TYPICAL" : "LATEST"))}
                    >
                      <option value="LATEST">
                        Latest paycheck{job?.latestRegular ? ` (${usd(job.latestRegular.amounts.gross)} gross, ${formatDate(job.latestRegular.payDate)})` : ""}
                      </option>
                      <option value="TYPICAL">
                        Typical recent paycheck{job?.typicalRegular ? ` (${usd(job.typicalRegular.amounts.gross)} gross)` : ""}
                      </option>
                    </select>
                    <span className="text-faint">Typical = median of the last six regular paychecks. Pick it when the latest was a one-off (unpaid leave, short hours).</span>
                  </label>
                )}
                <label className="flex min-w-0 flex-col gap-1 text-xs">
                  <span className="font-medium text-fg-2">Last paycheck this year (if the job ends)</span>
                  <input
                    type="date"
                    className="w-44 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm"
                    min={`${r.year}-01-01`}
                    max={`${r.year}-12-31`}
                    value={person.pay.payThrough ?? ""}
                    onChange={(e) => setPay((pay) => void (pay.payThrough = e.target.value || null))}
                  />
                  <span className="text-faint">Leave empty to keep paying through December 31.</span>
                </label>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {EXTRA_FIELDS.map(([k, label, help]) => (
                <MoneyField
                  key={k}
                  label={label}
                  help={help}
                  cents={person.extras[k]}
                  allowNegative={k === "extraShortTermGain" || k === "extraLongTermGain"}
                  onChange={(c) =>
                    update((_, yy) => {
                      yy.people[p.id] ??= { extras: { ...EMPTY_EXTRAS }, pay: { ...DEFAULT_PAY_FORECAST } };
                      yy.people[p.id]!.extras[k] = c;
                    })
                  }
                />
              ))}
            </div>
          </Card>
        );
      })}

      <Card title="Household deductions and credits" subtitle={`Paid during ${r.year}. Used if itemizing beats the standard deduction, and for the dependent-care credit.`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MoneyField label="Mortgage interest (1098)" cents={y.household.mortgageInterest} onChange={(c) => update((_, yy) => void (yy.household.mortgageInterest = c))} />
          <MoneyField label="Property tax (home, car)" cents={y.household.propertyTax} onChange={(c) => update((_, yy) => void (yy.household.propertyTax = c))} />
          <MoneyField label="Charitable gifts — cash" cents={y.household.charitableCash} onChange={(c) => update((_, yy) => void (yy.household.charitableCash = c))} />
          <MoneyField label="Charitable gifts — other" cents={y.household.charitableOther} onChange={(c) => update((_, yy) => void (yy.household.charitableOther = c))} />
          <MoneyField
            label="Childcare / daycare paid"
            help="Child and dependent care credit (joint filers only); dependent-care FSA amounts are subtracted."
            cents={y.household.dependentCareExpenses}
            onChange={(c) => update((_, yy) => void (yy.household.dependentCareExpenses = c))}
          />
        </div>
      </Card>

      <Card title="Investment assumptions">
        <div className="grid gap-3 sm:grid-cols-2">
          <PercentField
            label="Fund and stock dividends that are qualified"
            help="Money-market and bond funds are always ordinary. Broad US index ETFs are typically ~100% qualified; international funds less. Your 1099-DIV has the exact figure."
            value={draft.qualifiedDividendShare}
            onChange={(v) => update((d) => void (d.qualifiedDividendShare = v))}
          />
          <PercentField
            label="Money-market dividends from US obligations (CT-exempt)"
            help="Fidelity publishes this percentage for its government money market fund each January."
            value={draft.moneyMarketUsGovShare}
            onChange={(v) => update((d) => void (d.moneyMarketUsGovShare = v))}
          />
        </div>
        {accounts.length > 0 && (
          <>
            <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Investment accounts</h3>
            <p className="mb-2 text-xs text-muted">
              Type decides how an account&apos;s income is taxed; change it when the statement&apos;s wording isn&apos;t recognized. A UTMA/UGMA account&apos;s income is the
              child&apos;s, not yours.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {accounts.map((a) => {
                const kind = draft.accountKinds[a.accountNumber] ?? a.statementKind;
                return (
                  <div key={a.accountNumber} className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate" title={`${a.ownerLine} · ${a.accountNumber}`}>
                      {a.label}
                    </span>
                    <span className="flex items-center gap-1">
                      <select
                        aria-label={`${a.label} type`}
                        className={`rounded-md border bg-surface px-2 py-1 text-xs ${kind === "OTHER" ? "border-neg text-neg" : "border-line-strong"}`}
                        value={draft.accountKinds[a.accountNumber] ?? ""}
                        onChange={(e) =>
                          update((d) => {
                            if (e.target.value) d.accountKinds[a.accountNumber] = e.target.value as AccountTaxKind;
                            else delete d.accountKinds[a.accountNumber];
                          })
                        }
                      >
                        <option value="">{a.statementKind === "OTHER" ? "Unrecognized — choose" : `${ACCOUNT_KIND_LABEL[a.statementKind]} (statement)`}</option>
                        {ACCOUNT_TAX_KINDS.filter((k) => k !== "OTHER" && k !== a.statementKind).map((k) => (
                          <option key={k} value={k}>
                            {ACCOUNT_KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      {kind === "CUSTODIAL" ? (
                        <span className="px-2 text-xs text-muted">
                          {a.child ?? draft.dependents.find((d) => a.ownerLine.toUpperCase().includes(d.name.toUpperCase()))?.name ?? "Child"}&apos;s
                        </span>
                      ) : (
                        <select
                          aria-label={`${a.label} owner`}
                          className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs"
                          value={draft.accountOwners[a.accountNumber] ?? (a.ownerId === "CHILD" ? draft.persons[0]!.id : a.ownerId)}
                          onChange={(e) => update((d) => void (d.accountOwners[a.accountNumber] = e.target.value))}
                        >
                          {draft.persons.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                          <option value="JOINT">Joint</option>
                        </select>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <Card title="Sources and assumptions">
        <ul className="list-disc space-y-1 pl-4 text-xs text-fg-2">
          {(r.blocked ? [] : [...r.paramsNotes, ...r.assumptions]).map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function withYear(profile: TaxProfile, year: number, inputs: YearInputs): TaxProfile {
  const p = structuredClone(profile);
  p.years[String(year)] = structuredClone(inputs);
  return p;
}

function PercentField({ label, help, value, onChange }: { label: string; help?: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span className="font-medium text-fg-2" title={help}>
        {label}
        {help && <span className="ml-1 cursor-help text-faint">ⓘ</span>}
      </span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          max={100}
          className="w-24 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm tabular-nums"
          value={Math.round(value * 100)}
          onChange={(e) => onChange(Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100)}
        />
        <span className="text-muted">%</span>
      </div>
    </label>
  );
}

const RESIDENCY_LABEL: Record<Residency["ct"], string> = {
  FULL: "Full-year resident (CT-1040)",
  PART_YEAR: "Part-year resident (CT-1040NR/PY)",
  NONRESIDENT: "Nonresident (CT-1040NR/PY)",
};

/**
 * Connecticut residency for the year. Left on "automatic", a filed part-year CT return in
 * the tax documents folder (and New York's move date) decides it; otherwise full-year.
 */
/**
 * Last year's figures for the safe harbor: read from last year's filed return (tax
 * documents folder), else the app's own estimate of last year. Typing a figure overrides it.
 */
function PriorYearCard({
  r,
  typed,
  onChange,
}: {
  r: TaxResponse;
  typed: YearInputs["priorYear"];
  onChange: (k: keyof YearInputs["priorYear"], cents: number | null) => void;
}) {
  const auto = r.blocked ? null : r.priorYear;
  const source = r.blocked ? "NONE" : r.priorYearSource;
  const anyTyped = typed.federalTotalTax != null || typed.federalAgi != null || typed.ctTotalTax != null;
  const [editing, setEditing] = useState(anyTyped);
  const where =
    source === "FILED" || source === "ENTERED"
      ? auto?.file
        ? `Read from ${auto.file.split("/").at(-1)}`
        : "From the filed return"
      : source === "ESTIMATED"
        ? `This app's estimate of ${r.year - 1} — no filed ${r.year - 1} return is in the tax documents folder yet`
        : `No ${r.year - 1} return in the tax documents folder`;
  const tiles: { k: keyof YearInputs["priorYear"]; label: string; value: number | null }[] = [
    { k: "federalTotalTax", label: "Federal total tax (1040 line 24)", value: typed.federalTotalTax ?? auto?.federalTax ?? null },
    { k: "federalAgi", label: "Federal AGI (1040 line 11)", value: typed.federalAgi ?? auto?.federalAgi ?? null },
    { k: "ctTotalTax", label: "Connecticut income tax", value: typed.ctTotalTax ?? auto?.ctTax ?? null },
  ];
  return (
    <Card
      title={`Last year's return (${r.year - 1})`}
      subtitle="Used for the safe harbor: paying 100% of last year's tax (110% when last year's AGI was over $150,000) through withholding avoids any underpayment penalty."
      actions={
        <button type="button" className={buttonSecondary} onClick={() => setEditing((e) => !e)}>
          {editing ? "Hide overrides" : "Override"}
        </button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.k} className="min-w-0 rounded-md border border-line bg-surface-2 px-3 py-2">
            <div className="text-[11px] font-medium text-muted">{t.label}</div>
            <div className="num mt-0.5 text-lg font-semibold text-fg">{usd(t.value)}</div>
            <div className="mt-0.5 truncate text-[11px] text-faint" title={typed[t.k] != null ? "Typed under Override" : where}>
              {typed[t.k] != null ? "Typed under Override" : t.value == null ? "—" : t.k === "ctTotalTax" && auto?.ctFile ? `Read from ${auto.ctFile.split("/").at(-1)}` : where}
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
          {tiles.map((t) => (
            <NullableMoneyField key={t.k} label={`Override: ${t.label}`} cents={typed[t.k]} onChange={(c) => onChange(t.k, c)} />
          ))}
          <p className="text-xs text-muted sm:col-span-3">Leave blank to use the figure read from the return. Only needed if the folder doesn&apos;t have it or it was amended.</p>
        </div>
      )}
    </Card>
  );
}

const NY_STATE_LABEL: Record<NyResidency["state"], string> = {
  NONE: "No New York return",
  RESIDENT: "Full-year resident (IT-201)",
  PART_YEAR: "Part-year resident (IT-203)",
  NONRESIDENT: "Nonresident with NY income (IT-203)",
};
const NY_CITY_LABEL: Record<NyResidency["city"], string> = { NONE: "Not a City resident", RESIDENT: "Full-year City resident", PART_YEAR: "Part-year City resident" };

function NyResidencyCard({
  year,
  residency,
  effective,
  onChange,
}: {
  year: number;
  residency: NyResidency | null;
  effective: (NyResidency & { source: string }) | null;
  onChange: (r: NyResidency | null) => void;
}) {
  const r = residency;
  const set = (patch: Partial<NyResidency>) => onChange({ state: "NONE", city: "NONE", movedOut: null, ...r, ...patch });
  const from = effective?.source === "FILED_RETURN" ? "from the filed New York return" : effective?.source === "INPUTS" ? "as entered here" : "from New York withholding on the W-2s and stubs";
  return (
    <Card
      title={`New York residency (${year})`}
      subtitle={
        effective
          ? `In use: ${NY_STATE_LABEL[effective.state]}${effective.movedOut ? ` until ${effective.movedOut}` : ""}; ${NY_CITY_LABEL[effective.city].toLowerCase()} — ${from}.`
          : "No New York return this year: nothing filed and no New York withholding."
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="font-medium text-fg-2">New York State</span>
          <select className={selectCls} value={r?.state ?? "AUTO"} onChange={(e) => (e.target.value === "AUTO" ? onChange(null) : set({ state: e.target.value as NyResidency["state"] }))}>
            <option value="AUTO">Automatic (filed return, else withholding)</option>
            {NY_STATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {NY_STATE_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {r && (r.state === "RESIDENT" || r.state === "PART_YEAR") && (
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="font-medium text-fg-2">New York City</span>
            <select className={selectCls} value={r.city} onChange={(e) => set({ city: e.target.value as NyResidency["city"] })}>
              {NY_CITY_KINDS.filter((k) => r.state === "RESIDENT" || k !== "RESIDENT").map((k) => (
                <option key={k} value={k}>
                  {NY_CITY_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        {r?.state === "PART_YEAR" && (
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="font-medium text-fg-2">Moved out of New York on</span>
            <input type="date" className={inputCls} value={r.movedOut ?? ""} onChange={(e) => set({ movedOut: e.target.value || null })} />
          </label>
        )}
      </div>
    </Card>
  );
}

function ResidencyCard({
  year,
  residency,
  effective,
  onChange,
}: {
  year: number;
  residency: Residency | null;
  effective: (Residency & { source: string }) | null;
  onChange: (r: Residency | null) => void;
}) {
  const r = residency;
  const set = (patch: Partial<Residency>) => onChange({ ct: "FULL", movedIn: null, investmentShare: null, sourceIncome: null, ...r, ...patch });
  return (
    <Card
      title={`Connecticut residency (${year})`}
      subtitle={
        effective
          ? `In use: ${RESIDENCY_LABEL[effective.ct]}${effective.movedIn ? ` from ${effective.movedIn}` : ""}${effective.ct === "PART_YEAR" ? `, ${Math.round((effective.investmentShare ?? 0) * 1000) / 10}% of investment income` : ""} — ${effective.source === "FILED_RETURN" ? "from the filed return" : effective.source === "INPUTS" ? "as entered here" : "the default"}.`
          : "A part-year resident is taxed only on income earned while living in Connecticut."
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="font-medium text-fg-2">Residency</span>
          <select className={selectCls} value={r?.ct ?? "AUTO"} onChange={(e) => (e.target.value === "AUTO" ? onChange(null) : set({ ct: e.target.value as Residency["ct"] }))}>
            <option value="AUTO">Automatic (filed return, else full-year)</option>
            {(Object.keys(RESIDENCY_LABEL) as Residency["ct"][]).map((k) => (
              <option key={k} value={k}>
                {RESIDENCY_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {r?.ct === "PART_YEAR" && (
          <>
            <label className="flex min-w-0 flex-col gap-1 text-xs">
              <span className="font-medium text-fg-2">Moved to Connecticut on</span>
              <input type="date" className={inputCls} value={r.movedIn ?? ""} onChange={(e) => set({ movedIn: e.target.value || null })} />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs">
              <span className="font-medium text-fg-2" title="Blank: the filed CT-1040AW's share, else the share of the year after the move.">
                Investment income earned as a resident <span className="cursor-help text-faint">ⓘ</span>
              </span>
              <PercentInput value={r.investmentShare ?? effective?.investmentShare ?? 0} onChange={(v) => set({ investmentShare: v })} />
            </label>
          </>
        )}
        {r && r.ct !== "FULL" && (
          <NullableMoneyField label="CT-source income override (CT-SI line 30)" cents={r.sourceIncome} onChange={(c) => set({ sourceIncome: c })} />
        )}
      </div>
    </Card>
  );
}
