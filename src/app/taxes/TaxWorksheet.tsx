"use client";

import { buttonSecondary, Card, Segmented } from "@/components/ledger/LedgerBits";
import type { PersonReport } from "@/lib/tax/buildTaxReport";
import { computeReturn, type Dependent, type PersonIncome, type ReturnResult } from "@/lib/tax/computeReturn";
import { ZERO_AMOUNTS, type PayrollAmounts } from "@/lib/tax/facts/payroll";
import { FILING_STATUS_LABEL, taxYearParams } from "@/lib/tax/params";
import { applyWhatIf, bestSeparate, hasWhatIf, NO_WHAT_IF, type WhatIf } from "@/lib/tax/scenarios";
import { returnSchedules, type BracketRow, type Schedule } from "@/lib/tax/schedules";
import { useMemo, useState } from "react";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { balanceText, Callout, MoneyField, NumberTable, pct, usd, type Row } from "./taxUi";

type Basis = "projected" | "ytd";

/**
 * The whole return on one page: income → AGI → taxable income for each spouse filing
 * separately and for the joint return, every tax by component, rates and take-home pay,
 * what has been paid and what's owed or refunded, the supporting calculations, and the
 * bracket-by-bracket schedules behind each figure. Recomputed live in the browser from
 * the report's inputs, so the basis (year to date / projected) and what-ifs are instant.
 */
export function TaxWorksheet({ r }: { r: TaxResponse }) {
  const params = useMemo(() => taxYearParams(r.year), [r.year]);
  const [basis, setBasis] = useState<Basis>(r.isCurrentYear ? "projected" : "ytd");
  const [whatIf, setWhatIf] = useState<WhatIf>(NO_WHAT_IF);
  const [focus, setFocus] = useState<string>("all");

  const people = r.people;
  const calc = useMemo(() => {
    const base = people.map((p) => (basis === "ytd" ? p.incomeYtd : p.income));
    const incomes = applyWhatIf(base, whatIf, params);
    const ny = r.ny?.filing ?? null;
    const joint = computeReturn({ params, filingStatus: "MFJ", people: incomes, dependents: r.dependents, ny });
    const mfs = bestSeparate(params, incomes, r.dependents, r.profile.mfsDependentClaimant, ny);
    // Marginal rate: $1,000 more wages for that column's highest earner.
    const marginal = (rs: ReturnResult, inc: PersonIncome[], fs: "MFJ" | "MFS", deps: Dependent[]) => {
      const top = [...inc].sort((a, b) => wages(b) - wages(a))[0];
      if (!top || !top.w2s.length) return null;
      const bumped = applyWhatIf(inc, { ...NO_WHAT_IF, people: { [top.id]: { extraWages: 100_000, extraPretax401k: 0 } } }, params);
      const b = computeReturn({ params, filingStatus: fs, people: bumped, dependents: deps, ny, itemizeMode: rs.federal.itemizes ? "ITEMIZE" : "STANDARD" });
      return (allTaxes(b) - allTaxes(rs)) / 100_000;
    };
    const cols = [
      ...people.map((p, i) => {
        const rs = mfs.returns[p.id]!;
        return { id: p.id, name: p.name, sub: "separate", r: rs, incomes: [incomes[i]!], marginal: marginal(rs, [incomes[i]!], "MFS", mfs.claimant === p.id ? r.dependents : []) };
      }),
      { id: "joint", name: "Joint", sub: "filing jointly", r: joint, incomes, marginal: marginal(joint, incomes, "MFJ", r.dependents) },
    ];
    return { incomes, joint, mfs, cols };
  }, [people, basis, whatIf, params, r.dependents, r.profile.mfsDependentClaimant, r.ny]);

  const pay = (p: PersonReport): PayrollAmounts => {
    const a = basis === "ytd" ? p.payrollTotals.ytd : p.payrollTotals.projected;
    const w = whatIf.people[p.id];
    return w ? { ...a, bonus: a.bonus + w.extraWages, retirementPretax: a.retirementPretax + w.extraPretax401k } : a;
  };
  const payCols = [...people.map(pay), people.map(pay).reduce(addPay, { ...ZERO_AMOUNTS })];
  const cols = calc.cols;
  const P = (f: (a: PayrollAmounts) => number) => payCols.map(f);
  const R = (f: (x: ReturnResult, i: number) => number) => cols.map((c, i) => f(c.r, i));
  const money = (xs: number[]) => xs.map(usd);
  const ratio = (num: number[], den: number[]) => num.map((n, i) => (den[i]! > 0 ? pct(n / den[i]!) : "—"));

  const salary = P((a) => a.regular);
  const bonus = P((a) => a.bonus);
  const imputed = P((a) => a.imputed);
  const pretax = P((a) => a.section125 + a.hsa + a.dependentCareFsa);
  const k401 = P((a) => a.retirementPretax);
  const box5 = R((_x, i) => cols[i]!.incomes.reduce((s, p) => s + p.w2s.reduce((t, w) => t + w.box5MedicareWages, 0), 0));
  const box1 = R((x) => x.federal.wages);
  const investment = R((x) => x.federal.interest + x.federal.ordinaryDividends + x.federal.capitalGainAllowed + x.federal.retirementTaxable + x.federal.otherIncome);
  const fedIncomeTax = R((x) => x.federal.incomeTaxAfterCredits - x.federal.refundableChildCredit);
  const medicare = R((x) => x.fica.medicare + x.federal.additionalMedicareTax);
  const niit = R((x) => x.federal.niit);
  const ss = R((x) => x.fica.socialSecurity);
  const ct = R((x) => x.ct.totalTax);
  const pfml = R((x) => x.fica.ctPfml);
  const other = R((x) => x.otherStateTax);
  const hasNy = cols.some((c) => c.r.ny);
  const nyState = R((x) => x.ny?.stateTax ?? 0);
  const nyCity = R((x) => x.ny?.cityTax ?? 0);
  const totalTaxes = cols.map((_, i) => fedIncomeTax[i]! + medicare[i]! + niit[i]! + ss[i]! + ct[i]! + pfml[i]! + other[i]! + nyState[i]! + nyCity[i]!);
  const earnedPlusInvestment = cols.map((_, i) => salary[i]! + bonus[i]! + imputed[i]! + investment[i]!);
  const separateSum = totalTaxes.slice(0, people.length).reduce((a, b) => a + b, 0);
  const jointValue = separateSum - totalTaxes.at(-1)!;

  const withheld = (f: (w: PersonIncome["w2s"][number]) => number) => cols.map((c) => c.incomes.reduce((s, p) => s + p.w2s.reduce((t, w) => t + f(w), 0), 0));
  const fedWithheld = withheld((w) => w.federalWithheld);
  const ssWithheld = withheld((w) => w.ssWithheld);
  const medWithheld = withheld((w) => w.medicareWithheld);
  const ctWithheld = withheld((w) => w.stateWithheld);
  const nyWithheld = withheld((w) => (w.nyWithheld ?? 0) + (w.nycWithheld ?? 0));
  const nyCredits = R((x) => (x.ny?.city ? x.ny.city.schoolCredit + x.ny.city.schoolRateReduction : 0) + (x.ny?.estimatedPayments ?? 0));
  const fedEst = R((x) => x.federal.estimatedPayments);
  const ctEst = R((x) => x.ct.estimatedPayments);
  const paid = cols.map((_, i) => fedWithheld[i]! + ssWithheld[i]! + medWithheld[i]! + ctWithheld[i]! + fedEst[i]! + ctEst[i]! + pfml[i]! + nyWithheld[i]! + nyCredits[i]!);
  const fedBal = R((x) => x.federal.balanceDue);
  const ctBal = R((x) => x.ct.balanceDue);
  const nyBal = R((x) => x.ny?.balanceDue ?? 0);
  const actual = r.inputs.actual;
  const showActual = basis === "projected" && !hasWhatIf(whatIf) && (actual.federalBalance != null || actual.ctBalance != null);

  const rows: Row[] = [
    { label: "Annual income and deductions", values: [], heading: true },
    { label: "Gross salary", values: money(salary) },
    { label: "Gross bonus", values: money(bonus) },
    { label: "Earned income", values: money(cols.map((_, i) => salary[i]! + bonus[i]!)), strong: true },
    { label: "Plus: taxable company-paid benefits", values: money(imputed), indent: true, help: "Imputed income such as group-term life over $50k: taxed but never paid out." },
    { label: "Total income + taxable benefits", values: money(cols.map((_, i) => salary[i]! + bonus[i]! + imputed[i]!)), strong: true },
    { label: "Less: pre-tax health, dental, vision, HSA, FSA", values: money(pretax.map((x) => -x)), indent: true },
    { label: "Social Security / Medicare wages (W-2 box 5)", values: money(box5), strong: true },
    { label: "Less: pre-tax 401(k)", values: money(k401.map((x) => -x)), indent: true },
    { label: "Wages (W-2 box 1)", values: money(box1), strong: true },
    { label: "Investment income (interest, dividends, gains, IRA)", values: money(investment), indent: true, help: "Capital losses count only up to $3,000 ($1,500 filing separately)." },
    { label: "Adjustments", values: money(R((x) => -x.federal.adjustments)), indent: true },
    { label: "Federal adjusted gross income", values: money(R((x) => x.federal.agi)), strong: true },
    {
      label: "Federal deduction",
      values: R((x) => -x.federal.deduction).map((v, i) => `${usd(v)} ${cols[i]!.r.federal.itemizes ? "itemized" : "std"}`),
      indent: true,
    },
    { label: "QBI deduction", values: money(R((x) => -x.federal.qbiDeduction)), indent: true },
    { label: "Federal taxable income", values: money(R((x) => x.federal.taxableIncome)), strong: true },
    { label: "of which qualified dividends & LT gains (0/15/20%)", values: money(R((x) => x.federal.preferentialIncome)), indent: true },
    { label: "Connecticut AGI", values: money(R((x) => x.ct.ctAgi)), strong: true, help: "Federal AGI minus CHET 529 contributions and US-obligation interest." },
    { label: "Personal exemption", values: money(R((x) => -x.ct.exemption)), indent: true },
    { label: "Connecticut taxable income", values: money(R((x) => x.ct.taxableIncome)), strong: true },
    ...(hasNy
      ? [
          { label: "New York AGI", values: money(R((x) => x.ny?.nyAgi ?? 0)), strong: true, help: "Federal AGI minus US-government interest." },
          { label: "Standard deduction and dependent exemptions", values: money(R((x) => -((x.ny?.standardDeduction ?? 0) + (x.ny?.dependentExemption ?? 0)))), indent: true },
          { label: "New York taxable income", values: money(R((x) => x.ny?.taxableIncome ?? 0)), strong: true },
          ...(cols.some((c) => c.r.ny?.incomePercentage != null)
            ? [{ label: "New York share of income (part-year)", values: R((x) => x.ny?.incomePercentage ?? 0).map((v) => pct(v, 2)), indent: true }]
            : []),
          ...(cols.some((c) => c.r.ny?.city) ? [{ label: "New York City taxable income", values: money(R((x) => x.ny?.city?.taxableIncome ?? 0)), indent: true }] : []),
        ]
      : []),

    { label: "Total taxes owed", values: [], heading: true },
    { label: "Federal income tax", values: money(fedIncomeTax) },
    { label: "Medicare (1.45% + 0.9% surtax)", values: money(medicare) },
    { label: "Net investment income tax (3.8%)", values: money(niit) },
    { label: "Social Security", values: money(ss) },
    { label: "Connecticut income tax", values: money(ct) },
    { label: "CT Paid Leave (PFML)", values: money(pfml) },
    ...(hasNy ? [{ label: "New York State income tax", values: money(nyState) }] : []),
    ...(nyCity.some((x) => x) ? [{ label: "New York City income tax", values: money(nyCity) }] : []),
    ...(other.some((x) => x) ? [{ label: "Other state tax", values: money(other) }] : []),
    { label: "Total taxes", values: money(totalTaxes), strong: true },
    {
      label: "Value of filing jointly",
      values: [...people.map(() => ""), usd(jointValue)],
      help: "Both spouses' separate-return taxes minus the joint return's taxes.",
    },

    { label: "Rates and take-home", values: [], heading: true },
    { label: "Earned + investment income", values: money(earnedPlusInvestment) },
    { label: "Take-home income (after all taxes)", values: money(cols.map((_, i) => earnedPlusInvestment[i]! - totalTaxes[i]!)), strong: true },
    { label: "Effective tax rate", values: ratio(totalTaxes, earnedPlusInvestment), strong: true },
    { label: "Federal income tax", values: ratio(fedIncomeTax.map((v, i) => v + niit[i]!), earnedPlusInvestment), indent: true },
    { label: "Medicare", values: ratio(medicare, earnedPlusInvestment), indent: true },
    { label: "Social Security", values: ratio(ss, earnedPlusInvestment), indent: true },
    { label: "Connecticut (incl. PFML)", values: ratio(ct.map((v, i) => v + pfml[i]!), earnedPlusInvestment), indent: true },
    ...(hasNy ? [{ label: "New York State + City", values: ratio(nyState.map((v, i) => v + nyCity[i]!), earnedPlusInvestment), indent: true }] : []),
    { label: "Marginal rate on the next $1,000 of pay", values: cols.map((c) => (c.marginal == null ? "—" : pct(c.marginal))) },
    { label: "Federal bracket", values: R((x) => x.federal.marginalBracket).map((b, i) => (cols[i]!.r.federal.taxableIncome > 0 ? pct(b, 0) : "—")) },

    { label: "Total taxes paid", values: [], heading: true },
    { label: "Federal withholding (box 2)", values: money(fedWithheld) },
    { label: "Federal estimated payments", values: money(fedEst) },
    { label: "Medicare withheld (box 6)", values: money(medWithheld) },
    { label: "Social Security withheld (box 4)", values: money(ssWithheld) },
    { label: "Connecticut withholding (box 17)", values: money(ctWithheld) },
    { label: "Connecticut estimated payments", values: money(ctEst) },
    { label: "CT Paid Leave (PFML)", values: money(pfml) },
    ...(hasNy
      ? [
          { label: "New York State + City withholding (box 17, 19)", values: money(nyWithheld) },
          { label: "NYC school credits and NY estimates", values: money(nyCredits), indent: true },
        ]
      : []),
    { label: "Total taxes paid", values: money(paid), strong: true },
    { label: "Federal owed / (refund)", values: fedBal.map(balanceText) },
    { label: "Connecticut owed / (refund)", values: ctBal.map(balanceText) },
    ...(hasNy ? [{ label: "New York owed / (refund)", values: nyBal.map(balanceText) }] : []),
    { label: "Total owed / (refund)", values: cols.map((_, i) => balanceText(fedBal[i]! + ctBal[i]! + nyBal[i]!)), strong: true },
    ...(showActual
      ? [
          { label: "Actual return", values: [], heading: true },
          { label: "Federal actual owed / (refund)", values: [...people.map(() => ""), actual.federalBalance == null ? "—" : balanceText(actual.federalBalance)] },
          { label: "Connecticut actual owed / (refund)", values: [...people.map(() => ""), actual.ctBalance == null ? "—" : balanceText(actual.ctBalance)] },
          {
            label: "Model minus actual",
            values: [...people.map(() => ""), usd(fedBal.at(-1)! + ctBal.at(-1)! - (actual.federalBalance ?? 0) - (actual.ctBalance ?? 0))],
            strong: true,
          },
        ]
      : []),
  ];

  // In "All" view a spouse with no income has nothing to schedule.
  const shown = cols.filter((c) => (focus === "all" ? c.id === "joint" || c.r.federal.agi !== 0 || c.r.federal.wages !== 0 : focus === c.id));
  const header = cols.map((c) => (
    <span key={c.id}>
      {c.name}
      <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">{c.sub}</span>
    </span>
  ));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 text-xs text-fg-2">
            <span className="font-medium">Basis</span>
            <Segmented
              options={[
                { value: "projected", label: r.isCurrentYear ? "Projected Dec 31" : "Full year" },
                { value: "ytd", label: "Year to date" },
              ]}
              value={basis}
              onChange={(v) => setBasis(v as Basis)}
            />
          </div>
          <p className="min-w-0 flex-1 text-xs text-muted">
            {basis === "ytd"
              ? "As if the year ended at the latest pay stub and statement: no remaining paychecks, expected bonus or future sales."
              : "Remaining paychecks, expected bonus and investment income projected to December 31."}
            {` Separate columns assume ${people.find((p) => p.id === calc.mfs.claimant)?.name ?? "one spouse"} claims ${r.dependents.map((d) => d.name).join(", ") || "no dependents"}.`}
          </p>
        </div>
        <WhatIfPanel r={r} whatIf={whatIf} onChange={setWhatIf} basis={basis} />
      </Card>

      {hasWhatIf(whatIf) && <Callout tone="info">What-if active — these figures include your hypothetical changes and aren&apos;t saved.</Callout>}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,48rem)_minmax(0,1fr)]">
        <Card title={`${r.year} tax worksheet`} subtitle={`${FILING_STATUS_LABEL.MFJ} vs each spouse ${FILING_STATUS_LABEL.MFS.toLowerCase()}.`}>
          <NumberTable columns={header} rows={rows} />
        </Card>
        <Supporting r={r} basis={basis} cols={cols} />
      </div>

      <Card
        title="Bracket schedules"
        subtitle="How each tax is built, band by band. The bar shows how much of each band your income fills; the highlighted row is where the next dollar lands."
        actions={
          <Segmented
            options={[{ value: "all", label: "All" }, ...cols.map((c) => ({ value: c.id, label: c.id === "joint" ? "Joint" : `${c.name} (sep.)` }))]}
            value={focus}
            onChange={setFocus}
          />
        }
      >
        <ScheduleGrid
          columns={shown.map((c) => ({
            id: c.id,
            title: c.id === "joint" ? FILING_STATUS_LABEL.MFJ : `${c.name} ${FILING_STATUS_LABEL.MFS.toLowerCase()}`,
            schedules: returnSchedules(c.r, c.incomes, params),
          }))}
        />
      </Card>
    </div>
  );
}

function wages(p: PersonIncome): number {
  return p.w2s.reduce((s, w) => s + w.box5MedicareWages, 0);
}

function allTaxes(x: ReturnResult): number {
  return x.totalTax - x.federal.refundableChildCredit + x.fica.ctPfml;
}

function addPay(a: PayrollAmounts, b: PayrollAmounts): PayrollAmounts {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof PayrollAmounts)[]) out[k] += b[k];
  return out;
}

function WhatIfPanel({ r, whatIf, onChange, basis }: { r: TaxResponse; whatIf: WhatIf; onChange: (w: WhatIf) => void; basis: Basis }) {
  const [open, setOpen] = useState(false);
  const limit = taxYearParams(r.year).federal.limits.k401;
  const setPerson = (id: string, k: "extraWages" | "extraPretax401k", v: number) =>
    onChange({ ...whatIf, people: { ...whatIf.people, [id]: { ...(whatIf.people[id] ?? { extraWages: 0, extraPretax401k: 0 }), [k]: v } } });
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonSecondary} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide what-if" : "What if…"}
        </button>
        {hasWhatIf(whatIf) && (
          <button type="button" className={buttonSecondary} onClick={() => onChange(NO_WHAT_IF)}>
            Reset what-if
          </button>
        )}
        {!open && <span className="text-xs text-muted">Try a bigger bonus, more 401(k), selling investments or giving to charity — nothing is saved.</span>}
      </div>
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {r.people.map((p) => {
            const used = (basis === "ytd" ? p.payrollTotals.ytd : p.payrollTotals.projected).retirementPretax;
            return [
              <MoneyField
                key={`${p.id}-w`}
                label={`${p.name}: extra bonus / wages`}
                help="Withheld at 22% federal and 6.99% CT, like a bonus."
                cents={whatIf.people[p.id]?.extraWages ?? 0}
                allowNegative
                onChange={(c) => setPerson(p.id, "extraWages", c)}
              />,
              <MoneyField
                key={`${p.id}-k`}
                label={`${p.name}: extra pre-tax 401(k)`}
                help={`${usd(Math.max(0, limit - used))} of room left under the ${usd(limit)} limit.`}
                cents={whatIf.people[p.id]?.extraPretax401k ?? 0}
                onChange={(c) => setPerson(p.id, "extraPretax401k", c)}
              />,
            ];
          })}
          <MoneyField label="Sell investments: short-term gain" help="Negative for a loss (tax-loss harvesting)." cents={whatIf.extraShortTermGain} allowNegative onChange={(c) => onChange({ ...whatIf, extraShortTermGain: c })} />
          <MoneyField label="Sell investments: long-term gain" help="Negative for a loss." cents={whatIf.extraLongTermGain} allowNegative onChange={(c) => onChange({ ...whatIf, extraLongTermGain: c })} />
          <MoneyField label="Extra charitable gifts (cash)" cents={whatIf.extraCharitable} onChange={(c) => onChange({ ...whatIf, extraCharitable: c })} />
        </div>
      )}
    </div>
  );
}

function Supporting({ r, basis, cols }: { r: TaxResponse; basis: Basis; cols: { id: string; name: string; r: ReturnResult }[] }) {
  const accounts = r.people.flatMap((p) => p.accounts);
  const pick = basis === "ytd" ? "ytd" : "projected";
  const mm = accounts.filter((a) => a.kind === "TAXABLE").reduce((s, a) => s + a[pick].moneyMarketDividends, 0);
  const joint = cols.at(-1)!.r;
  const chet = r.chet.total;
  const conversions = r.people.reduce((s, p) => s + p.retirement.conversions, 0);
  const rollovers = r.people.reduce((s, p) => s + p.retirement.rollovers, 0);
  const basisIra = r.people.reduce((s, p) => s + p.retirement.basis, 0);
  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
      <Card title="CT-exempt US-obligation income">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Money-market dividends", values: [usd(mm)] },
            { label: "Share from US obligations", values: [pct(r.profile.moneyMarketUsGovShare, 1)], help: "Set on the Inputs tab from Fidelity's annual percentage." },
            { label: "Subtracted from CT AGI", values: [usd(joint.ct.usObligationSubtraction)], strong: true },
          ]}
        />
      </Card>
      <Card title="CHET 529 deduction">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Contributions this year", values: [usd(chet)] },
            { label: "Cap (joint / separate)", values: [`${usd(taxYearParams(r.year).ct.chetDeduction.MFJ)} / ${usd(taxYearParams(r.year).ct.chetDeduction.MFS)}`] },
            { label: "Deducted on joint CT return", values: [usd(joint.ct.chetDeduction)], strong: true },
          ]}
        />
      </Card>
      <Card title="Capital gains and losses">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Net gain / (loss)", values: [usd(joint.federal.capitalGainNet)] },
            { label: "Counted this year (joint)", values: [usd(joint.federal.capitalGainAllowed)], strong: true },
            { label: "Carries to next year", values: [usd(-joint.federal.capitalLossCarryover)] },
          ]}
        />
      </Card>
      <Card title="IRA rollovers and conversions">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Direct rollovers (not taxable)", values: [usd(rollovers)] },
            { label: "Roth conversions", values: [usd(conversions)] },
            { label: "Non-deductible basis", values: [usd(-basisIra)] },
            { label: "Taxable", values: [usd(joint.federal.retirementTaxable)], strong: true },
          ]}
        />
      </Card>
    </div>
  );
}

/**
 * The schedules of each return side by side, one row per kind of schedule: the same
 * schedule sits at the same height in every column (an empty cell where a return has
 * none), and every box is the same width with the same column widths, so band against
 * band reads straight across.
 */
function ScheduleGrid({ columns }: { columns: { id: string; title: string; schedules: Schedule[] }[] }) {
  // Per-person schedules (Social Security, PFML) share a row: "ss-a" and "ss-b" are both "ss".
  const slotOf = (s: Schedule) => s.key.replace(/-.*$/, "");
  const slots: string[] = [];
  for (const c of columns) for (const s of c.schedules) if (!slots.includes(slotOf(s))) slots.push(slotOf(s));
  const one = columns.length === 1;
  // Literal class names for Tailwind: side by side from lg, stacked below.
  const layout = one
    ? { grid: "md:grid-cols-2 2xl:grid-cols-3", header: "", title: "", gap: "" }
    : columns.length === 2
      ? { grid: "lg:grid-cols-2", header: "lg:grid", title: "lg:hidden", gap: "lg:block" }
      : { grid: "lg:grid-cols-3", header: "lg:grid", title: "lg:hidden", gap: "lg:block" };
  const grid = layout.grid;
  if (one) {
    return (
      <div className={`grid items-start gap-3 ${grid}`}>
        {columns[0]!.schedules.map((s) => (
          <ScheduleView key={s.key} s={s} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className={`hidden gap-3 ${layout.header} ${grid}`}>
        {columns.map((c) => (
          <h3 key={c.id} className="border-b border-line pb-1 text-sm font-semibold text-fg">
            {c.title}
          </h3>
        ))}
      </div>
      {slots.map((slot) => (
        <div key={slot} className={`grid items-stretch gap-3 ${grid}`}>
          {columns.map((c) => {
            const mine = c.schedules.filter((s) => slotOf(s) === slot);
            return (
              <div key={c.id} className="flex min-w-0 flex-col gap-3">
                <span className={`text-[10px] font-semibold uppercase tracking-wide text-muted ${layout.title}`}>{c.title}</span>
                {mine.length ? (
                  mine.map((s) => <ScheduleView key={s.key} s={s} />)
                ) : (
                  <div className={`hidden flex-1 rounded-md border border-dashed border-line ${layout.gap}`} aria-hidden />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ScheduleView({ s }: { s: Schedule }) {
  if (s.kind === "lines") {
    return (
      <div className="flex min-w-0 flex-1 flex-col rounded-md border border-line p-2">
        <h4 className="mb-1 text-left text-xs font-semibold text-fg">{s.title}</h4>
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col />
            <col className="w-[7.5rem]" />
          </colgroup>
          <tbody>
            {s.lines.map((l, i) => (
              <tr key={i} className={l.strong ? "border-t border-line-strong font-semibold" : ""} title={l.help}>
                <td className="py-0.5 pr-2 text-left leading-snug text-fg-2">{l.label}</td>
                <td className="py-0.5 text-right tabular-nums text-fg">{l.kind === "rate" ? pct(l.value, 2) : usd(l.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const topFilled = s.rows.reduce((acc, row, i) => (row.included > 0 ? i : acc), -1);
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-md border border-line p-2">
      <h4 className="mb-1 text-left text-xs font-semibold text-fg" title={s.note}>
        {s.title}
      </h4>
      {/*
        Fixed widths for every text column; the bar gets its own column and all the space
        left, so every bar in every box starts and ends at the same place.
      */}
      <table className="w-full table-fixed text-xs">
        <colgroup>
          {/* Text columns sized in characters (they fit their text in any font); the bar takes the rest. */}
          <col className="w-[10.5ch]" />
          <col className="w-[5ch]" />
          <col />
          <col className="w-[8.5ch]" />
          <col className="w-[9ch]" />
        </colgroup>
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted">
            <th className="py-0.5 pl-1 text-left font-medium">Band</th>
            <th className="py-0.5 text-right font-medium">Rate</th>
            <th className="py-0.5 font-medium">
              <span className="sr-only">How full the band is</span>
            </th>
            <th className="py-0.5 text-right font-medium">Included</th>
            <th className="py-0.5 pr-1 text-right font-medium">Owed</th>
          </tr>
        </thead>
        <tbody>
          {s.rows.map((row, i) => (
            <tr key={i} className={i === topFilled ? "bg-warn-soft font-semibold text-warn" : row.included > 0 ? "text-fg" : "text-faint"}>
              <td className="truncate py-0.5 pl-1 text-left" title={exactBand(row)}>
                {band(row)}
              </td>
              <td className="py-0.5 text-right tabular-nums">{pct(row.rate, 2) === "—" ? "0%" : pct(row.rate, 2)}</td>
              <td className="py-0.5 px-2">
                <FillBar row={row} />
              </td>
              <td className="py-0.5 text-right tabular-nums">{usd(row.included)}</td>
              <td className="py-0.5 pr-1 text-right tabular-nums">{usd(row.owed)}</td>
            </tr>
          ))}
          <tr className="border-t border-line-strong font-semibold">
            <td className="py-0.5 pl-1 text-left">Total</td>
            <td className="py-0.5 text-right tabular-nums">{s.included > 0 ? pct(s.owed / s.included, 1) : "—"}</td>
            <td />
            <td className="py-0.5 text-right tabular-nums">{usd(s.included)}</td>
            <td className="py-0.5 pr-1 text-right tabular-nums">{usd(s.owed)}</td>
          </tr>
        </tbody>
      </table>
      {s.note && <p className="mt-auto pt-1 text-left text-[10px] text-muted">{s.note}</p>}
    </div>
  );
}

/** The band in whole dollars, for the hover title. */
function exactBand(row: BracketRow): string {
  const d = (c: number) => usd(c);
  return row.to == null ? `over ${d(row.from)}` : `${d(row.from)} to ${d(row.to)}`;
}

/** "$106–202k", "$512k–1.08M", "$384k+": short enough for a narrow box (the exact range is the hover title). */
function band(row: BracketRow): string {
  const k = (c: number): [string, string] => {
    const d = c / 100;
    if (d >= 1_000_000) return [String(Math.round(d / 10_000) / 100), "M"];
    if (d >= 10_000) return [String(Math.round(d / 1_000)), "k"];
    if (d >= 1_000) return [String(Math.round(d / 100) / 10), "k"];
    return [String(Math.round(d)), ""];
  };
  const [a, ua] = k(row.from);
  if (row.to == null) return `$${a}${ua}+`;
  const [b, ub] = k(row.to);
  // One unit for both ends when they share it (a bare 0 takes the upper end's).
  return ua === ub || a === "0" ? `$${a}–${b}${ub}` : `$${a}${ua}–${b}${ub}`;
}

/** How full this band is: included ÷ band width (open-ended top bands show relative to what's in them). */
function FillBar({ row }: { row: BracketRow }) {
  const width = row.to == null ? (row.included > 0 ? 1 : 0) : Math.min(1, row.included / Math.max(1, row.to - row.from));
  return (
    // Theme-neutral: a translucent track and a fill in the row's own text color.
    <span className="block h-2 w-full overflow-hidden rounded-full" style={{ background: "rgba(128,128,128,0.22)" }} aria-hidden>
      <span className="block h-full rounded-full" style={{ width: `${Math.round(width * 100)}%`, background: "currentColor" }} />
    </span>
  );
}
