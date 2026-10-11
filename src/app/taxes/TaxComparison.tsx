"use client";

import { Card } from "@/components/ledger/LedgerBits";
import type { ReturnResult } from "@/lib/tax/computeReturn";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { balanceText, NumberTable, pct, usd, type Row } from "./taxUi";

type Col = { name: string; r: ReturnResult | null; sum?: ReturnResult[] };

/** Line-by-line: each spouse filing separately, the two combined, and the joint return. */
export function TaxComparison({ r }: { r: TaxResponse }) {
  const mfs = r.scenarios.mfs;
  const separate = r.people.map((p) => ({ name: `${p.name} (separate)`, r: mfs.returns[p.id] ?? null }));
  const cols: Col[] = [...separate, { name: "Separate total", r: null, sum: separate.flatMap((c) => (c.r ? [c.r] : [])) }, { name: "Joint", r: r.scenarios.mfj }];
  const v = (f: (x: ReturnResult) => number) => cols.map((c) => usd(c.r ? f(c.r) : (c.sum ?? []).reduce((s, x) => s + f(x), 0)));
  const raw = (f: (x: ReturnResult) => number) => cols.map((c) => (c.r ? f(c.r) : (c.sum ?? []).reduce((s, x) => s + f(x), 0)));
  const fedTax = (x: ReturnResult) => x.federal.totalTax - x.federal.refundableChildCredit;
  const all = (x: ReturnResult) => fedTax(x) + x.ct.totalTax + (x.ny?.totalTax ?? 0) + x.fica.socialSecurity + x.fica.medicare + x.otherStateTax;
  const hasNy = !!r.scenarios.mfj.ny;
  const gross = (x: ReturnResult) => x.grossPay + x.federal.interest + x.federal.ordinaryDividends + Math.max(0, x.federal.capitalGainAllowed) + x.federal.retirementTaxable + x.federal.otherIncome;
  const ratio = (num: (x: ReturnResult) => number, den: (x: ReturnResult) => number) =>
    cols.map((c) => {
      const rs = c.r ? [c.r] : c.sum ?? [];
      const d = rs.reduce((s, x) => s + den(x), 0);
      return d > 0 ? pct(rs.reduce((s, x) => s + num(x), 0) / d) : "—";
    });

  const rows: Row[] = [
    { label: "Wages (W-2 box 1)", values: v((x) => x.federal.wages) },
    { label: "Interest", values: v((x) => x.federal.interest), indent: true },
    { label: "Dividends (ordinary)", values: v((x) => x.federal.ordinaryDividends), indent: true },
    { label: "of which qualified", values: v((x) => x.federal.qualifiedDividends), indent: true },
    { label: "Capital gain/loss (after $3k loss limit)", values: v((x) => x.federal.capitalGainAllowed), indent: true },
    { label: "IRA/retirement (taxable)", values: v((x) => x.federal.retirementTaxable), indent: true },
    { label: "Adjustments", values: v((x) => -x.federal.adjustments), indent: true },
    { label: "Federal AGI", values: v((x) => x.federal.agi), strong: true },
    {
      label: "Deduction",
      values: cols.map((c) => {
        const rs = c.r ? [c.r] : c.sum ?? [];
        const d = rs.reduce((s, x) => s + x.federal.deduction, 0);
        const kind = rs.every((x) => x.federal.itemizes) ? "itemized" : rs.some((x) => x.federal.itemizes) ? "mixed" : "standard";
        return `${usd(d)} ${kind}`;
      }),
      help: "Standard deduction 2026: $32,200 joint, $16,100 separate. SALT cap $40,400 joint / $20,200 separate.",
    },
    { label: "QBI deduction", values: v((x) => x.federal.qbiDeduction), indent: true },
    { label: "Federal taxable income", values: v((x) => x.federal.taxableIncome), strong: true },
    { label: "Tax on ordinary income", values: v((x) => x.federal.ordinaryTax), indent: true },
    { label: "Tax on qualified dividends & LT gains", values: v((x) => x.federal.preferentialTax), indent: true },
    { label: "Alternative minimum tax", values: v((x) => x.federal.amt), indent: true },
    { label: "Credits (child, care, foreign)", values: v((x) => -(x.federal.nonrefundableCredits + x.federal.refundableChildCredit)), indent: true },
    { label: "Additional Medicare tax (0.9%)", values: v((x) => x.federal.additionalMedicareTax), indent: true, help: "0.9% of Medicare wages over $250k joint / $125k separate." },
    { label: "Net investment income tax (3.8%)", values: v((x) => x.federal.niit), indent: true, help: "3.8% of the smaller of investment income and AGI over $250k joint / $125k separate." },
    { label: "Federal tax", values: v(fedTax), strong: true },
    { label: "Federal marginal bracket", values: cols.map((c) => (c.r && c.r.federal.taxableIncome > 0 ? pct(c.r.federal.marginalBracket, 0) : "")) },
    { label: "CT AGI", values: v((x) => x.ct.ctAgi), strong: true, help: "Federal AGI minus CHET 529 contributions (up to $5k/$10k) and US-obligation interest." },
    { label: "CT taxable income", values: v((x) => x.ct.taxableIncome) },
    { label: "Tax from brackets", values: v((x) => x.ct.initialTax), indent: true },
    { label: "2% phase-out + benefit recapture", values: v((x) => x.ct.addBack + x.ct.recapture), indent: true },
    { label: "Credits", values: v((x) => -(x.ct.personalCredit + x.ct.childTaxCredit + x.ct.otherStateCredit)), indent: true },
    { label: "Connecticut tax", values: v((x) => x.ct.totalTax), strong: true },
    ...(hasNy
      ? [
          { label: "New York AGI", values: v((x) => x.ny?.nyAgi ?? 0), strong: true },
          { label: "New York taxable income", values: v((x) => x.ny?.taxableIncome ?? 0) },
          { label: "Tax from brackets", values: v((x) => x.ny?.scheduleTax ?? 0), indent: true },
          { label: "Benefit recapture (over $107,650 of AGI)", values: v((x) => x.ny?.recapture ?? 0), indent: true },
          ...(r.scenarios.mfj.ny?.incomePercentage != null ? [{ label: "Cut to the New York share (part-year)", values: v((x) => (x.ny ? x.ny.stateTax - x.ny.baseTax : 0)), indent: true }] : []),
          { label: "New York State tax", values: v((x) => x.ny?.stateTax ?? 0), strong: true },
          ...(r.scenarios.mfj.ny?.city ? [{ label: "New York City tax", values: v((x) => x.ny?.cityTax ?? 0), strong: true }] : []),
        ]
      : []),
    { label: "Social Security", values: v((x) => x.fica.socialSecurity) },
    { label: "Medicare (1.45%)", values: v((x) => x.fica.medicare) },
    { label: "Total tax", values: v(all), strong: true },
    { label: "Effective rate (all taxes ÷ gross income)", values: ratio(all, gross) },
    { label: "Effective federal rate (÷ AGI)", values: ratio(fedTax, (x) => x.federal.agi) },
    { label: "Federal at filing", values: raw((x) => x.federal.balanceDue).map(balanceText) },
    { label: "CT at filing", values: raw((x) => x.ct.balanceDue).map(balanceText) },
    ...(hasNy ? [{ label: "New York at filing", values: raw((x) => x.ny?.balanceDue ?? 0).map(balanceText) }] : []),
  ];

  const diff = r.scenarios.mfs.totalTax - all(r.scenarios.mfj);
  const depJoint = all(r.scenarios.mfjNoDependents) - all(r.scenarios.mfj);
  const depSeparate = r.scenarios.mfsNoDependents.totalTax - r.scenarios.mfs.totalTax;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Married filing jointly vs separately"
        subtitle={
          Math.abs(diff) < 100
            ? "Both come out about the same."
            : diff > 0
              ? `Filing jointly saves ${usd(diff)}.`
              : `Filing separately saves ${usd(-diff)}.`
        }
      >
        <NumberTable columns={cols.map((c) => c.name)} rows={rows} />
        <p className="mt-2 text-xs text-muted">
          Filing separately: each spouse reports their own pay and accounts; joint accounts, joint estimated payments and household deductions are split
          evenly. Separate filers lose the dependent-care credit, get half the SALT cap and capital-loss limit, and hit the 0.9%/3.8% surtaxes and the
          child-credit phase-out at half the joint thresholds.
        </p>
      </Card>
      <Card title="Effect of the dependent">
        <NumberTable
          columns={["Without", "With", "Savings"]}
          rows={[
            { label: "Joint", values: [usd(all(r.scenarios.mfjNoDependents)), usd(all(r.scenarios.mfj)), usd(depJoint)] },
            { label: "Separate (best combination)", values: [usd(r.scenarios.mfsNoDependents.totalTax), usd(r.scenarios.mfs.totalTax), usd(depSeparate)] },
          ]}
        />
      </Card>
    </div>
  );
}
