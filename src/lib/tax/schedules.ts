import type { PersonIncome, ReturnResult } from "./computeReturn.ts";
import { FEDERAL_RATES, type FilingStatus, type TaxYearParams } from "./params.ts";

/**
 * Bracket-by-bracket schedules for one computed return: how much income falls in each
 * band and what it owes there, plus the step-by-step calculations (NIIT, CT recapture)
 * that aren't brackets. Pure; the worksheet renders these and the tests check that each
 * schedule adds up to the figure the return engine produced.
 */

export type BracketRow = {
  from: number;
  /** null: no upper bound. */
  to: number | null;
  rate: number;
  included: number;
  owed: number;
};

export type CalcLine = { label: string; value: number; kind?: "rate" | "money"; strong?: boolean; help?: string };

export type Schedule =
  | { key: string; title: string; kind: "brackets"; rows: BracketRow[]; included: number; owed: number; note?: string }
  | { key: string; title: string; kind: "lines"; lines: CalcLine[]; note?: string };

function fill(amount: number, bounds: number[], rates: readonly number[], offset = 0): BracketRow[] {
  const rows: BracketRow[] = [];
  let lower = 0;
  for (let i = 0; i < rates.length; i++) {
    const upper = bounds[i] ?? null;
    const lo = Math.max(lower, offset);
    const hi = upper == null ? offset + amount : Math.min(upper, offset + amount);
    const included = Math.max(0, hi - lo);
    rows.push({ from: lower, to: upper, rate: rates[i]!, included, owed: Math.round(included * rates[i]!) });
    if (upper == null) break;
    lower = upper;
  }
  return rows;
}

const brackets = (key: string, title: string, rows: BracketRow[], note?: string): Schedule => ({
  key,
  title,
  kind: "brackets",
  rows,
  included: rows.reduce((s, r) => s + r.included, 0),
  owed: rows.reduce((s, r) => s + r.owed, 0),
  note,
});

export function returnSchedules(r: ReturnResult, people: PersonIncome[], params: TaxYearParams): Schedule[] {
  const fp = params.federal;
  const cp = params.ct;
  const fs: FilingStatus = r.filingStatus;
  const f = r.federal;
  const ordinary = f.taxableIncome - f.preferentialIncome;
  const out: Schedule[] = [];

  out.push(brackets("fed", "Federal tax brackets", fill(ordinary, fp.brackets[fs], FEDERAL_RATES), "Ordinary taxable income (taxable income minus qualified dividends and long-term gains)."));

  const cg = fp.capitalGains[fs];
  out.push(
    brackets(
      "pref",
      "Qualified dividends & long-term gains",
      fill(f.preferentialIncome, [cg.zeroMax, cg.fifteenMax], [0, 0.15, 0.2], ordinary),
      "Stacked on top of ordinary income: the bands are measured on total taxable income.",
    ),
  );

  const fedLines: CalcLine[] = [
    { label: "Tax on ordinary income", value: f.ordinaryTax },
    { label: "Tax on qualified dividends & LT gains", value: f.preferentialTax },
  ];
  if (f.amt) fedLines.push({ label: "Alternative minimum tax", value: f.amt });
  if (f.nonrefundableCredits) fedLines.push({ label: "Credits (child, dependent care, foreign tax)", value: -f.nonrefundableCredits });
  fedLines.push(
    { label: "Income tax after credits", value: f.incomeTaxAfterCredits, strong: true },
    { label: "Additional Medicare tax (0.9%)", value: f.additionalMedicareTax },
    { label: "Net investment income tax (3.8%)", value: f.niit },
  );
  if (f.refundableChildCredit) fedLines.push({ label: "Refundable child credit", value: -f.refundableChildCredit });
  fedLines.push({ label: "Total federal tax", value: f.totalTax - f.refundableChildCredit, strong: true });
  out.push({ key: "fedcalc", title: "Federal tax calculation", kind: "lines", lines: fedLines });

  const medicareWages = people.reduce((s, p) => s + p.w2s.reduce((t, w) => t + w.box5MedicareWages, 0), 0);
  const threshold = fp.surtaxThreshold[fs];
  out.push(
    brackets(
      "medicare",
      "Medicare tax",
      fill(medicareWages, [threshold], [fp.medicareRate, fp.medicareRate + fp.additionalMedicareRate]),
      `1.45% on all wages plus 0.9% above ${fs === "MFJ" ? "$250,000 joint" : fs === "MFS" ? "$125,000 separate" : "$200,000"} (box 5 wages).`,
    ),
  );

  out.push({
    key: "niit",
    title: "Net investment income tax",
    kind: "lines",
    lines: [
      { label: "AGI above threshold", value: Math.max(0, f.agi - threshold) },
      { label: "Net investment income", value: f.netInvestmentIncome },
      { label: "Lesser of the two", value: Math.min(Math.max(0, f.agi - threshold), f.netInvestmentIncome) },
      { label: "Rate", value: fp.niitRate, kind: "rate" },
      { label: "NIIT owed", value: f.niit, strong: true },
    ],
  });

  for (const p of people) {
    const box5 = p.w2s.reduce((s, w) => s + w.box5MedicareWages, 0);
    const ssWages = Math.min(fp.socialSecurity.wageBase, p.w2s.reduce((s, w) => s + w.box3SsWages, 0));
    const rows: BracketRow[] = [
      { from: 0, to: fp.socialSecurity.wageBase, rate: fp.socialSecurity.rate, included: ssWages, owed: Math.round(ssWages * fp.socialSecurity.rate) },
      { from: fp.socialSecurity.wageBase, to: null, rate: 0, included: Math.max(0, box5 - ssWages), owed: 0 },
    ];
    out.push(brackets(`ss-${p.id}`, people.length > 1 ? `Social Security — ${p.name}` : "Social Security", rows, "6.2% of wages up to the wage base, per person."));
  }

  const ctRows = fill(
    r.ct.taxableIncome,
    cp.brackets[fs].slice(0, -1).map(([u]) => u),
    cp.brackets[fs].map(([, rate]) => rate),
  );
  out.push(brackets("ct", "Connecticut tax brackets", ctRows, "Connecticut taxable income (CT AGI minus the personal exemption)."));

  const ctLines: CalcLine[] = [
    { label: "Tax from brackets", value: r.ct.initialTax },
    { label: "2% rate phase-out add-back (Table C)", value: r.ct.addBack, help: "Takes back the benefit of the 2% bracket as income rises." },
    { label: "Benefit recapture (Table D)", value: r.ct.recapture, help: "Takes back the benefit of the lower brackets at higher incomes." },
  ];
  if (r.ct.personalCredit) ctLines.push({ label: `Personal tax credit (${Math.round(r.ct.personalCreditRate * 100)}%)`, value: -r.ct.personalCredit });
  if (r.ct.otherStateCredit) ctLines.push({ label: "Credit for tax paid to other states", value: -r.ct.otherStateCredit });
  if (r.ct.childTaxCredit) ctLines.push({ label: "CT child tax credit", value: -r.ct.childTaxCredit });
  ctLines.push({ label: "Connecticut income tax", value: r.ct.totalTax, strong: true });
  out.push({ key: "ctcalc", title: "Connecticut tax calculation", kind: "lines", lines: ctLines });

  for (const p of people) {
    const wages = p.w2s.reduce((s, w) => s + w.box3SsWages, 0);
    const base = fp.socialSecurity.wageBase;
    const rows: BracketRow[] = [
      { from: 0, to: base, rate: cp.pfmlRate, included: Math.min(wages, base), owed: Math.round(Math.min(wages, base) * cp.pfmlRate) },
      { from: base, to: null, rate: 0, included: Math.max(0, p.w2s.reduce((s, w) => s + w.box5MedicareWages, 0) - base), owed: 0 },
    ];
    out.push(brackets(`pfml-${p.id}`, people.length > 1 ? `CT Paid Leave — ${p.name}` : "CT Paid Leave (PFML)", rows, "0.5% of wages up to the Social Security wage base."));
  }

  const ny = r.ny;
  if (ny) {
    const np = params.ny;
    const bounds = (b: [number, number][]) => b.slice(0, -1).map(([u]) => u);
    const rates = (b: [number, number][]) => b.map(([, rate]) => rate);
    out.push(
      brackets(
        "ny",
        "New York State tax brackets",
        fill(ny.taxableIncome, bounds(np.brackets[fs]), rates(np.brackets[fs])),
        "New York taxable income (New York AGI minus the standard deduction and $1,000 per dependent). Above $107,650 of AGI the lower brackets' benefit is taken back — see the calculation.",
      ),
    );
    const nyLines: CalcLine[] = [
      { label: "Tax from brackets", value: ny.scheduleTax },
      { label: "Benefit recapture (tax computation worksheet)", value: ny.recapture, help: "Takes back the lower brackets' benefit as AGI passes $107,650; fully phased in, every dollar is at your top rate." },
      { label: "Tax on all income", value: ny.baseTax, strong: true },
    ];
    if (ny.incomePercentage != null) {
      nyLines.push({ label: "New York share of income (IT-203 line 45)", value: ny.incomePercentage, kind: "rate", help: "Income while a New York resident, plus New York-source income, ÷ New York AGI." });
    }
    nyLines.push({ label: "New York State tax", value: ny.stateTax, strong: true });
    if (ny.city) {
      nyLines.push(
        { label: "New York City tax", value: ny.city.tax },
        { label: "NYC school tax credits (refundable)", value: -(ny.city.schoolCredit + ny.city.schoolRateReduction) },
      );
    }
    nyLines.push({ label: "New York taxes after credits", value: ny.totalTax - (ny.city ? ny.city.schoolCredit + ny.city.schoolRateReduction : 0), strong: true });
    out.push({ key: "nycalc", title: "New York tax calculation", kind: "lines", lines: nyLines });
    if (ny.city) {
      out.push(
        brackets(
          "nyc",
          "New York City tax brackets",
          fill(ny.city.taxableIncome, bounds(np.nyc.brackets[fs]), rates(np.nyc.brackets[fs])),
          ny.filing.city === "PART_YEAR"
            ? `Part-year (IT-360.1): income while living in the City less ${ny.filing.cityMonths}/12 of the deduction and exemptions.`
            : "City taxable income is the same as New York State's.",
        ),
      );
    }
  }
  return out;
}
