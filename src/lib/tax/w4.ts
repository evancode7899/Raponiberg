import type { PayFrequency } from "./facts/payroll.ts";
import type { PersonReport, TaxReport } from "./buildTaxReport.ts";
import { EMPTY_W4, type W4OnFile } from "./profile.ts";

/**
 * Taxes › W-4: the W-4 and CT-W4 each person should have on file so the joint return
 * comes out at $0 owed and $0 refunded in April. It starts from what payroll actually
 * withholds per regular paycheck under the W-4 now on file (the latest stub, which is
 * the employer's own Pub 15-T arithmetic) and moves only the form's linear levers, so it
 * needs no withholding tables:
 *
 * - more withholding: Step 4(c) (per pay period, dollar for dollar) / CT-W4 line 2;
 * - less: first take back any 4(c) / line 2 already on file, then Step 3 (annual credits:
 *   payroll subtracts Step 3 ÷ pay periods per year from each paycheck) / CT-W4 line 3.
 *
 * Paychecks after the latest stub on file (the data edge) are taken to withhold what that
 * stub's regular paycheck did. Which of them are already paid is the person's own say (the
 * latest stub they've received, which can be well past the edge), else every pay date
 * through today: the new W-4 reaches only the ones after it.
 *
 * Filing status, Step 2 and Steps 4(a)/(b) stay as they are: changing them moves the
 * base withholding in ways only the tables can say. The gap is shared in proportion to
 * the pay each person has left (more) or the withholding they have left to give back
 * (less), no paycheck going below zero withheld or past its take-home pay.
 */

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = { WEEKLY: 52, BIWEEKLY: 26, SEMIMONTHLY: 24, MONTHLY: 12 };

export type W4Report = Pick<TaxReport, "today" | "people" | "inputs"> & {
  scenarios: { mfj: { federal: TaxReport["scenarios"]["mfj"]["federal"]; ct: TaxReport["scenarios"]["mfj"]["ct"] } };
};

/** One person's current regular paycheck and the pay dates a W-4 change can still reach. */
export type W4Paychecks = {
  personId: string;
  name: string;
  employer: string;
  frequency: PayFrequency;
  periodsPerYear: number;
  latestStub: string;
  /** The last pay date already paid: the one entered (the latest stub received), else the last through today. */
  paidThrough: string;
  /** Whether `paidThrough` was entered rather than taken from today. */
  paidThroughEntered: boolean;
  /** Pay dates after the latest stub on file, through `paidThrough`: forecast at the current W-4. */
  sinceStub: string[];
  /** Pay dates after `paidThrough` a new W-4 is too late for (the employer's lead time). */
  tooSoon: string[];
  /** Pay dates the new W-4 reaches. */
  reached: string[];
  gross: number;
  /** Take-home pay per regular paycheck: the most extra withholding can take. */
  takeHome: number;
  federalPerCheck: number;
  ctPerCheck: number;
};

/** One authority's balance at filing, from the tax down to what the W-4 change moves. */
export type W4Balance = {
  tax: number;
  /** Withheld on the pay stubs on file. */
  withheldStubs: number;
  /** Regular paychecks paid since the latest stub (forecast, current W-4). */
  withheldSinceStub: number;
  /** Paychecks before the change takes effect, then the ones it reaches, both at the current W-4. */
  withheldTooSoon: number;
  withheldReached: number;
  /** Bonuses still to come (flat supplemental rate: a W-4 doesn't move it). */
  withheldBonus: number;
  /** Withholding outside the stubs' paychecks (a W-2 form, an earlier employer's projection). */
  withheldOther: number;
  estimates: number;
  /** Payments and credits besides withholding and estimates (additional Medicare withheld, excess Social Security, refundable child credit). */
  otherCredits: number;
  /** Positive: owe; negative: refund. */
  balanceNow: number;
  /** Extra withholding the new W-4s add over the paychecks they reach (negative: less). */
  change: number;
  balanceAfter: number;
};

export type W4PersonPlan = W4Paychecks & {
  onFile: W4OnFile;
  /** False: the W-4 on file wasn't entered, so it's assumed from the stub's filing status. */
  onFileEntered: boolean;
  recommended: W4OnFile;
  /** Per reached paycheck: positive withholds more. */
  federalChange: number;
  ctChange: number;
};

export type W4Plan = {
  /** Each person with a current employer (none: nothing a W-4 can reach). */
  people: W4PersonPlan[];
  /** Paychecks the new W-4s reach, across everyone. */
  reachedPaychecks: number;
  federal: W4Balance;
  ct: W4Balance;
  /** Owed that no paycheck can take (too few left, or take-home too small): pay it as an estimate. */
  unreachable: { federal: number; ct: number };
};

type Share = { key: string; n: number; weight: number; cap: number };

/**
 * Splits `amount` (cents, ≥ 0) into per-paycheck amounts, in proportion to `weight`, none
 * over its `cap` per paycheck: a capped share's excess goes to the others. Cents are kept
 * exact, so the paychecks' total is within a few cents of `amount`.
 */
export function allocatePerCheck(amount: number, shares: Share[]): Map<string, number> {
  const out = new Map<string, number>();
  let left = amount;
  let open = shares.filter((s) => s.n > 0 && s.cap > 0);
  for (const s of shares) out.set(s.key, 0);
  while (left > 0 && open.length) {
    const weight = open.reduce((t, s) => t + s.weight, 0);
    const proposal = open.map((s) => ({ s, per: (left * (weight > 0 ? s.weight / weight : 1 / open.length)) / s.n }));
    const over = proposal.filter((p) => p.per >= p.s.cap);
    if (!over.length) {
      for (const p of proposal) out.set(p.s.key, Math.round(p.per));
      break;
    }
    for (const p of over) {
      out.set(p.s.key, p.s.cap);
      left -= p.s.cap * p.s.n;
    }
    open = open.filter((s) => !over.some((p) => p.s === s));
  }
  return out;
}

const filingFromStub = (status: string | null): W4OnFile["filingStatus"] => {
  const s = (status ?? "").toUpperCase();
  if (s.includes("HEAD")) return "HOH";
  if (s.includes("JOINT") || s === "M" || s.startsWith("MARRIED")) return s.includes("SEPARATE") ? "SINGLE" : "MFJ";
  return s ? "SINGLE" : "MFJ";
};

/**
 * The paychecks a W-4 change can still reach, per person with a current employer.
 * `paidThrough`: per person, the date of the latest stub they've received (on file or not);
 * a date before the latest stub on file counts from that stub.
 */
export function w4Paychecks(r: Pick<W4Report, "today" | "people">, tooSoonCount: number, paidThrough: Record<string, string | undefined> = {}): W4Paychecks[] {
  const out: W4Paychecks[] = [];
  for (const p of r.people) {
    const pay = p.payroll.find((x) => x.active);
    const reg = pay?.regularPaycheck;
    if (!pay || !reg) continue;
    const entered = paidThrough[p.id] || null;
    const cut = entered && entered > pay.latestPayDate ? entered : entered ? pay.latestPayDate : r.today;
    const paid = pay.remainingPayDates.filter((d) => d <= cut);
    const future = pay.remainingPayDates.filter((d) => d > cut);
    const takeHome =
      reg.gross -
      reg.retirementPretax -
      reg.retirementRoth -
      reg.hsa -
      reg.section125 -
      reg.dependentCareFsa -
      reg.federalWithheld -
      reg.ssWithheld -
      reg.medicareWithheld -
      reg.stateWithheld -
      reg.otherStateWithheld -
      reg.statePayroll;
    out.push({
      personId: p.id,
      name: p.name,
      employer: pay.employer,
      frequency: pay.frequency,
      periodsPerYear: PERIODS_PER_YEAR[pay.frequency],
      latestStub: pay.latestPayDate,
      paidThrough: entered ? cut : (paid.at(-1) ?? pay.latestPayDate),
      paidThroughEntered: !!entered,
      sinceStub: paid,
      tooSoon: future.slice(0, tooSoonCount),
      reached: future.slice(tooSoonCount),
      gross: reg.gross,
      takeHome: Math.max(0, takeHome),
      federalPerCheck: reg.federalWithheld,
      ctPerCheck: reg.stateWithheld,
    });
  }
  return out;
}

function balance(
  people: PersonReport[],
  checks: W4Paychecks[],
  pick: (a: { federalWithheld: number; stateWithheld: number }) => number,
  perCheck: (c: W4Paychecks) => number,
  ret: { totalTax: number; withholding: number; estimatedPayments: number; balanceDue: number },
): Omit<W4Balance, "change" | "balanceAfter"> {
  let stubs = 0;
  let projected = 0;
  for (const p of people) {
    for (const x of p.payroll) {
      stubs += pick(x.ytd);
      projected += pick(x.projected);
    }
  }
  const sum = (f: (c: W4Paychecks) => number) => checks.reduce((t, c) => t + f(c), 0);
  const sinceStub = sum((c) => perCheck(c) * c.sinceStub.length);
  const tooSoon = sum((c) => perCheck(c) * c.tooSoon.length);
  const reached = sum((c) => perCheck(c) * c.reached.length);
  // What the projection adds beyond the stubs and the regular paychecks is the bonuses' flat-rate withholding.
  const bonus = projected - stubs - sinceStub - tooSoon - reached;
  const other = ret.withholding - projected;
  return {
    tax: ret.totalTax,
    withheldStubs: stubs,
    withheldSinceStub: sinceStub,
    withheldTooSoon: tooSoon,
    withheldReached: reached,
    withheldBonus: bonus,
    withheldOther: other,
    estimates: ret.estimatedPayments,
    otherCredits: ret.totalTax - ret.balanceDue - ret.withholding - ret.estimatedPayments,
    balanceNow: ret.balanceDue,
  };
}

/**
 * The W-4s that bring the joint return to $0 at filing. `tooSoonCount`: upcoming
 * paychecks a new W-4 won't reach in time (payroll usually needs a cycle). `paidThrough`:
 * per person, the latest stub received (see w4Paychecks).
 */
export function planW4(r: W4Report, opts: { tooSoonCount?: number; paidThrough?: Record<string, string | undefined> } = {}): W4Plan {
  const checks = w4Paychecks(r, opts.tooSoonCount ?? 0, opts.paidThrough);
  const fed = balance(r.people, checks, (a) => a.federalWithheld, (c) => c.federalPerCheck, r.scenarios.mfj.federal);
  const ct = balance(r.people, checks, (a) => a.stateWithheld, (c) => c.ctPerCheck, r.scenarios.mfj.ct);

  // Owed: shared by the pay left (gross × paychecks), each capped at take-home pay; the
  // federal share is placed first and the state's fits in what take-home is left.
  // Refunded: shared by the withholding left to give back, none below zero.
  const fedChange = changes(fed.balanceNow, checks, (c) => c.federalPerCheck, (c) => c.takeHome);
  const ctChange = changes(ct.balanceNow, checks, (c) => c.ctPerCheck, (c) => c.takeHome - Math.max(0, fedChange.get(c.personId) ?? 0));

  const people: W4PersonPlan[] = checks.map((c) => {
    const person = r.people.find((p) => p.id === c.personId)!;
    const entered = r.inputs.people[c.personId]?.w4 ?? null;
    const status = person.payroll.find((x) => x.active)?.federalFilingStatus ?? null;
    const onFile: W4OnFile = entered ?? { ...EMPTY_W4, ct: { ...EMPTY_W4.ct }, filingStatus: filingFromStub(status) };
    const df = fedChange.get(c.personId) ?? 0;
    const dc = ctChange.get(c.personId) ?? 0;
    const rec: W4OnFile = { ...onFile, ct: { ...onFile.ct } };
    let federalChange = df;
    if (df > 0) rec.extraPerPaycheck = onFile.extraPerPaycheck + df;
    else if (df < 0) {
      const fromExtra = Math.min(onFile.extraPerPaycheck, -df);
      rec.extraPerPaycheck = onFile.extraPerPaycheck - fromExtra;
      // Step 3 is annual and in whole dollars: payroll takes Step 3 ÷ pay periods from each paycheck.
      const credits = Math.round(((-df - fromExtra) * c.periodsPerYear) / 100) * 100;
      rec.credits = onFile.credits + credits;
      federalChange = -(fromExtra + Math.round(credits / c.periodsPerYear));
    }
    if (dc > 0) {
      const fromReduced = Math.min(onFile.ct.reduced, dc);
      rec.ct.reduced = onFile.ct.reduced - fromReduced;
      rec.ct.additional = onFile.ct.additional + dc - fromReduced;
    } else if (dc < 0) {
      const fromAdditional = Math.min(onFile.ct.additional, -dc);
      rec.ct.additional = onFile.ct.additional - fromAdditional;
      rec.ct.reduced = onFile.ct.reduced + (-dc - fromAdditional);
    }
    return { ...c, onFile, onFileEntered: entered != null, recommended: rec, federalChange, ctChange: dc };
  });

  const after = (b: typeof fed, per: (p: W4PersonPlan) => number): W4Balance => {
    const change = people.reduce((t, p) => t + per(p) * p.reached.length, 0);
    return { ...b, change, balanceAfter: b.balanceNow - change };
  };
  const federal = after(fed, (p) => p.federalChange);
  const ctOut = after(ct, (p) => p.ctChange);
  // A balance left owed beyond a cent per paycheck of rounding is one no paycheck could take.
  const reachedPaychecks = people.reduce((t, p) => t + p.reached.length, 0);
  const left = (b: W4Balance) => (b.balanceAfter > reachedPaychecks ? b.balanceAfter : 0);
  return { people, reachedPaychecks, federal, ct: ctOut, unreachable: { federal: left(federal), ct: left(ctOut) } };
}

function changes(gap: number, checks: W4Paychecks[], perCheck: (c: W4Paychecks) => number, room: (c: W4Paychecks) => number): Map<string, number> {
  if (gap > 0) {
    return allocatePerCheck(
      gap,
      checks.map((c) => ({ key: c.personId, n: c.reached.length, weight: c.gross * c.reached.length, cap: Math.max(0, room(c)) })),
    );
  }
  if (gap < 0) {
    const cut = allocatePerCheck(
      -gap,
      checks.map((c) => ({ key: c.personId, n: c.reached.length, weight: perCheck(c) * c.reached.length, cap: perCheck(c) })),
    );
    return new Map([...cut].map(([k, v]) => [k, -v]));
  }
  return new Map();
}
