/**
 * Pay down the mortgage or invest the difference.
 *
 * Every strategy spends exactly the same cash each month: the scheduled payment M, the
 * extra E, and any lump sum due that month. The only question is where the spare dollars
 * go — the loan or a brokerage account. Once a loan is gone its whole M (and E) is
 * invested, so all paths stay comparable at any month. The home is the same in every
 * path, so it drops out; net worth here = investments (after the tax due if sold) − loan.
 *
 * Month m (1-based; m = 1 is the first payment):
 *   1. A lump sum lands at the start of the month: to the loan (saving this month's
 *      interest) or to investments (earning this month's return). A lump bigger than the
 *      balance spills into investments.
 *   2. Investments earn the month's return. In a taxable account the dividend part is
 *      taxed as it's paid (from the account) and the after-tax dividend adds to basis.
 *   3. The loan accrues interest; the scheduled payment min(M, balance + interest) is made.
 *   4. The extra E goes to the loan (capped at the balance) or to investments; whatever
 *      of M + E the loan no longer needs is invested.
 *   5. In December (and at the last month) the year's mortgage-interest deduction is
 *      settled: the tax saved — only the part above the standard deduction — is invested.
 *
 * Interest on the part of the balance above the acquisition-debt cap ($750k) isn't
 * deductible. Lumps never re-amortize the loan: M stays fixed and the payoff comes sooner.
 */

export type Lump = {
  /** Groups the entries of one recurring row, so its opportunity cost can be shown once. */
  id: string;
  /** 1-based loan month (first payment = 1). */
  month: number;
  amount: number;
};

export type MortgagePlan = {
  principal: number;
  annualRate: number;
  termMonths: number;
  /** Calendar month/year of the first payment: tax years run Jan–Dec. */
  startYear: number;
  startMonth: number;
  extraMonthly: number;
  lumps: Lump[];
  /** How far to run, in months (can pass the loan's term). */
  horizonMonths: number;
  /** Expected compound annual total return of the investments (before tax). */
  investReturn: number;
  /** Part of that return paid out as dividends each year. */
  dividendYield: number;
  /** Tax on dividends as paid and on gains when sold (federal LTCG + NIIT + state). */
  investTaxRate: number;
  /** Roth/401(k)-style account: no tax on dividends or gains. */
  taxFreeAccount: boolean;
  /** Value the investments net of the capital-gains tax due if sold at that point. */
  sellAtHorizon: boolean;
  /** Itemize and deduct mortgage interest. */
  deductInterest: boolean;
  /** Marginal ordinary income rate (federal + state) on the deduction. */
  marginalRate: number;
  /** Standard deduction in the first payment's year; grows with inflation. */
  standardDeduction: number;
  /** Other itemized deductions (state & local tax up to the cap, charity) through 2029. */
  otherItemized: number;
  /** Same from 2030, when the SALT cap returns to $10k under current law. */
  otherItemizedFrom2030: number;
  /** Acquisition debt whose interest is deductible ($750k for loans after Dec 15, 2017). */
  debtCap: number;
  /** For today's-dollar figures and the standard deduction's growth. */
  inflation: number;
};

export type Strategy = {
  extraToLoan: boolean;
  /** Which lumps go to the loan; the rest are invested. */
  lumpToLoan: (lump: Lump) => boolean;
};

export const INVEST_ALL: Strategy = { extraToLoan: false, lumpToLoan: () => false };
export const PREPAY_ALL: Strategy = { extraToLoan: true, lumpToLoan: () => true };
export const PREPAY_EXTRA_ONLY: Strategy = { extraToLoan: true, lumpToLoan: () => false };
export const PREPAY_LUMPS_ONLY: Strategy = { extraToLoan: false, lumpToLoan: () => true };

/** Month-by-month state of one path; index 0 is the start (before the first payment). */
export type PathSeries = {
  balance: Float64Array;
  /** Investment account value before any tax on unrealized gains. */
  invested: Float64Array;
  basis: Float64Array;
  /** Investments net of the tax due if sold (= invested when not selling or tax-free). */
  investedNet: Float64Array;
  /** investedNet − balance. */
  netWorth: Float64Array;
  /** Cumulative interest paid. */
  interest: Float64Array;
  /** Cumulative tax saved by the interest deduction. */
  deduction: Float64Array;
  /** Cumulative tax paid on dividends. */
  dividendTax: Float64Array;
  /** Cumulative cash sent to the loan (scheduled + extra + lumps). */
  toLoan: Float64Array;
  /** Cumulative cash put into investments from the household budget (refunds excluded). */
  toInvest: Float64Array;
  /** First month after which the balance is zero (0 = no loan; null = not by the horizon). */
  payoffMonth: number | null;
};

const EPS = 1e-7;

/** Level payment for a fixed-rate amortizing loan. */
export function fixedMonthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  if (principal <= 0 || termMonths <= 0) return 0;
  const r = annualRate / 12;
  if (r <= 0) return principal / termMonths;
  const factor = Math.pow(1 + r, termMonths);
  return (principal * r * factor) / (factor - 1);
}

/** FV of end-of-month contributions, monthly compounding (ordinary annuity). */
export function futureValueOfAnnuity(payment: number, numMonths: number, annualReturn: number): number {
  if (numMonths <= 0 || payment <= 0) return 0;
  const i = Math.pow(1 + annualReturn, 1 / 12) - 1;
  if (Math.abs(i) < 1e-12) return payment * numMonths;
  return (payment * (Math.pow(1 + i, numMonths) - 1)) / i;
}

/** Map calendar month/year to 1-based loan month from first payment month/year. */
export function calendarToLoanPaymentMonth(lumpYear: number, lumpMonth: number, startYear: number, startMonth: number): number {
  return (lumpYear - startYear) * 12 + (lumpMonth - startMonth) + 1;
}

/** Calendar year and month (1–12) of loan month m. */
export function loanMonthToCalendar(m: number, startYear: number, startMonth: number): { year: number; month: number } {
  const idx = startMonth - 1 + (m - 1);
  return { year: startYear + Math.floor(idx / 12), month: (((idx % 12) + 12) % 12) + 1 };
}

/** Monthly rate equivalent to a compound annual return. */
export function monthlyReturn(annual: number): number {
  return Math.pow(1 + Math.max(-0.99, annual), 1 / 12) - 1;
}

/** Tax saved by deducting `interest` on top of `other` itemized deductions. */
export function deductionValue(interest: number, other: number, standard: number, rate: number): number {
  return rate * (Math.max(standard, other + interest) - Math.max(standard, other));
}

/**
 * Run one strategy. `returns` overrides the monthly investment return per month
 * (index m − 1), for the Monte Carlo; otherwise the expected return is used every month.
 */
export function simulatePath(plan: MortgagePlan, strategy: Strategy, returns?: Float64Array): PathSeries {
  const H = Math.max(1, Math.round(plan.horizonMonths));
  const P = Math.max(0, plan.principal);
  const n = Math.max(1, Math.round(plan.termMonths));
  const r = Math.max(0, plan.annualRate) / 12;
  const M = fixedMonthlyPayment(P, plan.annualRate, n);
  const E = Math.max(0, plan.extraMonthly);
  const iConst = monthlyReturn(plan.investReturn);
  const tau = plan.taxFreeAccount ? 0 : Math.min(1, Math.max(0, plan.investTaxRate));
  const divM = plan.taxFreeAccount ? 0 : Math.max(0, plan.dividendYield) / 12;
  const lumpsByMonth = new Map<number, { toLoan: number; toInvest: number }>();
  for (const l of plan.lumps) {
    const mo = Math.round(l.month);
    if (mo < 1 || mo > H || !(l.amount > 0)) continue;
    const slot = lumpsByMonth.get(mo) ?? { toLoan: 0, toInvest: 0 };
    if (strategy.lumpToLoan(l)) slot.toLoan += l.amount;
    else slot.toInvest += l.amount;
    lumpsByMonth.set(mo, slot);
  }

  const s: PathSeries = {
    balance: new Float64Array(H + 1),
    invested: new Float64Array(H + 1),
    basis: new Float64Array(H + 1),
    investedNet: new Float64Array(H + 1),
    netWorth: new Float64Array(H + 1),
    interest: new Float64Array(H + 1),
    deduction: new Float64Array(H + 1),
    dividendTax: new Float64Array(H + 1),
    toLoan: new Float64Array(H + 1),
    toInvest: new Float64Array(H + 1),
    payoffMonth: P <= EPS ? 0 : null,
  };
  let bal = P;
  let inv = 0;
  let basis = 0;
  let cumInterest = 0;
  let cumDeduction = 0;
  let cumDivTax = 0;
  let cumToLoan = 0;
  let cumToInvest = 0;
  let yearInterest = 0;
  s.balance[0] = bal;
  s.netWorth[0] = -bal;

  for (let m = 1; m <= H; m++) {
    // 1. Lump sum at the start of the month.
    const lump = lumpsByMonth.get(m);
    let deposit = 0;
    if (lump) {
      const pay = Math.min(lump.toLoan, bal);
      bal -= pay;
      cumToLoan += pay;
      deposit += lump.toLoan - pay + lump.toInvest;
    }
    inv += deposit;
    basis += deposit;
    cumToInvest += deposit;

    // 2. Investment return; dividends taxed as paid.
    const i = returns ? returns[m - 1]! : iConst;
    const div = inv * divM;
    const divTax = tau * div;
    inv = inv * (1 + i) - divTax;
    basis += div - divTax;
    cumDivTax += divTax;

    // 3. Interest and the scheduled payment. The deductible share is set by the debt cap.
    // The household's monthly outlay is M + E in every path, before and after payoff.
    const budget = M + E;
    let paidToLoan = 0;
    if (bal > EPS) {
      const interest = bal * r;
      const deductibleShare = plan.debtCap > 0 ? Math.min(1, plan.debtCap / bal) : 0;
      cumInterest += interest;
      yearInterest += interest * deductibleShare;
      const scheduled = Math.min(M, bal + interest);
      bal = bal + interest - scheduled;
      paidToLoan += scheduled;
      // 4. The extra, if this strategy sends it to the loan.
      if (strategy.extraToLoan) {
        const x = Math.min(E, bal);
        bal -= x;
        paidToLoan += x;
      }
      if (bal < EPS) bal = 0;
    }
    cumToLoan += paidToLoan;
    const spare = budget - paidToLoan;
    inv += spare;
    basis += spare;
    cumToInvest += spare;
    if (s.payoffMonth === null && bal <= EPS) s.payoffMonth = m;

    // 5. Settle the year's deduction in December and at the horizon.
    const cal = loanMonthToCalendar(m, plan.startYear, plan.startMonth);
    if (cal.month === 12 || m === H) {
      if (plan.deductInterest && yearInterest > 0) {
        const standard = plan.standardDeduction * Math.pow(1 + plan.inflation, cal.year - plan.startYear);
        const other = cal.year >= 2030 ? plan.otherItemizedFrom2030 : plan.otherItemized;
        const saved = deductionValue(yearInterest, other, standard, plan.marginalRate);
        inv += saved;
        basis += saved;
        cumDeduction += saved;
      }
      yearInterest = 0;
    }

    const net = plan.sellAtHorizon ? inv - tau * Math.max(0, inv - basis) : inv;
    s.balance[m] = bal;
    s.invested[m] = inv;
    s.basis[m] = basis;
    s.investedNet[m] = net;
    s.netWorth[m] = net - bal;
    s.interest[m] = cumInterest;
    s.deduction[m] = cumDeduction;
    s.dividendTax[m] = cumDivTax;
    s.toLoan[m] = cumToLoan;
    s.toInvest[m] = cumToInvest;
  }
  return s;
}

export type Comparison = {
  monthlyPayment: number;
  horizonMonths: number;
  invest: PathSeries;
  prepay: PathSeries;
  /** invest − prepay net worth at the horizon (positive: investing wins). */
  advantage: number;
  /** Investment return at which both paths tie at the horizon (null: no tie in −5%…25%). */
  breakEvenReturn: number | null;
  /** The four ways to route the extra and the lumps, net worth at the horizon. */
  matrix: { investAll: number; prepayExtraOnly: number; prepayLumpsOnly: number; prepayAll: number };
  /**
   * What sending each source of cash to the loan costs at the horizon versus investing it
   * (positive: investing it would have left you richer), each measured on its own from the
   * invest-everything path.
   */
  opportunityCost: { key: string; label: string; cost: number }[];
  /** Advantage at the horizon across investment returns. */
  sensitivity: { rate: number; advantage: number }[];
};

export function horizonNetWorth(plan: MortgagePlan, strategy: Strategy): number {
  const s = simulatePath(plan, strategy);
  return s.netWorth[s.netWorth.length - 1]!;
}

/** Return at which investing and prepaying tie at the horizon, by bisection. */
export function breakEvenReturn(plan: MortgagePlan, lo = -0.05, hi = 0.25): number | null {
  const gap = (rate: number) => {
    const p = { ...plan, investReturn: rate };
    return horizonNetWorth(p, INVEST_ALL) - horizonNetWorth(p, PREPAY_ALL);
  };
  let gLo = gap(lo);
  const gHi = gap(hi);
  if (Math.abs(gLo) < 1e-6) return lo;
  if (gLo * gHi > 0) return null;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    const g = gap(mid);
    if (Math.abs(g) < 1e-6 || hi - lo < 1e-7) return mid;
    if (g * gLo > 0) {
      lo = mid;
      gLo = g;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

export function comparePrepayVsInvest(plan: MortgagePlan, lumpLabels: Record<string, string> = {}): Comparison {
  const invest = simulatePath(plan, INVEST_ALL);
  const prepay = simulatePath(plan, PREPAY_ALL);
  const H = invest.netWorth.length - 1;
  const at = (s: PathSeries) => s.netWorth[H]!;
  const investAll = at(invest);
  const matrix = {
    investAll,
    prepayExtraOnly: horizonNetWorth(plan, PREPAY_EXTRA_ONLY),
    prepayLumpsOnly: horizonNetWorth(plan, PREPAY_LUMPS_ONLY),
    prepayAll: at(prepay),
  };

  const opportunityCost: Comparison["opportunityCost"] = [];
  if (plan.extraMonthly > 0) {
    opportunityCost.push({ key: "extra", label: "Extra each month", cost: investAll - horizonNetWorth(plan, { extraToLoan: true, lumpToLoan: () => false }) });
  }
  const ids = [...new Set(plan.lumps.filter((l) => l.amount > 0 && l.month >= 1 && l.month <= H).map((l) => l.id))];
  for (const id of ids) {
    opportunityCost.push({ key: id, label: lumpLabels[id] ?? "Lump sum", cost: investAll - horizonNetWorth(plan, { extraToLoan: false, lumpToLoan: (l) => l.id === id }) });
  }

  const sensitivity: Comparison["sensitivity"] = [];
  for (let k = 0; k <= 24; k++) {
    const rate = k * 0.005;
    const p = { ...plan, investReturn: rate };
    sensitivity.push({ rate, advantage: horizonNetWorth(p, INVEST_ALL) - horizonNetWorth(p, PREPAY_ALL) });
  }

  return {
    monthlyPayment: fixedMonthlyPayment(plan.principal, plan.annualRate, Math.round(plan.termMonths)),
    horizonMonths: H,
    invest,
    prepay,
    advantage: at(invest) - at(prepay),
    breakEvenReturn: breakEvenReturn(plan),
    matrix,
    opportunityCost,
    sensitivity,
  };
}

/** Small seeded PRNG (mulberry32) so the Monte Carlo is stable between renders. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type MonteCarlo = {
  paths: number;
  /** Share of paths where investing ends ahead at the horizon. */
  chanceInvestWins: number;
  /** Advantage (invest − prepay) percentiles at each year-end and at the horizon. */
  bands: { month: number; p10: number; p25: number; p50: number; p75: number; p90: number }[];
};

/**
 * Random market paths: monthly log-returns ~ N(ln(1+r)/12, σ²/12), so the median path
 * compounds at the expected return r. Both strategies see the same path each run.
 */
export function monteCarlo(plan: MortgagePlan, volatility: number, paths = 400, seed = 7): MonteCarlo {
  const H = Math.max(1, Math.round(plan.horizonMonths));
  const mu = Math.log(1 + Math.max(-0.99, plan.investReturn)) / 12;
  const sd = Math.max(0, volatility) / Math.sqrt(12);
  const rand = rng(seed);
  const checkpoints: number[] = [];
  for (let m = 12; m < H; m += 12) checkpoints.push(m);
  checkpoints.push(H);
  const samples = checkpoints.map(() => new Float64Array(paths));
  const returns = new Float64Array(H);
  let wins = 0;
  for (let p = 0; p < paths; p++) {
    for (let m = 0; m < H; m += 2) {
      // Box–Muller: two normals per draw.
      const u = Math.max(rand(), 1e-12);
      const v = rand();
      const rad = Math.sqrt(-2 * Math.log(u));
      returns[m] = Math.exp(mu + sd * rad * Math.cos(2 * Math.PI * v)) - 1;
      if (m + 1 < H) returns[m + 1] = Math.exp(mu + sd * rad * Math.sin(2 * Math.PI * v)) - 1;
    }
    const a = simulatePath(plan, INVEST_ALL, returns);
    const b = simulatePath(plan, PREPAY_ALL, returns);
    checkpoints.forEach((m, k) => {
      samples[k]![p] = a.netWorth[m]! - b.netWorth[m]!;
    });
    if (a.netWorth[H]! > b.netWorth[H]!) wins++;
  }
  const pct = (sorted: Float64Array, q: number) => {
    const idx = (sorted.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  };
  return {
    paths,
    chanceInvestWins: wins / paths,
    bands: checkpoints.map((month, k) => {
      const s = samples[k]!.sort();
      return { month, p10: pct(s, 0.1), p25: pct(s, 0.25), p50: pct(s, 0.5), p75: pct(s, 0.75), p90: pct(s, 0.9) };
    }),
  };
}
