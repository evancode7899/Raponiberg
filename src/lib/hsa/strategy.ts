/**
 * How to pay a medical bill when the HSA is maxed either way: the money math behind the
 * Growth & strategy tab. Pure, so each piece is tested on its own.
 *
 * Every row is measured the same way: the household's wealth in the plan year, after
 * every tax, compared with having no HSA. Money that isn't spent today is assumed to
 * sit in a taxable brokerage account, so a dollar of cost today is worth
 * `taxableAfterTax(1)` dollars in the plan year.
 *
 *  - No HSA: pay the $1,000 bill with after-tax money, so it takes $1,000 ÷ (1 − τ)
 *    of pay, where τ is income tax plus payroll tax on the next dollar.
 *  - Pay from the HSA now: $1,000 of pay goes in pre-tax and straight out to the bill.
 *    Compared with no HSA, that's $1,000·τ of after-tax money (the tax saved) left over
 *    and invested in the taxable account.
 *  - Pay out of pocket, reimburse later: the same $1,000 goes in pre-tax but stays
 *    invested, and the bill is paid with $1,000 of after-tax money from the bank, which
 *    then never grows in the taxable account. In the plan year the receipt takes $1,000
 *    out tax-free. The growth on top comes out tax-free only if other medical bills
 *    cover it (retiree care and Medicare premiums usually do); otherwise it's taxed.
 *
 * The two HSA rows share the contribution and its tax saved; they differ only in where
 * $1,000 sits until the plan year: the HSA (no tax on dividends or growth) or the taxable
 * account (tax on dividends each year, and on the gain when it's sold). That difference
 * is the whole case for waiting, so it's computed once (waitEdge) and never stacked on
 * top of the tax saved twice.
 *
 * Not counted, because it's the same in every row or not about the bill: employer
 * contributions (yours whenever you're on the HSA-eligible plan), the plan's premium and
 * deductible, and fees (both accounts are assumed to hold the same investments).
 */

export type StrategyAssumptions = {
  /** Total annual return, the same investments in both accounts. */
  rate: number;
  /** Part of that return paid each year as dividends (taxed yearly in a taxable account). */
  dividendYield: number;
  /** Tax on taxable-account dividends and gains (federal LTCG + NIIT + state). */
  taxableRate: number;
  /** Income tax on the next dollar of pay (federal + state). */
  marginalRate: number;
  /** Social Security + Medicare on the next dollar of pay, saved when contributing through payroll. */
  payrollRate: number;
  /** Other qualified medical bills will cover the HSA's growth, so it also comes out tax-free. */
  growthCovered: boolean;
  /** Tax on HSA growth that comes out with no receipt behind it (after 65: ordinary income). */
  exitRate: number;
  /** Whole years from now to the plan year. */
  years: number;
};

export type StrategyRow = {
  key: "NONE" | "NOW" | "LATER";
  label: string;
  /** Pay, before tax, that this way uses today (contribution and bill together). */
  payNowCents: number;
  /** After-tax money it costs today. */
  costNowCents: number;
  /** Tax not paid on the HSA contribution (zero without one). */
  taxSavedCents: number;
  /** After-tax money that comes back out of the HSA in the plan year. */
  hsaLaterCents: number;
  /** Plan-year wealth gained vs. no HSA, after every tax. */
  aheadCents: number;
  note: string;
};

/**
 * Plan-year value, after selling and paying the tax on the gain, of $1 put in a taxable
 * account today. Dividends are taxed as they're paid and the rest reinvested (adding to
 * basis); price growth is taxed once, at the sale.
 */
export function taxableAfterTax(a: Pick<StrategyAssumptions, "rate" | "dividendYield" | "taxableRate">, years: number): number {
  const d = Math.min(Math.max(0, a.dividendYield), Math.max(0, a.rate));
  let value = 1;
  let basis = 1;
  for (let y = 0; y < years; y++) {
    const dividend = value * d;
    const tax = dividend * a.taxableRate;
    value = value * (1 + a.rate) - tax;
    basis += dividend - tax;
  }
  return value - a.taxableRate * Math.max(0, value - basis);
}

/** Plan-year value, after any tax, of $1 left invested in the HSA against a receipt and taken out then. */
export function hsaAfterTax(a: Pick<StrategyAssumptions, "rate" | "growthCovered" | "exitRate">, years: number): number {
  const growth = Math.pow(1 + a.rate, years) - 1;
  return 1 + growth * (a.growthCovered ? 1 : 1 - a.exitRate);
}

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const pct = (v: number) => `${+(v * 100).toFixed(2)}%`;

/** The three ways to pay a bill of `billCents`, reimbursed (if at all) in `planYear`. */
export function strategyRows(a: StrategyAssumptions, billCents: number, planYear: number): StrategyRow[] {
  const tau = Math.min(0.95, a.marginalRate + a.payrollRate);
  const taxable = taxableAfterTax(a, a.years);
  const hsa = hsaAfterTax(a, a.years);
  const pay = (afterTax: number) => afterTax / (1 - tau);
  const taxSaved = billCents * tau;

  // After-tax cost today: no HSA, the bill; HSA now, the contribution net of its tax saved;
  // out of pocket, that contribution plus the bill from the bank.
  const costNone = billCents;
  const costNow = billCents - taxSaved;
  const costLater = billCents - taxSaved + billCents;
  const hsaLater = billCents * hsa;
  // Ahead in the plan year: what the cheaper cost today would have grown to in the taxable
  // account, plus whatever comes back out of the HSA.
  const ahead = (cost: number, back: number) => Math.round((costNone - cost) * taxable + back);
  const aheadNow = ahead(costNow, 0);
  const aheadLater = ahead(costLater, hsaLater);
  const waitEdge = aheadLater - aheadNow;
  const growthNote = a.growthCovered ? "growth too, if later bills cover it" : `growth taxed at ${pct(a.exitRate)}, no receipt behind it`;

  return [
    {
      key: "NONE",
      label: "No HSA",
      payNowCents: Math.round(pay(costNone)),
      costNowCents: Math.round(costNone),
      taxSavedCents: 0,
      hsaLaterCents: 0,
      aheadCents: 0,
      note: `The bill is paid with after-tax money: ${usd(pay(costNone))} of pay at ${pct(tau)} tax. The baseline.`,
    },
    {
      key: "NOW",
      label: "Pay from the HSA now",
      payNowCents: billCents,
      costNowCents: Math.round(costNow),
      taxSavedCents: Math.round(taxSaved),
      hsaLaterCents: 0,
      aheadCents: aheadNow,
      note: `${usd(billCents)} of pay goes in pre-tax and straight out to the bill. The ${usd(taxSaved)} of tax saved, invested in a taxable account, is ${usd(aheadNow)} by ${planYear}.`,
    },
    {
      key: "LATER",
      label: `Pay out of pocket, reimburse in ${planYear}`,
      // The contribution (pre-tax) plus the pay that earned the bank money for the bill.
      payNowCents: Math.round(billCents + pay(billCents)),
      costNowCents: Math.round(costLater),
      taxSavedCents: Math.round(taxSaved),
      hsaLaterCents: Math.round(hsaLater),
      aheadCents: aheadLater,
      note:
        `The same ${usd(billCents)} goes in pre-tax and stays invested; the bill takes ${usd(billCents)} from the bank (${usd(pay(billCents))} of pay). ` +
        `In ${planYear} the receipt takes ${usd(billCents)} out tax-free (${growthNote}). ` +
        `That bank money would have been ${usd(billCents * taxable)} in a taxable account, so waiting is ${waitEdge >= 0 ? "+" : "−"}${usd(Math.abs(waitEdge))} vs. paying now.`,
    },
  ];
}
