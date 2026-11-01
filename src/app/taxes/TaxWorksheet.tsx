"use client";

import { buttonSecondary, Card, Segmented } from "@/components/ledger/LedgerBits";
import { NotFigure } from "@/components/ui/kit";
import { compositeOf } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { taxesDerived } from "@/lib/book/derived/taxes";
import { cellKey, derivedNumber, derivedTarget } from "@/lib/book/derived/types";
import type { ProofDescriptor } from "@/lib/book/proof";
import { marginalRate } from "@/lib/tax/worksheetExtras";
import type { ReturnResult } from "@/lib/tax/computeReturn";
import { ESTIMATE_LINES, estimateColumns, lineValue, worksheetLines, type EstimateKey } from "@/lib/tax/estimateLines";
import { FILING_STATUS_LABEL, taxYearParams } from "@/lib/tax/params";
import { hasWhatIf, NO_WHAT_IF, type WhatIf } from "@/lib/tax/scenarios";
import { returnSchedules, type BracketRow, type Schedule } from "@/lib/tax/schedules";
import { useMemo, useState, type ReactNode } from "react";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { balanceText, Callout, lawLabel, MoneyField, NumberTable, pct, usd, type Row } from "./taxUi";

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
    const { joint, mfs, cols: base } = estimateColumns(r, basis, whatIf);
    // Marginal rate: $1,000 more wages for that column's highest earner (lib/tax/worksheetExtras, as its proof works it out).
    const cols = base.map((c) => ({ ...c, marginal: marginalRate(c, c.id === "joint" ? c.r.filingStatus : "MFS", r) }));
    return { joint, mfs, cols };
  }, [r, basis, whatIf]);

  const cols = calc.cols;
  const proofs = !hasWhatIf(whatIf);
  const R = (f: (x: ReturnResult, i: number) => number) => cols.map((c, i) => f(c.r, i));
  // Every other number: the year's derived figures (book/derived/taxes.ts), by row and column; a what-if one has no proof.
  const derived = useMemo(() => taxesDerived(r), [r]);
  const wcell = (row: string, col: string, text: ReactNode): ReactNode =>
    proofs ? <ProofValue proof={derivedTarget("taxes", derived, "worksheet", cellKey(`${r.year}:${basis}`, row, col))}>{text}</ProofValue> : text;
  const est = (key: EstimateKey, i: number) => ({ report: "tax-estimate", year: r.year, basis, ...(cols[i]!.id === "joint" ? {} : { filer: cols[i]!.id }), key }) as const;
  // A rate over earned + investment income: a share of two estimate lines (the first a sum of two where a row adds them).
  const ratio = (keys: EstimateKey[], num: number[], den: number[]) =>
    num.map((n, i) => {
      if (!(den[i]! > 0)) return "—";
      const top = keys.length === 1 ? est(keys[0]!, i) : ({ report: "composite", op: "sum", of: keys.map((k) => est(k, i)) } as const);
      return proofs ? <ProofValue proof={compositeOf("share", [{ descriptor: top as ProofDescriptor, shownCents: n }, { descriptor: est("all.earnedPlusInvestment", i), shownCents: den[i]! }], { ratio: n / den[i]! })}>{pct(n / den[i]!)}</ProofValue> : pct(n / den[i]!);
    });
  // Every figure comes from the estimate's line catalog (lib/tax/estimateLines), the one its proof re-derives; a what-if figure has no proof.
  const V = (key: EstimateKey) => cols.map((c) => lineValue(key, c, cols) ?? 0);
  const cell = (key: EstimateKey, i: number, v: number, text: ReactNode): ReactNode =>
    proofs ? (
      <ProofValue proof={{ descriptor: { report: "tax-estimate", year: r.year, basis, ...(cols[i]!.id === "joint" ? {} : { filer: cols[i]!.id }), key }, shownCents: ESTIMATE_LINES[key].ratio ? null : v }} drawn={{ zeroWithin: 1 }}>
        {text}
      </ProofValue>
    ) : (
      text
    );
  // The lines these columns draw (lib/tax/estimateLines worksheetLines): the list the proof sweep enumerates too.
  const drawsLine = useMemo(() => new Map(worksheetLines(cols).map((l) => [l.key, l])), [cols]);
  /** A worksheet row for a line, if the columns draw it: deductions show negative; `show` formats a cell otherwise. */
  const line = (key: EstimateKey, label: string, o: { neg?: boolean; show?: (v: number, i: number) => string; strong?: boolean; indent?: boolean; help?: string } = {}): Row[] => {
    const l = drawsLine.get(key);
    if (!l) return [];
    return [
      {
        label: lawLabel(label),
        values: V(key).map((v, i) => (l.only && cols[i]!.id !== l.only ? "" : cell(key, i, v, o.show ? o.show(v, i) : usd(o.neg ? -v : v)))),
        ...(o.strong ? { strong: true } : {}),
        ...(o.indent ? { indent: true } : {}),
        ...(o.help ? { help: o.help } : {}),
      },
    ];
  };

  const fedIncomeTax = V("fed.incomeTax");
  const medicare = V("fica.medicareTotal");
  const niit = V("fed.niit");
  const ss = V("fica.socialSecurity");
  const ct = V("ct.totalTax");
  const pfml = V("fica.pfml");
  const hasNy = cols.some((c) => c.r.ny);
  const nyState = V("ny.incomeTax");
  const nyCity = V("ny.cityTax");
  const totalTaxes = V("all.totalTaxes");
  const earnedPlusInvestment = V("all.earnedPlusInvestment");
  const fedBal = R((x) => x.federal.balanceDue);
  const ctBal = R((x) => x.ct.balanceDue);
  const actual = r.inputs.actual;
  const showActual = basis === "projected" && !hasWhatIf(whatIf) && (actual.federalBalance != null || actual.ctBalance != null);

  const rows: Row[] = [
    { label: "Annual income and deductions", values: [], heading: true },
    ...line("pay.salary", "Gross salary"),
    ...line("pay.bonus", "Gross bonus"),
    ...line("pay.earned", "Earned income", { strong: true }),
    ...line("pay.imputed", "Plus: taxable company-paid benefits", { indent: true, help: "Imputed income such as group-term life over $50k: taxed but never paid out." }),
    ...line("pay.withBenefits", "Total income + taxable benefits", { strong: true }),
    ...line("pay.pretax", "Less: pre-tax health, dental, vision, HSA, FSA", { neg: true, indent: true }),
    ...line("pay.medicareWages", "Social Security / Medicare wages (W-2 box 5)", { strong: true }),
    ...line("pay.k401", "Less: pre-tax 401(k)", { neg: true, indent: true }),
    ...line("fed.wages", "Wages (W-2 box 1)", { strong: true }),
    ...line("fed.investmentIncome", "Investment income (interest, dividends, gains, IRA)", { indent: true, help: "Capital losses count only up to $3,000 ($1,500 filing separately)." }),
    ...line("fed.adjustments", "Adjustments", { neg: true, indent: true }),
    ...line("fed.agi", "Federal adjusted gross income", { strong: true }),
    ...line("fed.deduction", "Federal deduction", { show: (v, i) => `${usd(-v)} ${cols[i]!.r.federal.itemizes ? "itemized" : "std"}`, indent: true }),
    ...line("fed.qbiDeduction", "QBI deduction", { neg: true, indent: true }),
    ...line("fed.taxableIncome", "Federal taxable income", { strong: true }),
    ...line("fed.preferentialIncome", "of which qualified dividends & LT gains (0/15/20%)", { indent: true }),
    ...line("ct.stateAgi", "Connecticut AGI", { strong: true, help: "Federal AGI minus CHET 529 contributions and US-obligation interest." }),
    ...line("ct.exemption", "Personal exemption", { neg: true, indent: true }),
    ...line("ct.taxableIncome", "Connecticut taxable income", { strong: true }),
    ...line("ny.stateAgi", "New York AGI", { strong: true, help: "Federal AGI minus US-government interest." }),
    ...line("ny.deductions", "Standard deduction and dependent exemptions", { neg: true, indent: true }),
    ...line("ny.taxableIncome", "New York taxable income", { strong: true }),
    ...line("ny.incomePercentage", "New York share of income (part-year)", { show: (v) => pct(v, 2), indent: true }),
    ...line("ny.cityTaxableIncome", "New York City taxable income", { indent: true }),

    { label: "Total taxes owed", values: [], heading: true },
    ...line("fed.incomeTax", "Federal income tax"),
    ...line("fica.medicareTotal", "Medicare (1.45% + 0.9% surtax)"),
    ...line("fed.niit", "Net investment income tax (3.8%)"),
    ...line("fica.socialSecurity", "Social Security"),
    ...line("ct.totalTax", "Connecticut income tax"),
    ...line("fica.pfml", "CT Paid Leave (PFML)"),
    ...line("ny.incomeTax", "New York State income tax"),
    ...line("ny.cityTax", "New York City income tax"),
    ...line("all.otherStateTax", "Other state tax"),
    ...line("all.totalTaxes", "Total taxes", { strong: true, help: "The Overview's headline tax (joint, projected)." }),
    ...line("all.jointValue", "Value of filing jointly", { help: "Both spouses' separate-return taxes minus the joint return's taxes." }),

    { label: "Rates and take-home", values: [], heading: true },
    ...line("all.earnedPlusInvestment", "Earned + investment income", {
      help: "Gross salary + bonus + taxable benefits + investment income. The Overview's headline income (joint, projected), net of any capital loss deducted.",
    }),
    ...line("all.takeHome", "Take-home income (after all taxes)", { strong: true, help: "The Overview's “You keep”." }),
    { label: "Effective tax rate", values: ratio(["all.totalTaxes"], totalTaxes, earnedPlusInvestment), strong: true },
    { label: "Federal income tax", values: ratio(["fed.incomeTax", "fed.niit"], fedIncomeTax.map((v, i) => v + niit[i]!), earnedPlusInvestment), indent: true },
    { label: "Medicare", values: ratio(["fica.medicareTotal"], medicare, earnedPlusInvestment), indent: true },
    { label: "Social Security", values: ratio(["fica.socialSecurity"], ss, earnedPlusInvestment), indent: true },
    { label: "Connecticut (incl. PFML)", values: ratio(["ct.totalTax", "fica.pfml"], ct.map((v, i) => v + pfml[i]!), earnedPlusInvestment), indent: true },
    ...(hasNy ? [{ label: "New York State + City", values: ratio(["ny.incomeTax", "ny.cityTax"], nyState.map((v, i) => v + nyCity[i]!), earnedPlusInvestment), indent: true }] : []),
    { label: <NotFigure why="the probe the rate is worked out on">Marginal rate on the next $1,000 of pay</NotFigure>, values: cols.map((c) => (c.marginal == null ? "—" : wcell("marginal", c.id, pct(c.marginal)))) },
    { label: "Federal bracket", values: R((x) => x.federal.marginalBracket).map((b, i) => (cols[i]!.r.federal.taxableIncome > 0 ? wcell("bracket", cols[i]!.id, pct(b, 0)) : "—")) },

    { label: "Total taxes paid", values: [], heading: true },
    ...line("fed.w2Withholding", "Federal withholding (box 2)"),
    ...line("fed.estimatedPayments", "Federal estimated payments"),
    ...line("fica.medicareWithheld", "Medicare withheld (box 6)"),
    ...line("fica.ssWithheld", "Social Security withheld (box 4)"),
    ...line("ct.withheld", "Connecticut withholding (box 17)"),
    ...line("ct.estimatedPayments", "Connecticut estimated payments"),
    ...line("fica.pfml", "CT Paid Leave (PFML)"),
    ...line("ny.withheldAll", "New York State + City withholding (box 17, 19)"),
    ...line("ny.credits", "NYC school credits and NY estimates", { indent: true }),
    ...line("all.totalPaid", "Total taxes paid", { strong: true }),
    ...line("fed.balance", "Federal owed / (refund)", { show: balanceText }),
    ...line("ct.balance", "Connecticut owed / (refund)", { show: balanceText }),
    ...line("ny.balance", "New York owed / (refund)", { show: balanceText }),
    ...line("all.balance", "Total owed / (refund)", { show: balanceText, strong: true }),
    ...(showActual
      ? [
          { label: "Actual return", values: [], heading: true },
          { label: "Federal actual owed / (refund)", values: [...people.map(() => ""), actual.federalBalance == null ? "—" : <NotFigure why="your input: the return as filed (Inputs)">{balanceText(actual.federalBalance)}</NotFigure>] },
          { label: "Connecticut actual owed / (refund)", values: [...people.map(() => ""), actual.ctBalance == null ? "—" : <NotFigure why="your input: the return as filed (Inputs)">{balanceText(actual.ctBalance)}</NotFigure>] },
          {
            label: "Model minus actual",
            values: [...people.map(() => ""), <NotFigure key="d" why="the model against the return you typed (Inputs)">{usd(fedBal.at(-1)! + ctBal.at(-1)! - (actual.federalBalance ?? 0) - (actual.ctBalance ?? 0))}</NotFigure>],
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
            <Segmented view
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
            {cols.length > 1 && ` Separate columns assume ${people.find((p) => p.id === calc.mfs.claimant)?.name ?? "one spouse"} claims ${r.dependents.map((d) => d.name).join(", ") || "no dependents"}.`}
          </p>
        </div>
        <WhatIfPanel r={r} whatIf={whatIf} onChange={setWhatIf} basis={basis} />
      </Card>

      {hasWhatIf(whatIf) && <Callout tone="info">What-if active — these figures include your hypothetical changes and aren&apos;t saved.</Callout>}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,48rem)_minmax(0,1fr)]">
        <Card title={`${r.year} tax worksheet`} subtitle={r.filingStatus === "SINGLE" ? `${FILING_STATUS_LABEL.SINGLE}, as filed.` : `${FILING_STATUS_LABEL.MFJ} vs each spouse ${FILING_STATUS_LABEL.MFS.toLowerCase()}.`}>
          <NumberTable columns={header} rows={rows} />
        </Card>
        <Supporting r={r} cell={wcell} num={(row) => derivedNumber(derived, "worksheet", cellKey(`${r.year}:${basis}`, row, "joint")) ?? 0} />
      </div>

      <Card
        title="Bracket schedules"
        subtitle="How each tax is built, band by band. The bar shows how much of each band your income fills; the highlighted row is where the next dollar lands."
        actions={
          <Segmented view={{ nested: true }}
            options={[{ value: "all", label: "All" }, ...cols.map((c) => ({ value: c.id, label: c.id === "joint" ? c.name : `${c.name} (sep.)` }))]}
            value={focus}
            onChange={setFocus}
          />
        }
      >
        <ScheduleGrid
          columns={shown.map((c) => ({
            id: c.id,
            title: c.id === "joint" ? FILING_STATUS_LABEL[c.r.filingStatus] : `${c.name} ${FILING_STATUS_LABEL.MFS.toLowerCase()}`,
            schedules: returnSchedules(c.r, c.incomes, params),
          }))}
          cell={wcell}
        />
      </Card>
    </div>
  );
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

/** The cards beside the worksheet; every number is the year's derived figure (lib/tax/worksheetExtras), drawn by `cell`. */
function Supporting({ r, cell, num }: { r: TaxResponse; cell: (row: string, col: string, text: ReactNode) => ReactNode; num: (row: string) => number }) {
  const v = (row: string) => cell(row, "joint", usd(num(row)));
  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
      <Card title="CT-exempt US-obligation income">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Money-market dividends", values: [v("mm")] },
            { label: "Share from US obligations", values: [<NotFigure key="s" why="your input (Inputs)">{pct(r.profile.moneyMarketUsGovShare, 1)}</NotFigure>], help: "Set on the Inputs tab from Fidelity's annual percentage." },
            { label: "Subtracted from CT AGI", values: [v("us-obligations")], strong: true },
          ]}
        />
      </Card>
      <Card title="CHET 529 deduction">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Contributions this year", values: [v("chet")] },
            { label: "Cap (joint / separate)", values: [<NotFigure key="c" why="set by Connecticut law">{`${usd(taxYearParams(r.year).ct.chetDeduction.MFJ)} / ${usd(taxYearParams(r.year).ct.chetDeduction.MFS)}`}</NotFigure>] },
            { label: "Deducted on joint CT return", values: [v("chet-deducted")], strong: true },
          ]}
        />
      </Card>
      <Card title="Capital gains and losses">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Net gain / (loss)", values: [v("gain-net")] },
            { label: "Counted this year (joint)", values: [v("gain-counted")], strong: true },
            { label: "Carries to next year", values: [v("loss-carry")] },
          ]}
        />
      </Card>
      <Card title="IRA rollovers and conversions">
        <NumberTable
          compact
          columns={[""]}
          rows={[
            { label: "Direct rollovers (not taxable)", values: [v("rollovers")] },
            { label: "Roth conversions", values: [v("conversions")] },
            { label: "Non-deductible basis", values: [v("ira-basis")] },
            { label: "Taxable", values: [v("ira-taxable")], strong: true },
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
function ScheduleGrid({ columns, cell }: { columns: { id: string; title: string; schedules: Schedule[] }[]; cell: Cell }) {
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
          <ScheduleView key={s.key} s={s} col={columns[0]!.id} cell={cell} />
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
                  mine.map((s) => <ScheduleView key={s.key} s={s} col={c.id} cell={cell} />)
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

/** Draws a schedule cell (a row of the schedule, in a return's column) as its figure. */
type Cell = (row: string, col: string, text: ReactNode) => ReactNode;

/** A schedule: its bands and rates are tax law; what fills them and what it owes are the return's figures. */
function ScheduleView({ s, col, cell }: { s: Schedule; col: string; cell: Cell }) {
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
                <td className="py-0.5 pr-2 text-left leading-snug text-fg-2">
                  <NotFigure why="set by tax law">{l.label}</NotFigure>
                </td>
                <td className="py-0.5 text-right tabular-nums text-fg">{cell(`sched:${s.key}:line:${i}`, col, l.kind === "rate" ? pct(l.value, 2) : usd(l.value))}</td>
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
                <NotFigure why="a bracket set by tax law">{band(row)}</NotFigure>
              </td>
              <td className="py-0.5 text-right tabular-nums">
                <NotFigure why="a rate set by tax law">{pct(row.rate, 2) === "—" ? "0%" : pct(row.rate, 2)}</NotFigure>
              </td>
              <td className="py-0.5 px-2">
                <FillBar row={row} />
              </td>
              <td className="py-0.5 text-right tabular-nums">{cell(`sched:${s.key}:band:${i}:included`, col, usd(row.included))}</td>
              <td className="py-0.5 pr-1 text-right tabular-nums">{cell(`sched:${s.key}:band:${i}:owed`, col, usd(row.owed))}</td>
            </tr>
          ))}
          <tr className="border-t border-line-strong font-semibold">
            <td className="py-0.5 pl-1 text-left">Total</td>
            <td className="py-0.5 text-right tabular-nums">{s.included > 0 ? cell(`sched:${s.key}:total:rate`, col, pct(s.owed / s.included, 1)) : "—"}</td>
            <td />
            <td className="py-0.5 text-right tabular-nums">{cell(`sched:${s.key}:total:included`, col, usd(s.included))}</td>
            <td className="py-0.5 pr-1 text-right tabular-nums">{cell(`sched:${s.key}:total:owed`, col, usd(s.owed))}</td>
          </tr>
        </tbody>
      </table>
      {s.note && (
        <p className="mt-auto pt-1 text-left text-[10px] text-muted">
          <NotFigure why="set by tax law">{s.note}</NotFigure>
        </p>
      )}
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
