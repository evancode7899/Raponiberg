"use client";

import { buttonPrimary, Card, Segmented } from "@/components/ledger/LedgerBits";
import { inputCls, MoneyInput, selectCls } from "@/components/ui/kit";
import { formatUsdCents } from "@/lib/formatMoney";
import { CT_W4_CODES, DEFAULT_PAY_FORECAST, EMPTY_EXTRAS, type CtW4Code, type TaxProfile, type W4OnFile } from "@/lib/tax/profile";
import { planW4, type W4Balance, type W4PersonPlan } from "@/lib/tax/w4";
import { useMemo, useState, type ReactNode } from "react";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { BalanceBadge, Callout, EstimateValue, formatDate, NumberTable, usd } from "./taxUi";

const STATUS: Record<W4OnFile["filingStatus"], string> = { SINGLE: "Single or Married filing separately", MFJ: "Married filing jointly", HOH: "Head of household" };
/** Each person's latest pay stub received, per year: kept in this browser (it's a working note, not a figure). */
const PAID_STORE = "pf-w4-paid-through";
const FREQ: Record<string, string> = { WEEKLY: "weekly", BIWEEKLY: "every two weeks", SEMIMONTHLY: "twice a month", MONTHLY: "monthly" };

/** A form amount to the cent; zero is "$0", not a dash: it's what goes on the line. */
const amt = (cents: number) => (cents === 0 ? "$0" : formatUsdCents(cents));
const exact = (cents: number) => (Math.abs(cents) < 1 ? "$0.00" : `${cents > 0 ? "Owe" : "Refund"} ${formatUsdCents(Math.abs(cents)).replace(/[()]/g, "")}`);

/**
 * Taxes › W-4: every line of each person's W-4 and CT-W4 so the joint return lands at
 * $0 owed and $0 refunded, from the stubs to date, payments made and the forecast for the
 * rest of the year (lib/tax/w4). Each person's latest stub received (often past the data
 * edge) says which paychecks are already paid; it's kept in this browser only.
 */
export function TaxW4({ r, onSave }: { r: TaxResponse; onSave: (p: TaxProfile) => Promise<void> }) {
  const [tooSoon, setTooSoon] = useState<"0" | "1" | "2">("1");
  // { year: { personId: latest stub received } }. The tab renders only once the report has loaded in the browser.
  const [received, setReceived] = useState<Record<string, Record<string, string>>>(() => {
    try {
      return JSON.parse(localStorage.getItem(PAID_STORE) ?? "{}") as Record<string, Record<string, string>>;
    } catch {
      return {};
    }
  });
  const paidThrough = useMemo(() => received[r.year] ?? {}, [received, r.year]);
  const setPaid = (personId: string, date: string) =>
    setReceived((cur) => {
      const year = { ...cur[r.year] };
      if (date) year[personId] = date;
      else delete year[personId];
      const next = { ...cur, [r.year]: year };
      try {
        localStorage.setItem(PAID_STORE, JSON.stringify(next));
      } catch {
        // Not kept past this visit; the plan still uses it.
      }
      return next;
    });
  const plan = useMemo(() => planW4(r, { tooSoonCount: Number(tooSoon), paidThrough }), [r, tooSoon, paidThrough]);

  if (!r.isCurrentYear) {
    return <Callout tone="info">A W-4 only changes paychecks still to come, so it&apos;s planned for the year in progress. Pick {r.today.slice(0, 4)} above.</Callout>;
  }
  if (!plan.people.length) {
    return <Callout tone="warn">No current employer with a regular paycheck on file for {r.year}, so there&apos;s no W-4 to set. Upload the latest pay stubs.</Callout>;
  }
  const reached = plan.reachedPaychecks;

  return (
    <div className="flex flex-col gap-4">
      <Card
        tone="overview"
        title={`W-4s for $0.00 in April ${r.year + 1}`}
        subtitle="Starts from what each paycheck withholds under the W-4 on file now, then moves only Step 4(c) or Step 3 (CT-W4 line 2 or 3), so the joint return neither owes nor refunds."
      >
        <div className="flex flex-col gap-2 px-4 pb-3 text-xs text-muted">
          {plan.people.map((p) => (
            <label key={p.personId} className="flex flex-wrap items-center gap-2">
              <span>{p.name}&apos;s latest pay stub received</span>
              <input
                type="date"
                className={`${inputCls} w-auto`}
                value={paidThrough[p.personId] ?? ""}
                min={p.latestStub}
                max={`${r.year}-12-31`}
                onChange={(e) => setPaid(p.personId, e.target.value)}
                aria-label={`${p.name}'s latest pay stub received`}
              />
              <span>
                {p.paidThroughEntered ? "Paid through" : "Not set: paid through"} {formatDate(p.paidThrough)}. Stubs on file stop at {formatDate(p.latestStub)}; the{" "}
                {p.sinceStub.length} paycheck{p.sinceStub.length === 1 ? "" : "s"} between are taken to withhold what that one did.
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-muted">
          <span>The new W-4 reaches</span>
          <Segmented
            ariaLabel="First paycheck the new W-4 reaches"
            size="xs"
            value={tooSoon}
            onChange={setTooSoon}
            options={[
              { value: "0", label: "the next paycheck", title: "Payroll applies it to the very next paycheck" },
              { value: "1", label: "the one after", title: "Payroll usually needs a cycle to apply a new W-4" },
              { value: "2", label: "two later" },
            ]}
          />
        </div>
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
          <Headline name="Federal" b={plan.federal} year={r.year} k="fed.balance" />
          <Headline name="Connecticut" b={plan.ct} year={r.year} k="ct.balance" />
        </div>
        <div className="flex flex-col gap-2 px-4 pb-4">
          {!reached && <Callout tone="warn">No paychecks are left this year for a new W-4 to reach. Settle the balance with an estimated payment by {formatDate(`${r.year + 1}-01-15`)}.</Callout>}
          {(plan.unreachable.federal > 0 || plan.unreachable.ct > 0) && reached > 0 && (
            <Callout tone="warn">
              The paychecks left can&apos;t take it all without going past take-home pay: pay{" "}
              {[plan.unreachable.federal > 0 && `${usd(plan.unreachable.federal)} to the IRS`, plan.unreachable.ct > 0 && `${usd(plan.unreachable.ct)} to Connecticut`].filter(Boolean).join(" and ")} as an
              estimated payment by {formatDate(`${r.year + 1}-01-15`)}.
            </Callout>
          )}
          {plan.people.some((p) => !p.onFileEntered) && (
            <p className="text-xs text-muted">
              {plan.people
                .filter((p) => !p.onFileEntered)
                .map((p) => `${p.name}'s`)
                .join(" and ")}{" "}
              W-4 on file isn&apos;t entered, so it&apos;s read as the stub&apos;s filing status with every other line blank. If a form on file has amounts, enter them below: the lines to set
              are worked out from them.
            </p>
          )}
        </div>
      </Card>

      {plan.people.map((p) => (
        <PersonW4 key={p.personId} p={p} r={r} onSave={onSave} />
      ))}

      <Card title="How the balance gets to $0" subtitle="The joint return projected to December 31: tax, less everything withheld or paid, under the W-4s on file now; then what the new ones change.">
        <div className="px-4 pb-4">
          <Reconcile federal={plan.federal} ct={plan.ct} people={plan.people} />
        </div>
      </Card>

      <Card title="Before you file them">
        <ul className="list-disc space-y-1.5 px-4 pb-4 pl-8 text-xs text-fg-2">
          <li>
            These amounts are for the rest of {r.year} only. In January, file a fresh W-4 and CT-W4 for {r.year + 1}: Step 3 and Step 4(c) here are sized to make up a whole year&apos;s gap over a few
            paychecks.
          </li>
          <li>Bonuses still to come are withheld at the flat 22% supplemental rate (and 6.99% for Connecticut), which a W-4 doesn&apos;t change; they&apos;re counted as they are.</li>
          <li>
            Paychecks after the latest stub on file are forecast at the same paycheck, including the ones already received past it: set each person&apos;s latest stub received above, and the
            new W-4 is spread over the paychecks after it. Upload newer stubs and the plan updates; so do the Forecast page&apos;s paycheck and bonus choices, and the Inputs tab&apos;s extras.
          </li>
          <li>Filing status, Step 2 and Steps 4(a)/(b) are kept as they are: changing them moves the base withholding by an amount only payroll&apos;s tables can say.</li>
        </ul>
      </Card>
    </div>
  );
}

function Headline({ name, b, year, k }: { name: string; b: W4Balance; year: number; k: "fed.balance" | "ct.balance" }) {
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="mb-1 text-xs font-medium text-muted">{name}</div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">On the W-4s now</span>
        <EstimateValue year={year} k={k} cents={b.balanceNow}>
          <BalanceBadge cents={b.balanceNow} />
        </EstimateValue>
        <span className="text-faint">→</span>
        <span className="text-muted">with the new ones</span>
        <span className="num font-semibold text-fg">{exact(b.balanceAfter)}</span>
      </div>
    </div>
  );
}

function PersonW4({ p, r, onSave }: { p: W4PersonPlan; r: TaxResponse; onSave: (p: TaxProfile) => Promise<void> }) {
  const on = p.onFile;
  const to = p.recommended;
  const yes = (b: boolean) => (b ? "Checked" : "Not checked");
  const cell = (now: ReactNode, next: ReactNode, changed: boolean) => [
    <span key="now" className="text-muted">
      {now}
    </span>,
    <span key="to" className={changed ? "font-semibold text-accent" : ""}>
      {changed ? next : "Keep"}
    </span>,
  ];
  const fedAfter = p.federalPerCheck + p.federalChange;
  const ctAfter = p.ctPerCheck + p.ctChange;
  return (
    <Card
      title={`${p.name}: W-4 and CT-W4 for ${p.employer}`}
      subtitle={`Paid ${FREQ[p.frequency] ?? p.frequency} (${p.periodsPerYear} pay periods a year). Latest stub on file ${formatDate(p.latestStub)}; paid through ${formatDate(p.paidThrough)}.`}
    >
      <div className="px-4 pb-4">
        <NumberTable
          columns={["On file now", "Set to"]}
          rows={[
            { label: "Form W-4 (federal)", values: [], heading: true },
            { label: "Step 1(c) Filing status", values: cell(STATUS[on.filingStatus], STATUS[to.filingStatus], false) },
            { label: "Step 2(c) Multiple jobs or spouse works", values: cell(yes(on.multipleJobs), yes(to.multipleJobs), false) },
            {
              label: "Step 3 Dependents and other credits",
              help: "An annual amount: payroll subtracts it ÷ pay periods per year from each paycheck's withholding.",
              values: cell(amt(on.credits), amt(to.credits), to.credits !== on.credits),
            },
            { label: "Step 4(a) Other income (not from jobs)", values: cell(amt(on.otherIncome), amt(to.otherIncome), false) },
            { label: "Step 4(b) Deductions", values: cell(amt(on.deductions), amt(to.deductions), false) },
            { label: "Step 4(c) Extra withholding per pay period", values: cell(amt(on.extraPerPaycheck), amt(to.extraPerPaycheck), to.extraPerPaycheck !== on.extraPerPaycheck) },
            { label: "Form CT-W4 (Connecticut)", values: [], heading: true },
            {
              label: "Line 1 Withholding code",
              help: "Married filing jointly with both spouses working and combined income over $100,500 is usually code A. Keep whichever code is on file; the amounts below are worked out from it.",
              values: cell(on.ct.code ?? "As on file", to.ct.code ?? "As on file", false),
            },
            { label: "Line 2 Additional withholding per pay period", values: cell(amt(on.ct.additional), amt(to.ct.additional), to.ct.additional !== on.ct.additional) },
            { label: "Line 3 Reduced withholding per pay period", values: cell(amt(on.ct.reduced), amt(to.ct.reduced), to.ct.reduced !== on.ct.reduced) },
            { label: "Each paycheck", values: [], heading: true },
            { label: "Federal income tax withheld", values: [formatUsdCents(p.federalPerCheck), <b key="f">{formatUsdCents(fedAfter)}</b>] },
            { label: "Connecticut income tax withheld", values: [formatUsdCents(p.ctPerCheck), <b key="c">{formatUsdCents(ctAfter)}</b>] },
          ]}
        />
        <p className="mt-2 text-xs text-muted">
          {p.reached.length ? (
            <>
              Reaches {p.reached.length} paycheck{p.reached.length === 1 ? "" : "s"}: {p.reached.map(formatDate).join(", ")}.
              {p.tooSoon.length > 0 && ` Too late for ${p.tooSoon.map(formatDate).join(", ")} (withheld as now).`}
            </>
          ) : (
            "No paychecks left this year for a new W-4 to reach."
          )}
        </p>
        <OnFileEditor p={p} r={r} onSave={onSave} />
      </div>
    </Card>
  );
}

/** What's on the W-4 and CT-W4 now, as entered (saved with the year's inputs). */
function OnFileEditor({ p, r, onSave }: { p: W4PersonPlan; r: TaxResponse; onSave: (p: TaxProfile) => Promise<void> }) {
  const [draft, setDraft] = useState<W4OnFile>(() => structuredClone(p.onFile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (f: (w: W4OnFile) => void) =>
    setDraft((d) => {
      const n = structuredClone(d);
      f(n);
      return n;
    });

  const save = async () => {
    const profile = structuredClone(r.profile);
    const key = String(r.year);
    const y = (profile.years[key] ??= structuredClone(r.inputs));
    y.people[p.personId] ??= { extras: { ...EMPTY_EXTRAS }, pay: { ...DEFAULT_PAY_FORECAST } };
    y.people[p.personId]!.w4 = draft;
    setSaving(true);
    setError(null);
    try {
      await onSave(profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const money = (label: string, cents: number, onChange: (c: number) => void) => (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span className="font-medium text-fg-2">{label}</span>
      <MoneyInput cents={cents} allowNegative={false} onChange={(c) => onChange(c ?? 0)} />
    </label>
  );

  return (
    <details className="mt-3 rounded-md border border-line px-3 py-2" open={!p.onFileEntered}>
      <summary className="cursor-pointer text-xs font-medium text-fg-2">{p.onFileEntered ? `${p.name}'s W-4s on file now` : `Enter ${p.name}'s W-4s on file now`}</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="font-medium text-fg-2">Step 1(c) Filing status</span>
          <select className={selectCls} value={draft.filingStatus} onChange={(e) => set((w) => void (w.filingStatus = e.target.value as W4OnFile["filingStatus"]))}>
            {Object.entries(STATUS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2 self-end pb-1.5 text-xs text-fg-2">
          <input type="checkbox" checked={draft.multipleJobs} onChange={(e) => set((w) => void (w.multipleJobs = e.target.checked))} />
          Step 2(c) checked
        </label>
        {money("Step 3 Credits (annual)", draft.credits, (c) => set((w) => void (w.credits = c)))}
        {money("Step 4(a) Other income", draft.otherIncome, (c) => set((w) => void (w.otherIncome = c)))}
        {money("Step 4(b) Deductions", draft.deductions, (c) => set((w) => void (w.deductions = c)))}
        {money("Step 4(c) Extra per paycheck", draft.extraPerPaycheck, (c) => set((w) => void (w.extraPerPaycheck = c)))}
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="font-medium text-fg-2">CT-W4 line 1 code</span>
          <select className={selectCls} value={draft.ct.code ?? ""} onChange={(e) => set((w) => void (w.ct.code = (e.target.value || null) as CtW4Code | null))}>
            <option value="">Not known</option>
            {CT_W4_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {money("CT-W4 line 2 Additional", draft.ct.additional, (c) => set((w) => void (w.ct.additional = c)))}
        {money("CT-W4 line 3 Reduced", draft.ct.reduced, (c) => set((w) => void (w.ct.reduced = c)))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className={buttonPrimary} disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <span className="text-xs text-muted">The withholding per paycheck comes from the latest stub either way; these only say which lines already hold amounts.</span>
        {error && <span className="text-xs text-warn">{error}</span>}
      </div>
    </details>
  );
}

function Reconcile({ federal, ct, people }: { federal: W4Balance; ct: W4Balance; people: W4PersonPlan[] }) {
  const row = (label: string, f: (b: W4Balance) => number, o: { strong?: boolean; indent?: boolean; help?: string; sign?: -1 } = {}) => {
    const v = (b: W4Balance) => (o.sign ?? 1) * f(b);
    if (!o.strong && f(federal) === 0 && f(ct) === 0) return null;
    return { label, values: [usd(v(federal)), usd(v(ct))], strong: o.strong, indent: o.indent, help: o.help };
  };
  const tooSoon = people.flatMap((p) => p.tooSoon).length;
  const rows = [
    row("Projected tax for the year", (b) => b.tax, { strong: true }),
    row("Withheld on the pay stubs on file", (b) => b.withheldStubs, { indent: true, sign: -1 }),
    row("Paychecks received since the stubs on file (forecast)", (b) => b.withheldSinceStub, { indent: true, sign: -1 }),
    tooSoon ? row("Paychecks before the new W-4 takes effect", (b) => b.withheldTooSoon, { indent: true, sign: -1 }) : null,
    row("Paychecks the new W-4 reaches, as withheld now", (b) => b.withheldReached, { indent: true, sign: -1 }),
    row("Bonuses still to come (flat supplemental rate)", (b) => b.withheldBonus, { indent: true, sign: -1 }),
    row("Other withholding (W-2s, earlier employers)", (b) => b.withheldOther, { indent: true, sign: -1 }),
    row("Estimated payments", (b) => b.estimates, { indent: true, sign: -1 }),
    row("Other payments and credits", (b) => b.otherCredits, { indent: true, sign: -1, help: "Additional Medicare tax withheld, excess Social Security withheld, refundable child tax credit." }),
  ].filter((x) => x != null);
  return (
    <NumberTable
      columns={["Federal", "Connecticut"]}
      rows={[
        ...rows,
        { label: "Owed (refund) on the W-4s now", values: [usd(federal.balanceNow), usd(ct.balanceNow)], strong: true },
        { label: "Change from the new W-4s", values: [usd(-federal.change), usd(-ct.change)], indent: true, help: "In brackets: withheld on top of today's W-4s. Without: given back." },
        { label: "Owed (refund) with the new W-4s", values: [exact(federal.balanceAfter), exact(ct.balanceAfter)], strong: true },
      ]}
    />
  );
}
