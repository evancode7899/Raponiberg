import { projectPayroll, w2FromAmounts, type PaycheckBasis, type PayrollAmounts } from "../../tax/facts/payroll.ts";
import { taxYearParams, type FilingStatus } from "../../tax/params.ts";
import { yearInputs } from "../../tax/profile.ts";
import { buildTaxReport } from "../../tax/buildTaxReport.ts";
import { EMPTY_PERSON, type HsaCoverage, type RetirementSettings } from "../../taxAccounts/settings.ts";
import { taxYearThrough } from "../blockers.ts";
import type { Book } from "../load.ts";
import { personPayYear } from "../pay.ts";
import { chetYear, excessDeferral, excessDeferralMessage, iraYear, k401Limit, taxableConversion, type ExcessDeferral } from "../taxAdvantaged.ts";
import type { CheckId } from "../types.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";
import type { TaxForecastLink } from "../../forecast/forecast.ts";

/**
 * Room left in each tax-advantaged account for a year, per person, from the Book. Pay
 * (401(k) deferrals, employer money, HSA payroll contributions) is the Taxes page's own
 * payroll — the same stubs, W-2s, as-of date and projection — and IRA contributions, Roth
 * conversions, CHET 529 contributions and any excess 401(k) deferral come from the same
 * shared module the Taxes page uses (book/taxAdvantaged.ts), so the two pages can't
 * disagree. IRA balances give the pro-rata rule. Limits come from tax/params.ts.
 */

/** Stub problems that make contribution totals unprovable (bank-side gaps don't). */
export const STUB_CHECKS: CheckId[] = ["paystub.arithmetic", "paystub.person", "pay.continuity", "pay.year-gap"];

export type Amount = { ytd: number; projected: number };

/** One employer's payroll for the year: what went to the 401(k) and HSA, and where each figure is read. */
export type EmployerPlan = {
  employer: string;
  active: boolean;
  /** 401(k) deferrals (pre-tax + Roth), employer 401(k) money, HSA from pay and the employer's HSA money. */
  employee: Amount;
  employer$: Amount;
  hsa: Amount;
  employerHsa: Amount;
  /** The stubs' employer key (null for a W-2 with no stubs) and the latest stub counted. */
  employerKey: string | null;
  through: string;
  /** A W-2 form on file replaced the stubs' year-to-date 401(k) deferrals. */
  w2: boolean;
  /** The projection to Dec 31: pay dates repeated after the latest stub, and the check repeated. */
  projection: { checks: number; basis: PaycheckBasis; perCheck: PayrollAmounts | null; fromForecast: boolean } | null;
};

export type PersonAccounts = {
  id: string;
  name: string;
  age: number | null;
  /** Latest pay stub the year-to-date figures run through. */
  through: string | null;
  blockers: BlockerRef[];
  /** Pay-side findings that don't change contribution totals (shown as notes). */
  notes: string[];
  remainingPaychecks: number;
  k401: {
    limit: number;
    catchUp: number;
    pretax: Amount;
    roth: Amount;
    total: Amount;
    /** Deferred above the limit across employers this year (must be returned by April 15). */
    excess: number;
    /** Whether the plan returned the excess, and the statements that show it. */
    excessDeferral: ExcessDeferral | null;
    room: number;
    perPaycheckToMax: number | null;
    employers: EmployerPlan[];
    /** Employer match captured: what the formula pays at projected deferrals, and the deferral that earns all of it. */
    match: { rate: number; upTo: number; fullMatchDeferral: number; shortfall: number } | null;
    rothCatchUpRequired: boolean;
  };
  hsa: { coverage: HsaCoverage; assumed: boolean; limit: number; employee: Amount; employer: Amount; outsidePayroll: number; total: Amount; room: number };
  ira: {
    limit: number;
    /** Per IRA, with the ledger rows that count (book/taxAdvantaged.ts iraYear). */
    contributions: { account: string; kind: string; cents: number; rowIds: string[] }[];
    total: number;
    room: number;
    /** Share of the limit that may go to a Roth IRA directly at the household's MAGI. */
    rothDirectShare: number;
    /** Share of a traditional contribution that's deductible. */
    deductibleShare: number;
    coveredByPlan: boolean;
  };
  backdoor: {
    conversions: number;
    basis: number;
    /** Pre-tax IRA money (traditional, rollover) at year end, or now for the current year. */
    pretaxIraCents: number;
    pretaxAccounts: { name: string; cents: number }[];
    /** Estimated taxable part of this year's conversions under the pro-rata rule. */
    taxableConversion: number;
  };
};

export type Step = {
  id: string;
  personId: string | null;
  title: string;
  /** Room left toward this step's yearly limit (cents). */
  roomCents: number;
  /** What a dollar here gets you. */
  benefit: string;
  /** A pre-tax step (employer match, HSA, 401(k)): filling it cuts this year's tax. */
  pretax: boolean;
  /** Rough tax saved this year if the room is filled (pre-tax steps only; null when no marginal rate is known). */
  taxSavedCents: number | null;
  done: boolean;
  /** Something to do first or to check (pro-rata, plan rules). */
  caution: string | null;
};

export type TaxAccountsReport = {
  year: number;
  today: string;
  isCurrentYear: boolean;
  filingStatus: FilingStatus;
  /** Household modified AGI used for Roth IRA eligibility, and where it came from. */
  magi: { cents: number; source: "TAX_REPORT" | "PAY_STUBS" };
  marginalRate: { rate: number | null; source: "SETTING" | "TAX_REPORT" | "PRIOR_YEAR" | "NONE" };
  people: PersonAccounts[];
  household: {
    hsaFamilyShared: { limit: number; total: number } | null;
    chet: { deductionLimit: number; contributed: number };
  };
  steps: Step[];
  /**
   * The open pre-tax steps together: their room, whether or not a marginal rate is known,
   * and the tax filling them would save (null when the rate isn't known).
   */
  pretax: { roomCents: number; taxSavedCents: number | null };
  warnings: string[];
  /** Settled items worth knowing (an excess deferral returned in time), word for word as the Taxes page says them. */
  notices: string[];
  paramsNotes: string[];
};

const ZERO: Amount = { ytd: 0, projected: 0 };
const add = (a: Amount, b: Amount): Amount => ({ ytd: a.ytd + b.ytd, projected: a.projected + b.projected });
const pos = (n: number) => Math.max(0, n);
const phaseShare = (magi: number, r: { start: number; end: number }) => (magi <= r.start ? 1 : magi >= r.end ? 0 : (r.end - magi) / (r.end - r.start));

export function buildTaxAccounts(book: Book, year: number, settings: RetirementSettings, forecast: TaxForecastLink | null = null): TaxAccountsReport {
  const params = taxYearParams(year);
  const fp = params.federal;
  const lim = fp.retirement;
  const today = book.today;
  const isCurrentYear = Number(today.slice(0, 4)) === year;
  const filingStatus: FilingStatus = book.persons.length > 1 ? "MFJ" : "SINGLE";
  const extrasFor = (id: string) => yearInputs(book.taxProfile, year).people[id]?.extras;
  const warnings: string[] = [];
  const notices: string[] = [];
  // Pay runs through the same date as on the Taxes page: the data edge for the year in progress.
  const through = taxYearThrough(book, year);

  // ------------------------------------------------------------ the tax report, when provable
  const tax = buildTaxReport(book, year, { forecast });
  const prior = tax.blocked && TAX_YEAR_EXISTS(year - 1) ? buildTaxReport(book, year - 1) : null;

  const people: PersonAccounts[] = book.persons.map((person) => {
    const inputs = settings.people[person.id] ?? EMPTY_PERSON;
    const birthYear = book.birthYears?.[person.id];
    const age = birthYear ? year - birthYear : null;
    const pay = personPayYear(book, person.id, year, through);
    const hard = pay.blockers.filter((b) => STUB_CHECKS.includes(b.check));
    const notes = pay.blockers.filter((b) => !STUB_CHECKS.includes(b.check)).map((b) => b.title);
    const taxPerson = tax.blocked ? null : (tax.people.find((p) => p.id === person.id) ?? null);

    // Each employer's pay, the active one (paying most recently) first: the Taxes page's
    // payroll when the year is provable (W-2 boxes for a finished year), else the stubs.
    type Emp = { employer: string; active: boolean; ytd: PayrollAmounts; projected: PayrollAmounts; deferred: Amount; pretax: Amount; remaining: string[]; last: string; key: string | null; w2: boolean; projection: EmployerPlan["projection"] };
    const keyOf = (employer: string) => book.stubs.find((s) => s.personId === person.id && s.payDate.startsWith(`${year}-`) && s.employer === employer)?.employerKey ?? null;
    const emps: Emp[] = taxPerson
      ? [...taxPerson.payroll]
          .sort((a, b) => Number(b.active) - Number(a.active) || b.latestPayDate.localeCompare(a.latestPayDate))
          .map((p) => ({
            employer: p.employer,
            active: p.active,
            ytd: p.ytd,
            projected: p.projected,
            deferred: { ytd: p.w2Ytd.box12.D + p.w2Ytd.box12.AA, projected: p.w2Projected.box12.D + p.w2Projected.box12.AA },
            pretax: { ytd: p.w2Ytd.box12.D, projected: p.w2Projected.box12.D },
            remaining: isCurrentYear ? p.remainingPayDates.filter((d) => d > today) : [],
            last: p.latestPayDate,
            key: keyOf(p.employer),
            w2: !!p.w2Doc,
            projection: p.active && !p.w2Doc ? { checks: p.remainingPayDates.length, basis: p.basis, perCheck: p.regularPaycheck, fromForecast: !!taxPerson.fromForecast } : null,
          }))
      : [...pay.employers]
          .sort((a, b) => b.lastPayDate.localeCompare(a.lastPayDate))
          .map((e, i) => {
            const proj = i === 0 && isCurrentYear ? projectPayroll(e.stubs, fp) : null;
            const p = proj?.projected ?? e.ytd;
            return {
              employer: e.employer,
              active: i === 0,
              ytd: e.ytd,
              projected: p,
              deferred: { ytd: e.ytd.retirementPretax + e.ytd.retirementRoth, projected: p.retirementPretax + p.retirementRoth },
              pretax: { ytd: e.ytd.retirementPretax, projected: p.retirementPretax },
              remaining: proj?.remainingPayDates.filter((d) => d > today) ?? [],
              last: e.lastPayDate,
              key: e.employerKey,
              w2: false,
              projection: proj ? { checks: proj.remainingPayDates.length, basis: proj.basis, perCheck: proj.regularPaycheck, fromForecast: false } : null,
            };
          });
    const active = emps[0];
    const remainingPaychecks = active?.remaining.length ?? 0;
    const empRows: EmployerPlan[] = emps.map((e) => ({
      employer: e.employer,
      active: e.active,
      employee: e.deferred,
      employer$: { ytd: e.ytd.employerRetirement, projected: e.projected.employerRetirement },
      hsa: { ytd: e.ytd.hsa, projected: e.projected.hsa },
      employerHsa: { ytd: e.ytd.employerHsa, projected: e.projected.employerHsa },
      employerKey: e.key,
      through: e.last,
      w2: e.w2,
      projection: e.projection,
    }));
    const total = emps.reduce((s, e) => add(s, e.deferred), ZERO);
    const pretax = emps.reduce((s, e) => add(s, e.pretax), ZERO);
    const roth: Amount = { ytd: total.ytd - pretax.ytd, projected: total.projected - pretax.projected };
    const { limit, catchUp } = k401Limit(fp, age);
    // The excess (and whether it was returned) is the Taxes page's, which counts it as income.
    const excessDeferred = taxPerson ? taxPerson.k401.excessDeferral : excessDeferral(book, person.id, year, pos(total.projected - limit));
    const excess = excessDeferred?.excess ?? 0;
    if (excessDeferred) {
      const m = excessDeferralMessage(person.name, year, limit, total.projected, excessDeferred);
      (m.ok ? notices : warnings).push(m.text);
    }
    const room = pos(limit - total.projected);

    // Prior-year FICA wages from this employer decide whether catch-ups must be Roth (2026+).
    let rothCatchUpRequired = false;
    if (catchUp && lim.rothCatchUpWageThreshold != null && active && TAX_YEAR_EXISTS(year - 1)) {
      const prev = personPayYear(book, person.id, year - 1).employers.find((e) => e.employer === active.employer);
      if (prev) rothCatchUpRequired = w2FromAmounts(prev.employer, prev.ytd, taxYearParams(year - 1).federal).box3SsWages > lim.rothCatchUpWageThreshold;
    }

    const activeRow = empRows[0];
    const gross = active ? active.projected.gross : 0;
    let match =
      inputs.matchRate != null && inputs.matchUpTo != null && activeRow
        ? { rate: inputs.matchRate, upTo: inputs.matchUpTo, fullMatchDeferral: Math.round(gross * inputs.matchUpTo), shortfall: pos(Math.round(gross * inputs.matchUpTo) - activeRow.employee.projected) }
        : null;
    // The typed match formula against what the stubs show the employer paid so far this year.
    // The stubs are what was paid: a formula they contradict isn't used for anything.
    if (match && active && activeRow && active.ytd.gross > 0) {
      const predicted = Math.round(match.rate * Math.min(activeRow.employee.ytd, active.ytd.gross * match.upTo));
      const paid = activeRow.employer$.ytd;
      if (Math.abs(predicted - paid) > Math.max(5_000, paid * 0.1)) {
        warnings.push(`${person.name}: the match typed on Inputs (${Math.round(match.rate * 100)}% up to ${Math.round(match.upTo * 1000) / 10}% of pay) comes to ${dollars(predicted)} so far in ${year}, but the pay stubs show ${dollars(paid)} of employer 401(k) money, so it isn't used. Check the formula against the plan (or the employer pays something besides the match).`);
        match = null;
      }
    }

    // ---------------------------------------------------------- HSA
    const hsaEmployee = empRows.reduce((s, e) => add(s, e.hsa), ZERO);
    const hsaEmployer = empRows.reduce((s, e) => add(s, e.employerHsa), ZERO);
    const outsidePayroll = extrasFor(person.id)?.hsaOutsidePayroll ?? 0;
    const assumed = inputs.hsaCoverage == null;
    const coverage: HsaCoverage = inputs.hsaCoverage ?? (hsaEmployee.ytd + hsaEmployer.ytd > 0 ? (book.taxProfile.dependents.length ? "FAMILY" : "SELF") : "NONE");
    const hsaLimit = coverage === "NONE" ? 0 : (coverage === "FAMILY" ? fp.limits.hsaFamily : fp.limits.hsaSelf) + (age != null && age >= 55 ? lim.hsaCatchUp55 : 0);
    const hsaTotal = add(add(hsaEmployee, hsaEmployer), { ytd: outsidePayroll, projected: outsidePayroll });

    // ---------------------------------------------------------- IRAs
    // The same ledger reading the Taxes page uses: money arriving from a bank or taxable
    // account is a contribution; traditional → Roth is a conversion; rollovers are neither.
    const ira = iraYear(book, person.id, year);
    warnings.push(...ira.mismatches);
    const contributions = ira.contributions.map(({ account, kind, cents, rowIds }) => ({ account, kind, cents, rowIds }));
    const conversions = ira.conversions;
    const iraTotal = contributions.reduce((s, c) => s + c.cents, 0);
    const iraLimit = fp.limits.ira + (age != null && age >= 50 ? lim.iraCatchUp : 0);
    const coveredByPlan = total.ytd + empRows.reduce((s, e) => s + e.employer$.ytd, 0) > 0;
    const basis = ira.traditionalContributions + (extrasFor(person.id)?.iraBasisCarryforward ?? 0);
    const pretaxAccounts = ira.pretaxAccounts;
    const pretaxIraCents = pretaxAccounts.reduce((s, x) => s + x.cents, 0);
    // What the Taxes page puts on the return (Form 8606, or the 1099-R for a finished year).
    const taxableConv = taxPerson?.retirement.source === "1099-R" ? taxPerson.retirement.taxable : taxableConversion(conversions, basis, pretaxIraCents);

    return {
      id: person.id,
      name: person.name,
      age,
      through: emps.map((e) => e.last).sort().at(-1) ?? null,
      blockers: refs(hard),
      notes,
      remainingPaychecks,
      k401: {
        limit,
        catchUp,
        pretax,
        roth,
        total,
        excess,
        excessDeferral: excessDeferred,
        room,
        perPaycheckToMax: remainingPaychecks ? Math.ceil(room / remainingPaychecks) : null,
        employers: empRows,
        match,
        rothCatchUpRequired,
      },
      hsa: { coverage, assumed, limit: hsaLimit, employee: hsaEmployee, employer: hsaEmployer, outsidePayroll, total: hsaTotal, room: pos(hsaLimit - hsaTotal.projected) },
      ira: { limit: iraLimit, contributions, total: iraTotal, room: pos(iraLimit - iraTotal), rothDirectShare: 1, deductibleShare: 1, coveredByPlan },
      backdoor: { conversions, basis, pretaxIraCents, pretaxAccounts, taxableConversion: taxableConv },
    };
  });

  // ------------------------------------------------------------ MAGI & marginal rate
  const magi = !tax.blocked
    ? { cents: tax.scenarios.mfj.federal.agi, source: "TAX_REPORT" as const }
    : {
        // Wages after pre-tax deductions; investment income isn't counted, so it errs low.
        cents: people.reduce((s, p) => {
          const pay = personPayYear(book, p.id, year, through);
          return s + pay.employers.reduce((t, e) => t + w2FromAmounts(e.employer, e.ytd, fp).box1Wages, 0);
        }, 0),
        source: "PAY_STUBS" as const,
      };
  const covered = people.map((p) => p.ira.coveredByPlan);
  for (const [i, p] of people.entries()) {
    p.ira.rothDirectShare = phaseShare(magi.cents, lim.rothIraPhaseout[filingStatus]);
    const spouseCovered = covered.some((c, j) => j !== i && c);
    p.ira.deductibleShare = p.ira.coveredByPlan
      ? phaseShare(magi.cents, lim.tradIraCoveredPhaseout[filingStatus])
      : spouseCovered && filingStatus === "MFJ"
        ? phaseShare(magi.cents, lim.tradIraSpouseCoveredPhaseout)
        : 1;
  }
  const marginalRate =
    settings.marginalRate != null
      ? { rate: settings.marginalRate, source: "SETTING" as const }
      : !tax.blocked
        ? { rate: tax.marginal.federal + tax.marginal.ct, source: "TAX_REPORT" as const }
        : prior && !prior.blocked
          ? { rate: prior.marginal.federal + prior.marginal.ct, source: "PRIOR_YEAR" as const }
          : { rate: null, source: "NONE" as const };

  // ------------------------------------------------------------ household
  const family = people.filter((p) => p.hsa.coverage === "FAMILY");
  const hsaFamilyShared = family.length > 1 ? { limit: fp.limits.hsaFamily, total: family.reduce((s, p) => s + p.hsa.total.projected, 0) } : null;
  if (hsaFamilyShared && hsaFamilyShared.total > hsaFamilyShared.limit) warnings.push(`Spouses with family HSA coverage share one ${dollars(hsaFamilyShared.limit)} limit; together you're on track for ${dollars(hsaFamilyShared.total)}.`);
  // CHET: the same figures the Taxes page subtracts on the Connecticut return.
  const chet = chetYear(book, year);
  warnings.push(...chet.mismatches);
  const household = {
    hsaFamilyShared,
    chet: { deductionLimit: params.ct.chetDeduction[filingStatus], contributed: chet.total },
  };

  const steps = orderSteps(buildSteps(people, household, marginalRate.rate), { marginalRate: marginalRate.rate });
  return {
    year,
    today,
    isCurrentYear,
    filingStatus,
    magi,
    marginalRate,
    people,
    household,
    steps,
    pretax: pretaxTotals(steps, marginalRate.rate),
    warnings,
    notices,
    paramsNotes: params.notes,
  };
}

const TAX_YEAR_EXISTS = (year: number) => {
  try {
    taxYearParams(year);
    return true;
  } catch {
    return false;
  }
};

const dollars = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

/** The open pre-tax steps' room, and the tax filling it saves when a marginal rate is known. */
export function pretaxTotals(steps: Step[], rate: number | null): TaxAccountsReport["pretax"] {
  const open = steps.filter((s) => s.pretax && !s.done);
  return { roomCents: open.reduce((t, s) => t + s.roomCents, 0), taxSavedCents: rate == null ? null : open.reduce((t, s) => t + (s.taxSavedCents ?? 0), 0) };
}

/** Every account with a yearly limit to fill, with the room left and why it's worth it. */
function buildSteps(people: PersonAccounts[], h: TaxAccountsReport["household"], rate: number | null): Step[] {
  const saved = (cents: number | null) => (rate == null || cents == null ? null : Math.round(cents * rate));
  const steps: Step[] = [];
  for (const p of people) {
    if (p.k401.match) {
      steps.push({
        id: `match-${p.id}`,
        personId: p.id,
        pretax: true,
        title: `${p.name}: defer enough to get the full employer match`,
        roomCents: p.k401.match.shortfall,
        benefit: `Free money: the employer adds ${Math.round(p.k401.match.rate * 100)}¢ per dollar up to ${Math.round(p.k401.match.upTo * 100)}% of pay.`,
        taxSavedCents: saved(p.k401.match.shortfall),
        done: p.k401.match.shortfall === 0,
        caution: null,
      });
    }
    if (p.hsa.coverage !== "NONE") {
      steps.push({
        id: `hsa-${p.id}`,
        personId: p.id,
        pretax: true,
        title: `${p.name}: fill the HSA`,
        roomCents: p.hsa.room,
        benefit: "Deductible going in, grows tax-free, tax-free out for medical costs. Through payroll it also skips Social Security and Medicare tax.",
        taxSavedCents: saved(p.hsa.room),
        done: p.hsa.room === 0,
        caution: p.hsa.assumed ? `Coverage assumed ${p.hsa.coverage.toLowerCase()} — confirm it on the Inputs.` : null,
      });
    }
    const backdoor = p.ira.rothDirectShare < 1;
    steps.push({
      id: `ira-${p.id}`,
      personId: p.id,
      pretax: false,
      title: backdoor ? `${p.name}: backdoor Roth IRA` : `${p.name}: Roth IRA`,
      roomCents: p.ira.room,
      benefit: backdoor
        ? "Income is over the direct Roth limit: contribute to a traditional IRA (non-deductible) and convert it to Roth. Grows and comes out tax-free."
        : "Grows and comes out tax-free in retirement; contributions can be withdrawn any time.",
      taxSavedCents: null,
      done: p.ira.room === 0,
      caution:
        backdoor && p.backdoor.pretaxIraCents > 0
          ? `${dollars(p.backdoor.pretaxIraCents)} of pre-tax IRA money would make most of a conversion taxable (pro-rata rule). Roll it into the 401(k) before December 31 first.`
          : null,
    });
    steps.push({
      id: `k401-${p.id}`,
      personId: p.id,
      pretax: true,
      title: `${p.name}: max the 401(k)`,
      roomCents: p.k401.room,
      benefit: `Pre-tax deferrals cut this year's tax at your top rate${p.remainingPaychecks ? `; ${dollars(p.k401.perPaycheckToMax ?? 0)} more per paycheck over ${p.remainingPaychecks} paychecks fills it` : ""}.`,
      taxSavedCents: saved(p.k401.room),
      done: p.k401.room === 0,
      caution: p.k401.rothCatchUpRequired ? "Catch-up contributions must go in as Roth (prior-year wages over the threshold)." : null,
    });
  }
  const chetRoom = pos(h.chet.deductionLimit - h.chet.contributed);
  steps.push({
    id: "chet",
    personId: null,
    pretax: false,
    title: "CHET 529 up to Connecticut's deduction",
    roomCents: chetRoom,
    benefit: "Deductible on the Connecticut return; grows tax-free for education.",
    taxSavedCents: null,
    done: chetRoom === 0,
    caution: null,
  });
  return steps;
}

/**
 * The order the next dollar should go in. The default is the common rule of thumb:
 * free match money first, then the HSA (triple tax-free), Roth/backdoor IRAs, the rest
 * of the 401(k), then the 529 deduction.
 */
export function orderSteps(steps: Step[], ctx: { marginalRate: number | null }): Step[] {
  const order = ["match", "hsa", "ira", "k401", "chet"];
  // Hook: `order` could adapt to the household's situation before sorting, e.g. using
  // ctx.marginalRate (federal + state on the next pre-tax dollar, or null when unknown).
  void ctx;
  const rank = (s: Step) => order.indexOf(s.id.split("-")[0]!);
  return [...steps].sort((a, b) => rank(a) - rank(b));
}
