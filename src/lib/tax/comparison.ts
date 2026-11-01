import { allTaxes, type ReturnResult } from "./computeReturn.ts";
import type { TaxReport } from "./buildTaxReport.ts";

/**
 * Taxes › Joint vs separate as numbers: each spouse filing separately, the two combined, and
 * the joint return, line by line; and the dependent's effect. One pure function for the page
 * (TaxComparison) and its proofs (book/derived/taxes.ts), so the page draws the very values
 * the sweep holds.
 */

/** How a row reads: dollars, a rate, a balance due at filing (Owe / Refund / About even), a deduction with its kind. */
export type CompareKind = "usd" | "pct" | "balance" | "deduction" | "bracket";
export type CompareRow = { id: string; label: string; kind: CompareKind; values: (number | null)[]; words?: string[]; strong?: boolean; indent?: boolean; help?: string };

type Col = { id: string; name: string; r: ReturnResult | null; sum?: ReturnResult[] };

export function taxComparison(r: Pick<TaxReport, "scenarios" | "people">) {
  const mfs = r.scenarios.mfs;
  const separate: Col[] = r.people.map((p) => ({ id: p.id, name: `${p.name} (separate)`, r: mfs.returns[p.id] ?? null }));
  const cols: Col[] = [...separate, { id: "separate", name: "Separate total", r: null, sum: separate.flatMap((c) => (c.r ? [c.r] : [])) }, { id: "joint", name: "Joint", r: r.scenarios.mfj }];
  const each = (f: (x: ReturnResult) => number) => cols.map((c) => (c.r ? f(c.r) : (c.sum ?? []).reduce((s, x) => s + f(x), 0)));
  const fedTax = (x: ReturnResult) => x.federal.totalTax - x.federal.refundableChildCredit;
  const all = allTaxes;
  const hasNy = !!r.scenarios.mfj.ny;
  const gross = (x: ReturnResult) => x.grossPay + x.federal.interest + x.federal.ordinaryDividends + Math.max(0, x.federal.capitalGainAllowed) + x.federal.retirementTaxable + x.federal.otherIncome;
  const ratio = (num: (x: ReturnResult) => number, den: (x: ReturnResult) => number) =>
    cols.map((c) => {
      const rs = c.r ? [c.r] : (c.sum ?? []);
      const d = rs.reduce((s, x) => s + den(x), 0);
      return d > 0 ? rs.reduce((s, x) => s + num(x), 0) / d : null;
    });
  const usd = (id: string, label: string, f: (x: ReturnResult) => number, o: Partial<CompareRow> = {}): CompareRow => ({ id, label, kind: "usd", values: each(f), ...o });

  const rows: CompareRow[] = [
    usd("wages", "Wages (W-2 box 1)", (x) => x.federal.wages),
    usd("interest", "Interest", (x) => x.federal.interest, { indent: true }),
    usd("dividends", "Dividends (ordinary)", (x) => x.federal.ordinaryDividends, { indent: true }),
    usd("qualified", "of which qualified", (x) => x.federal.qualifiedDividends, { indent: true }),
    usd("gains", "Capital gain/loss (after $3k loss limit)", (x) => x.federal.capitalGainAllowed, { indent: true }),
    usd("retirement", "IRA/retirement (taxable)", (x) => x.federal.retirementTaxable, { indent: true }),
    usd("adjustments", "Adjustments", (x) => -x.federal.adjustments, { indent: true }),
    usd("agi", "Federal AGI", (x) => x.federal.agi, { strong: true }),
    {
      id: "deduction",
      label: "Deduction",
      kind: "deduction",
      values: each((x) => x.federal.deduction),
      words: cols.map((c) => {
        const rs = c.r ? [c.r] : (c.sum ?? []);
        return rs.every((x) => x.federal.itemizes) ? "itemized" : rs.some((x) => x.federal.itemizes) ? "mixed" : "standard";
      }),
      help: "Standard deduction 2026: $32,200 joint, $16,100 separate. SALT cap $40,400 joint / $20,200 separate.",
    },
    usd("qbi", "QBI deduction", (x) => x.federal.qbiDeduction, { indent: true }),
    usd("taxable", "Federal taxable income", (x) => x.federal.taxableIncome, { strong: true }),
    usd("ordinary-tax", "Tax on ordinary income", (x) => x.federal.ordinaryTax, { indent: true }),
    usd("preferential-tax", "Tax on qualified dividends & LT gains", (x) => x.federal.preferentialTax, { indent: true }),
    usd("amt", "Alternative minimum tax", (x) => x.federal.amt, { indent: true }),
    usd("credits", "Credits (child, care, foreign)", (x) => -(x.federal.nonrefundableCredits + x.federal.refundableChildCredit), { indent: true }),
    usd("medicare-extra", "Additional Medicare tax (0.9%)", (x) => x.federal.additionalMedicareTax, { indent: true, help: "0.9% of Medicare wages over $250k joint / $125k separate." }),
    usd("niit", "Net investment income tax (3.8%)", (x) => x.federal.niit, { indent: true, help: "3.8% of the smaller of investment income and AGI over $250k joint / $125k separate." }),
    usd("federal", "Federal tax", fedTax, { strong: true }),
    { id: "bracket", label: "Federal marginal bracket", kind: "bracket", values: cols.map((c) => (c.r && c.r.federal.taxableIncome > 0 ? c.r.federal.marginalBracket : null)) },
    usd("ct-agi", "CT AGI", (x) => x.ct.ctAgi, { strong: true, help: "Federal AGI minus CHET 529 contributions (up to $5k/$10k) and US-obligation interest." }),
    usd("ct-taxable", "CT taxable income", (x) => x.ct.taxableIncome),
    usd("ct-brackets", "Tax from brackets", (x) => x.ct.initialTax, { indent: true }),
    usd("ct-addback", "2% phase-out + benefit recapture", (x) => x.ct.addBack + x.ct.recapture, { indent: true }),
    usd("ct-credits", "Credits", (x) => -(x.ct.personalCredit + x.ct.childTaxCredit + x.ct.otherStateCredit), { indent: true }),
    usd("ct", "Connecticut tax", (x) => x.ct.totalTax, { strong: true }),
    ...(hasNy
      ? [
          usd("ny-agi", "New York AGI", (x) => x.ny?.nyAgi ?? 0, { strong: true }),
          usd("ny-taxable", "New York taxable income", (x) => x.ny?.taxableIncome ?? 0),
          usd("ny-brackets", "Tax from brackets", (x) => x.ny?.scheduleTax ?? 0, { indent: true }),
          usd("ny-recapture", "Benefit recapture (over $107,650 of AGI)", (x) => x.ny?.recapture ?? 0, { indent: true }),
          ...(r.scenarios.mfj.ny?.incomePercentage != null ? [usd("ny-share", "Cut to the New York share (part-year)", (x) => (x.ny ? x.ny.stateTax - x.ny.baseTax : 0), { indent: true })] : []),
          usd("ny-state", "New York State tax", (x) => x.ny?.stateTax ?? 0, { strong: true }),
          ...(r.scenarios.mfj.ny?.city ? [usd("ny-city", "New York City tax", (x) => x.ny?.cityTax ?? 0, { strong: true })] : []),
        ]
      : []),
    usd("social-security", "Social Security", (x) => x.fica.socialSecurity),
    usd("medicare", "Medicare (1.45%)", (x) => x.fica.medicare),
    usd("total", "Total tax", all, { strong: true }),
    { id: "effective", label: "Effective rate (all taxes ÷ gross income)", kind: "pct", values: ratio(all, gross) },
    { id: "effective-federal", label: "Effective federal rate (÷ AGI)", kind: "pct", values: ratio(fedTax, (x) => x.federal.agi) },
    { id: "federal-due", label: "Federal at filing", kind: "balance", values: each((x) => x.federal.balanceDue) },
    { id: "ct-due", label: "CT at filing", kind: "balance", values: each((x) => x.ct.balanceDue) },
    ...(hasNy ? [{ id: "ny-due", label: "New York at filing", kind: "balance" as const, values: each((x) => x.ny?.balanceDue ?? 0) }] : []),
  ];

  const diff = r.scenarios.mfs.totalTax - all(r.scenarios.mfj);
  const dependents: CompareRow[] = [
    { id: "dependent-joint", label: "Joint", kind: "usd", values: [all(r.scenarios.mfjNoDependents), all(r.scenarios.mfj), all(r.scenarios.mfjNoDependents) - all(r.scenarios.mfj)] },
    { id: "dependent-separate", label: "Separate (best combination)", kind: "usd", values: [r.scenarios.mfsNoDependents.totalTax, r.scenarios.mfs.totalTax, r.scenarios.mfsNoDependents.totalTax - r.scenarios.mfs.totalTax] },
  ];
  return { cols: cols.map((c) => ({ id: c.id, name: c.name })), rows, diff, dependents, dependentCols: ["without", "with", "savings"] };
}
