/**
 * Paying a medical bill from the HSA today, or out of pocket and reimbursing it later: the
 * money math behind the Growth & strategy tab. Pure, so each piece is tested on its own.
 *
 * The HSA is maxed out every year either way, so the contribution, the tax it saves and
 * who funded it (you or your employer) are the same in both and drop out. Both ways also
 * cost the same $1,000 of take-home today. The only difference is where that $1,000 sits
 * until the plan year:
 *
 *  - Pay from the HSA now: the HSA pays the bill, and the $1,000 of take-home that would
 *    have paid it goes into a taxable account (dividends taxed each year, the gain when
 *    it's sold). The baseline.
 *  - Pay out of pocket, reimburse later: the bank pays the bill and the $1,000 stays
 *    invested in the HSA. In the plan year the receipt takes $1,000 out tax-free. The
 *    growth on top comes out tax-free only if other medical bills cover it (retiree care
 *    and Medicare premiums usually do); otherwise it's taxed.
 *
 * Not counted, because it's the same in both: the plan's premium and deductible, and fees
 * (both accounts are assumed to hold the same investments).
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
  key: "NOW" | "LATER";
  label: string;
  /** What the HSA pays toward the bill today. */
  fromHsaCents: number;
  /** What the bank (take-home) pays toward the bill today. */
  fromBankCents: number;
  /** Take-home put in a taxable account today instead of on the bill. */
  taxableNowCents: number;
  /** Money that stays invested in the HSA instead of paying the bill. */
  hsaNowCents: number;
  /** Plan-year worth of that money, after every tax. */
  worthCents: number;
  /** Plan-year wealth gained vs. paying from the HSA now. */
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

/** The two ways to pay a bill of `billCents` with the HSA maxed either way; waiting reimburses it in `planYear`. */
export function strategyRows(a: StrategyAssumptions, billCents: number, planYear: number): StrategyRow[] {
  const worthNow = Math.round(billCents * taxableAfterTax(a, a.years));
  const worthLater = Math.round(billCents * hsaAfterTax(a, a.years));
  const edge = worthLater - worthNow;
  const growthNote = a.growthCovered ? "growth too, if later bills cover it" : `growth taxed at ${pct(a.exitRate)}, no receipt behind it`;

  return [
    {
      key: "NOW",
      label: "Pay from the HSA now",
      fromHsaCents: billCents,
      fromBankCents: 0,
      taxableNowCents: billCents,
      hsaNowCents: 0,
      worthCents: worthNow,
      aheadCents: 0,
      note:
        `The HSA pays the ${usd(billCents)} bill. The ${usd(billCents)} of take-home you'd have spent on it goes into a taxable account instead: ` +
        `${usd(worthNow)} by ${planYear}, after the tax on its dividends and gain. The baseline.`,
    },
    {
      key: "LATER",
      label: `Pay out of pocket, reimburse in ${planYear}`,
      fromHsaCents: 0,
      fromBankCents: billCents,
      taxableNowCents: 0,
      hsaNowCents: billCents,
      worthCents: worthLater,
      aheadCents: edge,
      note:
        `The bank pays the ${usd(billCents)} bill; keep the receipt. The ${usd(billCents)} stays invested in the HSA, and in ${planYear} the receipt takes it out tax-free ` +
        `(${growthNote}): ${usd(worthLater)}. Waiting is ${edge >= 0 ? "+" : "−"}${usd(Math.abs(edge))} vs. paying now.`,
    },
  ];
}
