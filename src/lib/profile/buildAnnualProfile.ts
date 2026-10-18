import { blockersFor, netWorthAtBlockers } from "../book/blockers.ts";
import { investmentIncomeByAccount } from "../book/investments.ts";
import { addDays, daysBetween } from "../dates/isoDate.ts";
import type { Book, BookStub } from "../book/load.ts";
import { personPayYear, type PersonPayYear } from "../book/pay.ts";
import { refs, type BlockerRef } from "../book/reports/blockerRef.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import { rentPayments } from "../book/rent.ts";
import { taxRows } from "../book/taxPayments.ts";
import { CATEGORIES } from "../classifier/taxonomy.ts";
import type { Quality } from "../ledger/timeline.ts";
import { usd0 } from "../formatMoney.ts";
import { amountsFromLines, projectPayroll, type PayFrequency } from "../tax/facts/payroll.ts";
import { TAX_YEARS } from "../tax/params.ts";
import type { Dependent as TaxDependent } from "../tax/profile.ts";
import type { BonusYear, DeferralParts, LivingTrail, OutlookSeeds, PaycheckSeed, PayTrail, PersonSeed } from "./basePay.ts";
import {
  bucketForGroup,
  cashWaterfall,
  expenseFingerprint,
  netWorthBridge,
  summarizeBuckets,
  ZERO_BUCKETS,
  type BucketTotals,
  type Bridge,
  type CashWaterfall,
  type NetWorthSummary,
} from "./annualMath.ts";
import { BUCKETS, type FinancialProfileSettings, type NetWorthBucket } from "./settings.ts";

/**
 * The household's financial profile, one column per calendar year, entirely from the
 * Book: pay from proven pay stubs, cash from the ledger rows, year-end net worth from the
 * statements, and the bridge between them. Each year has four sections — pay, cash,
 * year-end net worth, change in net worth — and a section that depends on anything
 * missing or failing is withheld (null) with the findings that block it. Nothing is
 * typed in by hand: the owner only tags one-off expenses (Annual report › One-off
 * expenses) and sets FIRE assumptions.
 */

export type PersonYear = {
  personId: string;
  name: string;
  age: number | null;
  salary: number;
  bonus: number;
  reimbursements: number;
  withholding: number;
  /** Benefit premiums, FSAs and after-tax deductions. */
  otherDeductions: number;
  /** Employee 401(k)/HSA deferrals inside gross pay (savings). */
  deferrals: number;
  /** Employer 401(k) and HSA money. */
  employer: number;
  net: number;
  employers: string[];
  lastPayDate: string | null;
  hasPay: boolean;
  /** Why this year's pay is partial (taken from year-to-date totals only), if it is. */
  partial: string[];
};

export type CategoryCents = { category: string; cents: number };

export type OneOffRow = {
  fingerprint: string;
  date: string;
  payee: string;
  account: string;
  category: string;
  cents: number;
  /** Counted as non-recurring: tagged by hand, or its category is. */
  tagged: boolean;
  viaCategory: boolean;
  label: string;
};

export type YearCash = {
  waterfall: CashWaterfall;
  otherIncomeDetail: { interest: number; dividends: number; other: number };
  reimbursements: number;
  spending: CategoryCents[];
  /** The "other" income by category (income rows that aren't pay, interest or reimbursements). */
  otherIncomeByCategory: CategoryCents[];
  /** Tax-authority rows (taxes paid and refunds, not income or living) by the category and lane they're filed under. */
  taxRowsByCategory: { income: CategoryCents[]; spending: CategoryCents[] };
  /** How the year's living cost adds up (the forecast's LAST_YEAR / THIS_YEAR seeds' proof). */
  livingTrail: LivingTrail;
};

export type YearNetWorth = NetWorthSummary & {
  quality: Quality;
  /** Matched transfers that had left one account but not reached the other at year end. */
  inTransit: number;
  /** The same, by the side of the liquid / illiquid split they were going to. */
  inTransitSplit: { liquid: number; illiquid: number };
};

export type YearProfile = {
  year: number;
  label: string;
  isCurrent: boolean;
  /** Last day the year's cash figures run through. */
  asOf: string;
  /** Last day the year-end net worth is as of. */
  netWorthAsOf: string;
  /** Each section's blockers; a section with blockers is null. */
  blockers: { pay: BlockerRef[]; cash: BlockerRef[]; netWorth: BlockerRef[]; change: BlockerRef[] };
  people: PersonYear[] | null;
  cash: YearCash | null;
  netWorth: YearNetWorth | null;
  change: { cents: number; pct: number | null } | null;
  bridge: Bridge | null;
  oneOffCandidates: OneOffRow[];
};

export type { OutlookSeeds };

export type AnnualProfileReport = {
  today: string;
  currentYear: number;
  persons: { id: string; name: string }[];
  years: YearProfile[];
  /**
   * The year in progress from Jan 1 to the forecast's starting point (its cash figures stop
   * earlier when the cash flow isn't proven that far: `asOf` says). Null when the forecast
   * starts on last Dec 31 or there are no seeds.
   */
  ytd: YearProfile | null;
  /** Null when the base year (or this year's pay, which seeds the projection) isn't proven. */
  seeds: OutlookSeeds | null;
  seedBlockers: BlockerRef[];
  expenseCategories: string[];
  settings: FinancialProfileSettings;
};

/** Income and spending rows booked in a window (buildAnnualProfile cashRows). */
type CashRows = {
  interest: number;
  other: number;
  reimbursements: number;
  nonRecurring: number;
  taxSpending: number;
  spending: Map<string, number>;
  candidates: OneOffRow[];
  otherByCategory: Map<string, number>;
  taxByCategory: { income: Map<string, number>; spending: Map<string, number> };
};

const NOT_OTHER_INCOME = new Set(["Paycheck", "P2P & reimbursements", "Interest"]);
const unique = (bs: BlockerRef[]) => [...new Map(bs.map((b) => [b.id, b])).values()];
const minIso = (a: string, b: string) => (a < b ? a : b);
const byCents = (m: Map<string, number>): CategoryCents[] =>
  [...m].map(([category, cents]) => ({ category, cents })).filter((c) => c.cents !== 0).sort((a, b) => b.cents - a.cents);

/** A matched transfer that had left one account but not reached the other at the end of a day. */
export type InTransitTransfer = {
  matchId: string;
  /** The legs booked by then (their sum, negated, is what's in flight). */
  left: { accountId: string; date: string; amountCents: number }[];
  /** The first leg still to come, and the bucket of its account (where the money counts). */
  lands: { accountId: string; date: string };
  bucket: NetWorthBucket;
  cents: number;
};

/** Matched transfers in flight at the end of `end`, each counted in the bucket of the account it hadn't reached. */
export function transfersInTransit(book: Book, end: string): InTransitTransfer[] {
  const groupOf = new Map(book.ledger.accounts.map((a) => [a.id, a.group]));
  const out: InTransitTransfer[] = [];
  for (const m of book.matches) {
    const done = m.legs.filter((l) => l.date <= end);
    const pending = m.legs.filter((l) => l.date > end);
    if (!done.length || !pending.length) continue;
    out.push({
      matchId: m.id,
      left: done.map(({ accountId, date, amountCents }) => ({ accountId, date, amountCents })),
      lands: { accountId: pending[0]!.accountId, date: pending[0]!.date },
      bucket: bucketForGroup(groupOf.get(pending[0]!.accountId) ?? "Other"),
      cents: -done.reduce((s, l) => s + l.amountCents, 0),
    });
  }
  return out;
}

/** `dependents` (from the tax profile) only feed the outlook's tax on base pay. */
export function buildAnnualProfile(book: Book, settings: FinancialProfileSettings, dependents: TaxDependent[] = []): AnnualProfileReport {
  const today = book.today;
  const currentYear = Number(today.slice(0, 4));
  const persons = book.persons;
  const nw = buildNetWorth(book, { granularity: "year" });
  const firstYear = Math.min(book.ledger.firstDay ? Number(book.ledger.firstDay.slice(0, 4)) : currentYear, currentYear);
  const years: number[] = [];
  for (let y = firstYear; y <= currentYear; y++) years.push(y);
  const nonRecurringCats = new Set(settings.nonRecurringCategories);
  const accountName = new Map(book.accounts.map((a) => [a.id, a.name]));
  // Rent is a big charge every month, never a one-off: left out of the candidates (as on Cash flow).
  const rentIds = new Set(rentPayments(book.rows, [], book.household.merchantRules).map((p) => p.rowId));

  // Matched transfers in flight at a date count in the bucket of the account they hadn't reached.
  const inTransitAt = (end: string) => {
    const signed: BucketTotals = { ...ZERO_BUCKETS };
    for (const t of transfersInTransit(book, end)) signed[t.bucket] += t.cents;
    return signed;
  };

  // Income and spending rows booked in [from, to], tax payments excluded. Rows count in
  // the year the ledger books them, so the bridge to net worth has no slippage.
  const cashRows = (from: string, to: string, taxIds: Set<string>) => {
    let interest = 0;
    let other = 0;
    let reimbursements = 0;
    let nonRecurring = 0;
    // Tax payments filed as spending: taxes, not living (Cash flow counts them as spending).
    let taxSpending = 0;
    const spending = new Map<string, number>();
    const candidates: OneOffRow[] = [];
    // The same, by category (the proof of each line).
    const otherByCategory = new Map<string, number>();
    const taxByCategory = { income: new Map<string, number>(), spending: new Map<string, number>() };
    const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    for (const r of book.rows) {
      if (r.bookedOn < from || r.bookedOn > to) continue;
      if (taxIds.has(r.id)) {
        if (r.lane === "EXPENSE") {
          taxSpending -= r.amountCents;
          bump(taxByCategory.spending, r.category, -r.amountCents);
        } else if (r.lane === "INCOME") bump(taxByCategory.income, r.category, r.amountCents);
        continue;
      }
      if (r.lane === "INCOME") {
        if (r.category === "P2P & reimbursements") reimbursements += r.amountCents;
        else if (r.category === "Interest") interest += r.amountCents;
        else if (!NOT_OTHER_INCOME.has(r.category)) {
          other += r.amountCents;
          bump(otherByCategory, r.category, r.amountCents);
        }
        continue;
      }
      if (r.lane !== "EXPENSE") continue;
      const fp = expenseFingerprint({ accountId: r.accountId, date: r.date, amountCents: r.amountCents, payee: r.payee });
      const viaCategory = nonRecurringCats.has(r.category);
      const tagged = viaCategory || fp in settings.oneOffs;
      if (tagged) nonRecurring -= r.amountCents;
      else spending.set(r.category, (spending.get(r.category) ?? 0) - r.amountCents);
      if (tagged || (-r.amountCents >= 150_000 && !rentIds.has(r.id))) {
        candidates.push({ fingerprint: fp, date: r.date, payee: r.payee, account: accountName.get(r.accountId) ?? "", category: r.category, cents: -r.amountCents, tagged, viaCategory, label: settings.oneOffs[fp] ?? "" });
      }
    }
    candidates.sort((a, b) => Number(b.tagged) - Number(a.tagged) || b.cents - a.cents);
    return { interest, other, reimbursements, nonRecurring, taxSpending, spending, candidates, otherByCategory, taxByCategory };
  };

  /** A living-cost figure's parts, as the forecast's proof lists them. */
  const livingTrail = (from: string, to: string, rows: CashRows, payReimbursements: number): LivingTrail => {
    const tagged = rows.candidates.filter((c) => c.tagged);
    const byCategory = new Map<string, { cents: number; rows: number }>();
    for (const c of tagged.filter((x) => x.viaCategory)) {
      const cur = byCategory.get(c.category) ?? { cents: 0, rows: 0 };
      byCategory.set(c.category, { cents: cur.cents + c.cents, rows: cur.rows + 1 });
    }
    const spending = [...rows.spending.values()].reduce((s, v) => s + v, 0);
    return {
      from,
      to,
      spending,
      taxPayments: rows.taxSpending,
      oneOffs: tagged
        .filter((c) => !c.viaCategory)
        .map(({ date, payee, account, category, cents, label }) => ({ date, payee, account, category, cents, label }))
        .sort((a, b) => a.date.localeCompare(b.date) || b.cents - a.cents),
      oneOffCategories: [...byCategory].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.cents - a.cents),
      reimbursements: rows.reimbursements,
      payReimbursements,
      windowCents: spending - rows.reimbursements - payReimbursements,
    };
  };

  const pays = new Map<string, PersonPayYear>();
  const out: YearProfile[] = [];
  // One calendar year's profile, its cash figures through `cashEnd` (`record`: keep its pay for the seeds).
  const yearProfile = (year: number, cashEnd: string, prev: YearProfile | undefined, record = true): YearProfile => {
    const isCurrent = year === currentYear;
    const start = `${year}-01-01`;

    // ------------------------------------------------------------ pay
    const payBlockers: BlockerRef[] = [];
    const people: PersonYear[] = persons.map((p) => {
      const pay = personPayYear(book, p.id, year, cashEnd);
      if (record) pays.set(`${p.id}|${year}`, pay);
      payBlockers.push(...refs(pay.blockers));
      const t = pay.totals;
      const birth = settings.birthYears[p.id];
      return {
        personId: p.id,
        name: p.name,
        age: birth ? year - birth : null,
        salary: t.salary,
        bonus: t.bonus,
        reimbursements: t.reimbursements,
        withholding: t.withholding,
        otherDeductions: t.benefits + t.afterTax,
        deferrals: t.deferrals,
        employer: t.employerRetirement + t.employerHsa,
        net: t.net,
        employers: pay.employers.map((e) => e.employer),
        lastPayDate: pay.through,
        hasPay: pay.employers.length > 0,
        partial: pay.partial.map((i) => i.title),
      };
    });

    // ------------------------------------------------------------ cash
    const cashBlockers = unique([
      ...payBlockers,
      ...refs(blockersFor(book, { affects: "CASH_FLOW", from: start, to: cashEnd })),
      // Brokerage dividends count as income: they need the year's tax figures.
      ...refs(blockersFor(book, { affects: "TAX", from: start, to: cashEnd })).filter((b) => b.id.startsWith("tax.brokerage-coverage")),
    ]);
    const taxes = taxRows(book, start, cashEnd);
    const rows = cashRows(start, cashEnd, new Set(taxes.map((r) => r.id)));
    const { interest, other, nonRecurring, spending, candidates, reimbursements: rowReimbursements } = rows;
    let reimbursements = rowReimbursements;
    let taxesPaid = 0;
    let refunds = 0;
    for (const r of taxes) {
      if (r.amountCents < 0) taxesPaid -= r.amountCents;
      else refunds += r.amountCents;
    }
    let dividends = 0;
    for (const v of investmentIncomeByAccount(book, year, cashEnd).values()) if (v.kind === "TAXABLE") dividends += v.cents;
    const sumPeople = (f: (p: PersonYear) => number) => people.reduce((s, p) => s + f(p), 0);
    // Expense reimbursements arrive by Zelle/Venmo or inside a paycheck; both offset spending.
    reimbursements += sumPeople((p) => p.reimbursements);
    const living = [...spending.values()].reduce((s, v) => s + v, 0) - reimbursements;
    const waterfall = cashWaterfall({
      salary: sumPeople((p) => p.salary),
      bonus: sumPeople((p) => p.bonus),
      otherIncome: interest + other + dividends,
      withholding: sumPeople((p) => p.withholding),
      additionalTaxes: taxesPaid,
      refunds,
      otherDeductions: sumPeople((p) => p.otherDeductions),
      employer: sumPeople((p) => p.employer),
      living,
      nonRecurring,
    });

    // ------------------------------------------------------------ net worth
    const period = nw.periods.find((p) => p.start === start);
    const nwAsOf = period?.end ?? minIso(book.horizon.netWorth, `${year}-12-31`);
    const nwBlockers = period ? refs(netWorthAtBlockers(book, nwAsOf)) : [{ id: "networth.none", status: "MISSING" as const, title: `No statements cover ${year}`, fix: "Add statements for the year." }];
    const changeBlockers = period ? period.blockers : nwBlockers;
    let netWorth: YearNetWorth | null = null;
    if (period && nwBlockers.length === 0) {
      const signed: BucketTotals = { ...ZERO_BUCKETS };
      for (const g of period.byGroup) signed[bucketForGroup(g.group)] += g.closingCents;
      const transit = inTransitAt(nwAsOf);
      for (const b of BUCKETS) signed[b.id] += transit[b.id];
      const allTransit = Object.values(transit).reduce((s, v) => s + v, 0);
      const liquidTransit = BUCKETS.filter((b) => b.liquid).reduce((s, b) => s + transit[b.id], 0);
      netWorth = { ...summarizeBuckets(signed), quality: period.household.quality, inTransit: allTransit, inTransitSplit: { liquid: liquidTransit, illiquid: allTransit - liquidTransit } };
    }
    const change =
      netWorth && prev?.netWorth && changeBlockers.length === 0
        ? { cents: netWorth.netWorth - prev.netWorth.netWorth, pct: prev.netWorth.netWorth > 0 ? (netWorth.netWorth - prev.netWorth.netWorth) / prev.netWorth.netWorth : null }
        : null;
    const cash: YearCash | null =
      cashBlockers.length === 0
        ? {
            waterfall,
            otherIncomeDetail: { interest, dividends, other },
            reimbursements,
            spending: byCents(spending),
            otherIncomeByCategory: byCents(rows.otherByCategory),
            taxRowsByCategory: { income: byCents(rows.taxByCategory.income), spending: byCents(rows.taxByCategory.spending) },
            livingTrail: livingTrail(start, cashEnd, rows, sumPeople((p) => p.reimbursements)),
          }
        : null;
    const h = period?.household;
    const bridge =
      cash && change && h && prev?.netWorth
        ? netWorthBridge({
            cashSaved: waterfall.saved,
            dividendsCounted: dividends,
            ledger: {
              income: h.incomeCents,
              spending: h.spendingCents,
              retirementEmployee: h.retirementEmployeeCents,
              retirementEmployer: h.retirementEmployerCents,
              external: h.externalCents,
              newlyTracked: h.newlyTrackedCents,
              growthNetOfFees: h.growthNetOfFeesCents,
              transferResidual: h.transferResidualCents,
              unexplained: h.unexplainedCents,
            },
            inTransitAssetChange: netWorth!.inTransit - prev.netWorth.inTransit,
          })
        : null;

    return {
      year,
      label: isCurrent ? `${year} YTD` : String(year),
      isCurrent,
      asOf: cashEnd,
      netWorthAsOf: nwAsOf,
      blockers: { pay: unique(payBlockers), cash: cashBlockers, netWorth: nwBlockers, change: changeBlockers },
      people: payBlockers.length === 0 ? people : null,
      cash,
      netWorth,
      change,
      bridge,
      oneOffCandidates: candidates.slice(0, 40),
    };
  };
  for (const year of years) out.push(yearProfile(year, year === currentYear ? minIso(book.horizon.cashFlow, `${year}-12-31`) : `${year}-12-31`, out.at(-1)));

  // ------------------------------------------------------------ outlook seeds
  const base = [...out].reverse().find((y) => !y.isCurrent);
  const seedBlockers = unique([
    ...(base ? [...base.blockers.pay, ...base.blockers.cash, ...base.blockers.netWorth] : [{ id: "profile.no-base-year", status: "MISSING" as const, title: "No complete year on file yet", fix: "Add a full year of statements." }]),
    // This year's pay sets the base salary.
    ...refs(persons.flatMap((p) => pays.get(`${p.id}|${currentYear}`)?.blockers ?? [])),
  ]);
  const seeds =
    seedBlockers.length === 0 && base ? outlookSeeds({ book, out, base, currentYear, settings, pays, cashRows, livingTrail, nwReturn: nw.returns.portfolio?.annualized ?? null, dependents }) : null;

  // The year in progress cut where the forecast starts, so actual to date + the forecast's rest of the year = the whole year.
  let ytd: YearProfile | null = null;
  const cur = out.at(-1);
  if (seeds && cur?.isCurrent && seeds.start.year === currentYear) {
    const end = minIso(book.horizon.cashFlow, seeds.start.asOf);
    ytd = end === cur.asOf ? cur : yearProfile(currentYear, end, out.at(-2), false);
  }

  return {
    today,
    currentYear,
    persons: persons.map((p) => ({ id: p.id, name: p.name })),
    years: out,
    ytd,
    seeds,
    seedBlockers,
    expenseCategories: CATEGORIES.filter((c) => c.kind === "EXPENSE" && c.group !== "Money movement").map((c) => c.name),
    settings,
  };
}

const PER_YEAR: Record<PayFrequency, number> = { WEEKLY: 52, BIWEEKLY: 26, SEMIMONTHLY: 24, MONTHLY: 12 };

function paycheckSeed(stub: BookStub): PaycheckSeed {
  const a = amountsFromLines(stub.lines, "current");
  return {
    payDate: stub.payDate,
    regular: a.regular,
    section125: a.section125 + a.dependentCareFsa,
    hsa: a.hsa,
    afterTax: stub.lines.filter((l) => l.kind === "AFTER_TAX").reduce((s, l) => s + (l.current ?? 0), 0),
    employer: a.employerRetirement + a.employerHsa,
  };
}

/**
 * What the outlook starts from: the latest proven net worth, each person's base pay
 * (their regular paycheck, latest and typical), their bonus history, and three takes on
 * living cost. Nothing here is a bonus forecast — that's an assumption on the page.
 */
function outlookSeeds(x: {
  book: Book;
  out: YearProfile[];
  base: YearProfile;
  currentYear: number;
  settings: FinancialProfileSettings;
  pays: Map<string, PersonPayYear>;
  cashRows: (from: string, to: string, taxIds: Set<string>) => CashRows;
  livingTrail: (from: string, to: string, rows: CashRows, payReimbursements: number) => LivingTrail;
  nwReturn: number | null;
  dependents: TaxDependent[];
}): OutlookSeeds {
  const { book, out, base, currentYear, settings } = x;
  const taxYear = Math.max(...Object.keys(TAX_YEARS).map(Number).filter((y) => y <= currentYear), Math.min(...Object.keys(TAX_YEARS).map(Number)));
  const fp = TAX_YEARS[taxYear]!.federal;
  const cur = out.find((y) => y.isCurrent);

  // ------------------------------------------------------------ starting point
  // The latest proven net worth: this year's statements if they pass, else last Dec 31.
  const start: OutlookSeeds["start"] = cur?.netWorth
    ? {
        asOf: cur.netWorthAsOf,
        year: Number(cur.netWorthAsOf.slice(0, 4)),
        month: Number(cur.netWorthAsOf.slice(5, 7)),
        liquid: cur.netWorth.liquid,
        illiquid: cur.netWorth.illiquid,
        note: `Latest proven net worth (statements through ${cur.netWorthAsOf})`,
        inTransit: cur.netWorth.inTransitSplit,
      }
    : {
        asOf: `${base.year}-12-31`,
        year: base.year,
        month: 12,
        liquid: base.netWorth!.liquid,
        illiquid: base.netWorth!.illiquid,
        note: `Net worth on Dec 31, ${base.year} (this year's statements aren't proven yet)`,
        inTransit: base.netWorth!.inTransitSplit,
      };

  // ------------------------------------------------------------ base pay, per person
  const people: PersonSeed[] = book.persons.map((p) => {
    // Every stub to date (pay runs past the statements' data edge); the proven cut if a recent stub has problems.
    const all = personPayYear(book, p.id, currentYear);
    const thisYear = all.blockers.length === 0 ? all : x.pays.get(`${p.id}|${currentYear}`);
    const lastYear = personPayYear(book, p.id, base.year);
    const payYear = thisYear?.employers.length ? thisYear : lastYear.employers.length ? lastYear : null;
    const history: BonusYear[] = [];
    for (const y of out) {
      const q = !y.isCurrent ? y.people?.find((v) => v.personId === p.id) : undefined;
      if (q?.hasPay) history.push({ year: y.year, salary: q.salary, bonus: q.bonus, pct: q.salary > 0 ? q.bonus / q.salary : null, partial: false });
    }
    const seed: PersonSeed = {
      personId: p.id,
      name: p.name,
      employer: null,
      perYear: 0,
      frequency: null,
      latest: null,
      typical: null,
      deferrals: { LATEST: { k401Pretax: 0, k401Roth: 0, hsa: 0 }, TYPICAL: { k401Pretax: 0, k401Roth: 0, hsa: 0 } },
      bonusHistory: history,
      bonusMonth: null,
      bonusesSinceStart: [],
      note: "No pay stubs on file",
    };
    if (!payYear) return seed;
    const active = payYear.employers.reduce((a, b) => (b.lastPayDate > a.lastPayDate ? b : a));
    const others = payYear.employers.filter((e) => e !== active);
    const stubByDate = new Map(active.stubs.map((s) => [s.payDate, s] as const));
    let frequency: PayFrequency = "SEMIMONTHLY";
    const parts = (a: { retirementPretax: number; retirementRoth: number; hsa: number }): DeferralParts => ({ k401Pretax: a.retirementPretax, k401Roth: a.retirementRoth, hsa: a.hsa });
    const trailDeferrals = {} as PayTrail["deferrals"];
    let proj: ReturnType<typeof projectPayroll> | null = null;
    for (const basis of ["LATEST", "TYPICAL"] as const) {
      proj = projectPayroll(active.stubs, fp, { basis });
      // Only the year in progress continues to Dec 31; a finished year is already whole.
      const continues = payYear.year === currentYear;
      const a = continues ? proj.projected : proj.ytd;
      seed.deferrals[basis] = {
        k401Pretax: a.retirementPretax + others.reduce((s, e) => s + e.ytd.retirementPretax, 0),
        k401Roth: a.retirementRoth + others.reduce((s, e) => s + e.ytd.retirementRoth, 0),
        hsa: a.hsa + others.reduce((s, e) => s + e.ytd.hsa, 0),
      };
      trailDeferrals[basis] = {
        ytd: parts(proj.ytd),
        throughStub: proj.latestPayDate,
        perCheck: continues && proj.regularPaycheck ? parts(proj.regularPaycheck) : { k401Pretax: 0, k401Roth: 0, hsa: 0 },
        checks: continues ? proj.remainingPayDates.length : 0,
        projected: parts(a),
        others: others.map((e) => ({ employer: e.employer, employerKey: e.employerKey, through: e.lastPayDate, d: parts(e.ytd) })),
      };
      frequency = proj.frequency;
      const pick = basis === "LATEST" ? proj.latestRegular : proj.typicalRegular;
      const stub = pick && stubByDate.get(pick.payDate);
      if (stub) seed[basis === "LATEST" ? "latest" : "typical"] = paycheckSeed(stub);
    }
    const freqStub = stubByDate.get(proj!.latestRegular?.payDate ?? "") ?? active.stubs.at(-1)!;
    seed.trail = {
      employer: active.employer,
      employerKey: active.employerKey,
      payYear: payYear.year,
      recent: (proj!.recentRegulars ?? []).map((r) => ({ payDate: r.payDate, regular: r.amounts.regular, gross: r.amounts.gross })),
      frequencyFrom: { payDate: freqStub.payDate, periodStart: freqStub.periodStart, periodEnd: freqStub.periodEnd },
      deferrals: trailDeferrals,
    };
    seed.employer = active.employer;
    seed.frequency = frequency;
    seed.perYear = PER_YEAR[frequency];
    seed.note =
      payYear.year === currentYear
        ? `${active.employer}: ${active.stubCount} ${currentYear} stubs through ${active.lastPayDate}`
        : `No ${currentYear} stubs; using ${payYear.year} (${active.employer}, through ${active.lastPayDate})`;
    // The year in progress: bonus paid so far, against the base salary run rate.
    const runRate = ((seed.typical ?? seed.latest)?.regular ?? 0) * seed.perYear;
    if (thisYear?.employers.length) {
      history.push({ year: currentYear, salary: thisYear.totals.salary, bonus: thisYear.totals.bonus, pct: runRate > 0 ? thisYear.totals.bonus / runRate : null, partial: true });
    }
    // The month bonuses come: the most recent year's largest bonus check.
    for (const y of [currentYear, base.year, base.year - 1]) {
      const big = personPayYear(book, p.id, y)
        .employers.flatMap((e) => e.stubs)
        .map((s) => ({ s, bonus: amountsFromLines(s.lines, "current").bonus }))
        .filter((v) => v.bonus > 0)
        .sort((a, b) => b.bonus - a.bonus)[0];
      if (big) {
        seed.bonusMonth = Number(big.s.payDate.slice(5, 7));
        break;
      }
    }
    seed.bonusesSinceStart = all.employers
      .flatMap((e) => e.stubs)
      .filter((s) => s.payDate > start.asOf)
      .map((s) => ({ payDate: s.payDate, gross: amountsFromLines(s.lines, "current").bonus }))
      .filter((b) => b.gross > 0);
    return seed;
  });

  // ------------------------------------------------------------ living cost
  const living: OutlookSeeds["living"] = {
    LAST_YEAR: { cents: base.cash!.waterfall.living, label: `${base.year} actual`, detail: `Living expenses in ${base.year}, excluding tagged one-offs`, trail: base.cash!.livingTrail },
  };
  if (cur?.cash) {
    const days = daysBetween(`${currentYear}-01-01`, cur.asOf) + 1;
    if (days >= 60) {
      living.THIS_YEAR = {
        cents: Math.round((cur.cash.waterfall.living * 365) / days),
        label: `${currentYear} so far, annualized`,
        detail: `${usd0(cur.cash.waterfall.living)} from Jan 1 to ${cur.asOf} (${days} days) × 365, excluding tagged one-offs`,
        trail: { ...cur.cash.livingTrail, days },
      };
    }
    // The twelve months ending at the cash data edge.
    const to = cur.asOf;
    const from = addDays(`${Number(to.slice(0, 4)) - 1}${to.slice(4) === "-02-29" ? "-02-28" : to.slice(4)}`, 1);
    if (blockersFor(book, { affects: "CASH_FLOW", from, to }).length === 0) {
      const rows = x.cashRows(from, to, new Set(taxRows(book, from, to).map((r) => r.id)));
      // Reimbursements paid inside a paycheck offset spending, as in each year's figures.
      const inPay = book.stubs.filter((s) => s.personId && s.payDate >= from && s.payDate <= to).reduce((t, s) => t + amountsFromLines(s.lines, "current").nonTaxable, 0);
      const cents = [...rows.spending.values()].reduce((t, v) => t + v, 0) - rows.reimbursements - inPay;
      living.TRAILING_12 = { cents, label: "Last 12 months", detail: `Living expenses ${from} to ${to}, excluding tagged one-offs`, trail: x.livingTrail(from, to, rows, inPay) };
    }
  }

  const firstBirth = book.persons.map((p) => settings.birthYears[p.id]).find((b) => b != null) ?? null;
  return {
    start,
    baseYear: base.year,
    currentYear,
    people,
    living,
    realizedReturn: x.nwReturn,
    taxYear,
    tax: { year: taxYear, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
    dependents: x.dependents.map((d) => ({ name: d.name, age: Math.max(0, taxYear - d.birthYear) })),
    birthYear: firstBirth,
  };
}
