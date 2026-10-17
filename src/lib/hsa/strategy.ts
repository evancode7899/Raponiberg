/**
 * How to pay a medical bill from an HSA funded partly by you (pre-tax, through payroll)
 * and partly by your employer: the money math behind the Growth & strategy tab. Pure, so
 * each piece is tested on its own.
 *
 * Every row is measured the same way: the household's wealth in the plan year, after
 * every tax, compared with having no HSA. Money that isn't spent today is assumed to
 * sit in a taxable brokerage account, so a dollar of cost today is worth
 * `taxableAfterTax(1)` dollars in the plan year.
 *
 * Of each $1,000 of HSA money, a share `e` comes from your pay and the rest from the
 * employer. Your share costs $1,000·e·(1 − τ) of take-home (τ: income + payroll tax on the
 * next dollar); the employer's share costs you nothing. Only your share saves tax.
 *
 *  - No HSA: pay the $1,000 bill from the bank, with after-tax money. The baseline.
 *  - Pay from the HSA now: the HSA pays the bill, so the whole $1,000 that would have left
 *    the bank stays there, less the take-home your share cost. That money is invested in
 *    the taxable account.
 *  - Pay out of pocket, reimburse later: the bank pays the bill (as with no HSA) and your
 *    share still costs its take-home, but the whole $1,000 stays invested in the HSA. In
 *    the plan year the receipt takes $1,000 out tax-free. The growth on top comes out
 *    tax-free only if other medical bills cover it (retiree care and Medicare premiums
 *    usually do); otherwise it's taxed.
 *
 * The two HSA rows put the same money in; they differ only in where $1,000 sits until the
 * plan year: the HSA (no tax on dividends or growth) or the taxable account (tax on
 * dividends each year, and on the gain when it's sold). That gap is the whole case for
 * waiting, and it doesn't depend on who funded the HSA: the split moves both rows against
 * no HSA by the same amount.
 *
 * Not counted, because it's the same in every row or not about the bill: the plan's
 * premium and deductible, and fees (both accounts are assumed to hold the same investments).
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
  /** Your pay, before tax, that this way uses today (your part of the contribution and any bank-paid bill). */
  payNowCents: number;
  /** Take-home it costs you today. */
  costNowCents: number;
  /** The employer's part of the HSA money (zero without one). */
  employerCents: number;
  /** Tax not paid on your part of the contribution (zero without one). */
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

/**
 * The three ways to pay a bill of `billCents`, reimbursed (if at all) in `planYear`, when
 * `employeeShare` (0–1) of the HSA money comes from your pay and the rest from the employer.
 */
export function strategyRows(a: StrategyAssumptions, billCents: number, planYear: number, employeeShare = 1): StrategyRow[] {
  const tau = Math.min(0.95, a.marginalRate + a.payrollRate);
  const e = Math.min(1, Math.max(0, employeeShare));
  const taxable = taxableAfterTax(a, a.years);
  const hsa = hsaAfterTax(a, a.years);
  const pay = (afterTax: number) => afterTax / (1 - tau);

  const yours = billCents * e;
  const employer = billCents - yours;
  const taxSaved = yours * tau;
  const yourTakeHome = yours - taxSaved;
  // Take-home spent today: no HSA, the bill; HSA now, only what your share of the HSA
  // money cost; out of pocket, that plus the bill from the bank.
  const costNone = billCents;
  const costNow = yourTakeHome;
  const costLater = yourTakeHome + billCents;
  const hsaLater = billCents * hsa;
  // Ahead in the plan year: what spending less today would have grown to in the taxable
  // account (negative when it costs more), plus whatever comes back out of the HSA.
  const ahead = (cost: number, back: number) => Math.round((costNone - cost) * taxable + back);
  const aheadNow = ahead(costNow, 0);
  const aheadLater = ahead(costLater, hsaLater);
  const waitEdge = aheadLater - aheadNow;
  const growthNote = a.growthCovered ? "growth too, if later bills cover it" : `growth taxed at ${pct(a.exitRate)}, no receipt behind it`;
  const funded =
    e >= 1 ? `all ${usd(billCents)} from your pay, pre-tax (${usd(yourTakeHome)} of take-home)`
    : e <= 0 ? `all ${usd(billCents)} from your employer, nothing from you`
    : `${usd(employer)} from your employer, ${usd(yours)} from your pay pre-tax (${usd(yourTakeHome)} of take-home)`;

  return [
    {
      key: "NONE",
      label: "No HSA",
      payNowCents: Math.round(pay(costNone)),
      costNowCents: Math.round(costNone),
      employerCents: 0,
      taxSavedCents: 0,
      hsaLaterCents: 0,
      aheadCents: 0,
      note: `The bill is paid from the bank with after-tax money: ${usd(pay(costNone))} of pay at ${pct(tau)} tax. The baseline.`,
    },
    {
      key: "NOW",
      label: "Pay from the HSA now",
      payNowCents: Math.round(yours),
      costNowCents: Math.round(costNow),
      employerCents: Math.round(employer),
      taxSavedCents: Math.round(taxSaved),
      hsaLaterCents: 0,
      aheadCents: aheadNow,
      note:
        `The HSA pays the bill: ${funded}. ` +
        `The ${usd(billCents)} that stays in the bank${e > 0 ? `, less that ${usd(yourTakeHome)}` : ""}, is ${usd(costNone - costNow)} invested in a taxable account: ${usd(aheadNow)} by ${planYear}.`,
    },
    {
      key: "LATER",
      label: `Pay out of pocket, reimburse in ${planYear}`,
      // Your share (pre-tax) plus the pay that earned the bank money for the bill.
      payNowCents: Math.round(yours + pay(billCents)),
      costNowCents: Math.round(costLater),
      employerCents: Math.round(employer),
      taxSavedCents: Math.round(taxSaved),
      hsaLaterCents: Math.round(hsaLater),
      aheadCents: aheadLater,
      note:
        `The same ${usd(billCents)} goes into the HSA and stays invested: ${funded}. The bill takes ${usd(billCents)} from the bank, as with no HSA. ` +
        `In ${planYear} the receipt takes ${usd(billCents)} out tax-free (${growthNote}): ${usd(hsaLater)}` +
        (e > 0 ? `, less the ${usd(yourTakeHome * taxable)} your ${usd(yourTakeHome)} would have grown to in a taxable account. ` : ". ") +
        `Waiting is ${waitEdge >= 0 ? "+" : "−"}${usd(Math.abs(waitEdge))} vs. paying now, whoever funds the HSA.`,
    },
  ];
}
