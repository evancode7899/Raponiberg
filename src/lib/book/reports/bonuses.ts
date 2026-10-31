import type { AwardLetter, AwardsFile, ScheduledPayment } from "../../bonuses/awardStore.ts";
import { addDays, endOfMonth } from "../../dates/isoDate.ts";
import { employerKey } from "../../ingest/payroll/types.ts";
import { blockersFor, type BlockerQuery } from "../blockers.ts";
import { findingStart } from "../checks/collector.ts";
import type { Book, BookStub } from "../load.ts";
import { payBreakdown, personPayYear, stubGroups, UNKNOWN_PERSON } from "../pay.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";

/**
 * Bonuses: what each award letter promised (headline bonus, cash up front, deferred
 * tranches and their vest dates) checked against what the pay stubs show was paid.
 *
 * Every payment due in the same window from one employer is paid together (the up-front
 * cash plus whatever older tranches vest then), so windows are matched as a whole: the
 * bonus lines paid from a little before the window opens to a month after it closes
 * ("on or about") must add up to everything scheduled in it, to within a dollar per
 * scheduled payment (letters print whole dollars). A window that passed with nothing paid
 * is forfeited when the person's stubs moved to another employer before it opened;
 * otherwise it's missing from the stubs, or the stubs stop before it.
 */

export type WindowStatus = "PAID" | "PAID_DIFFERENT" | "UPCOMING" | "DUE" | "FORFEITED" | "NOT_ON_STUBS" | "NO_STUBS";

export type BonusPayment = {
  stubId: string;
  date: string;
  personId: string;
  personName: string;
  employer: string;
  employerKey: string;
  line: string;
  amountCents: number;
  document: string;
  /** The letter window it pays, or null when no letter explains it. */
  explains: { letterId: string; window: string } | null;
};

export type WindowPart = { awardYear: number; kind: ScheduledPayment["kind"]; amountCents: number };

export type VestWindow = {
  key: string;
  letterId: string;
  label: string;
  from: string;
  to: string;
  parts: WindowPart[];
  scheduledCents: number;
  paidCents: number;
  payments: BonusPayment[];
  status: WindowStatus;
  /** Why the status is what it is, in a sentence. */
  detail: string;
  /** The stubs this window is settled against, as a pay-findings query (windowPayQuery); null before it opens. Its proofs check the same. */
  payQuery: BlockerQuery | null;
  /** Pay findings over those stubs: what could hide one of its payments. */
  blockers: BlockerRef[];
};

export type Tranche = WindowPart & { window: string; label: string; from: string; to: string; status: WindowStatus; paidCents: number };

export type AwardRow = {
  letterId: string;
  employer: string;
  personId: string;
  personName: string;
  year: number;
  partial: boolean;
  /** As the letter prints them. */
  baseCents: number | null;
  /** Regular pay on the employer's stubs that year (year-to-date on the last stub). */
  stubBaseCents: number | null;
  totalBonusCents: number | null;
  totalCompCents: number | null;
  /**
   * What the page shows: the letter's base, else base pay on all the person's stubs that
   * year (a job change splits it across employers); the letter's total comp, else base +
   * headline bonus + one-offs.
   */
  /** From the stubs: that year's pay is read (`payQuery`), and its findings (`blockers`) withhold what's built on it. */
  base: { cents: number; from: "LETTER" | "STUBS"; parts: { employer: string; cents: number }[]; payQuery?: BlockerQuery; blockers?: BlockerRef[] } | null;
  totalComp: { cents: number; from: "LETTER" | "SUM" } | null;
  upfrontCents: number;
  deferredCents: number;
  /** Sign-on and make-whole payments: paid with the award but outside the headline bonus. */
  oneOffCents: number;
  /** Deferred into a deferred compensation plan: part of the headline bonus, paid under the plan, never on the stubs. */
  planDeferredCents: number;
  paidCents: number;
  forfeitedCents: number;
  /** Scheduled and not yet paid (upcoming, due now, or not found on the stubs). */
  outstandingCents: number;
  tranches: Tranche[];
};

export type Employment = { personId: string; personName: string; employer: string; employerKey: string; first: string; last: string; nextEmployer: string | null };

export type BonusYear = {
  year: number;
  personId: string;
  personName: string;
  employer: string;
  /** The stub employer keys behind the name (one per payroll code), for the figure's proof. */
  employerKeys: string[];
  cents: number;
  payments: number;
  /** The part a letter explains (paid as one of its scheduled payments). */
  explainedCents: number;
  /**
   * The last day the year's figures run through, when a gap in the stubs cuts it short (a
   * paycheck with no stub): everything before the gap is complete, so the year counts up to
   * the day before it rather than not at all. Null: the whole year, or to date.
   */
  through: string | null;
  /** The year's stubs from this employer, through `through` (else to date), as a pay-findings query (yearPayQuery). Its proofs check the same. */
  payQuery: BlockerQuery;
  /** Pay findings over them: a missing stub could hide a bonus paid that year. */
  blockers: BlockerRef[];
};

export type BonusesReport = {
  today: string;
  letters: {
    id: string;
    title: string;
    employer: string;
    terms: string | null;
    notes: string[];
    employment: Employment | null;
    /** Over the letter's vesting windows: what was due, what the stubs paid, and what leaving forfeited. */
    windowTotals: { scheduledCents: number; paidCents: number; forfeitedCents: number };
  }[];
  awards: AwardRow[];
  windows: VestWindow[];
  payments: BonusPayment[];
  byYear: BonusYear[];
  /** Over the full awards (partial ones show only some tranches). */
  totals: {
    headlineCents: number;
    upfrontCents: number;
    deferredCents: number;
    deferredPaidCents: number;
    forfeitedCents: number;
    outstandingCents: number;
    next: Tranche | null;
  };
  /** Employers whose bonuses were paid with no letter on file. */
  unlettered: UnletteredEmployer[];
  /** Employers the owner says pay bonuses with no letter: the stubs are the whole story. */
  stubOnly: (UnletteredEmployer & { note: string | null })[];
  /** Base and bonus by year, from the stubs, for each person paid by a stub-only employer. */
  payYears: PayYearRow[];
  /** Places a letter contradicts itself or the stubs: open bonus.letters findings (Statements → Issues lists them too). */
  warnings: BonusWarning[];
  /** Warnings the owner accepted as exceptions, at the gap they accepted. */
  reviewed: ReviewedWarning[];
  /** Accepted exceptions whose warning no longer arises (the gap changed or it's gone): Statements → Issues reviews them. */
  staleReviews: StaleReview[];
  blockers: BlockerRef[];
};

/** One person's calendar year of pay from the stubs: base (regular pay) and bonus, every employer that year. */
export type PayYearRow = {
  personId: string;
  personName: string;
  year: number;
  employers: string[];
  baseCents: number;
  bonusCents: number;
  /** Latest pay date on file that year. */
  last: string;
  /** The year in progress (figures so far). */
  inProgress: boolean;
};

export type UnletteredEmployer ={ employer: string; personName: string; cents: number; count: number };

/** A warning's id is stable across rebuilds (letter id, award year or vest window, check), so a review finds it again. */
export type BonusWarning = {
  id: string;
  text: string;
  /** What's off, in cents (signed). An exception covers only this gap: a new gap is a new finding. */
  gapCents: number;
  /** The days it's about: a vesting window, or the award's year. */
  from: string;
  to: string;
};
export type ReviewedWarning = BonusWarning & { note: string; reviewedAt: string };

/**
 * The bonus.letters finding a warning raises (checks/bonuses.ts): one id per warning and
 * gap, so an exception the owner accepted covers that gap only, as a review used to.
 */
/** The Book's award letters (Book.bonusAwards): none on a Book built without them; a damaged file throws its message. */
export function awardsOf(book: Book): AwardsFile {
  const a = book.bonusAwards;
  if (!a) return { version: 1, letters: [] };
  if ("error" in a) throw new Error(a.error);
  return a;
}

/** The Bonuses page's report, as GET /api/bonuses, its proofs and the proof sweep build it. */
// As of the proven-through date: a bonus paid after it shows once every statement reaches it.
export const bonusesOf = (book: Book): BonusesReport => buildBonuses(book, awardsOf(book), book.horizon.cashFlow);

export type StaleReview = { id: string; warning: string; note: string; reviewedAt: string };

export const bonusFindingId = (w: Pick<BonusWarning, "id" | "gapCents">) => `bonus.letters:${w.id}|${w.gapCents}`;

const cents = (dollars: number) => Math.round(dollars * 100);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1]!;

/** "Feb/Mar 2025", "Jul 2024", "Dec 2024/Jan 2025". */
export function windowLabel(from: string, to: string): string {
  if (from === to) return `${monthName(from)} ${from.slice(0, 4)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${monthName(from)}/${monthName(to)} ${from.slice(0, 4)}`;
  return `${monthName(from)} ${from.slice(0, 4)}/${monthName(to)} ${to.slice(0, 4)}`;
}

/** Days before a window opens and after it closes that a payment still counts as "on or about". */
const EARLY_DAYS = 14;
const LATE_DAYS = 31;

const sameEmployer = (stubKey: string, key: string) => stubKey === key || stubKey.startsWith(`${key} #`);

/**
 * `book.integrity` decides which warnings are open: the bonus.letters check raises one
 * finding per warning (built here, so the page and the check can't differ), and the
 * owner's exceptions cover them. While the checks run, nothing is accepted yet.
 */
export function buildBonuses(book: Book, file: AwardsFile, today: string): BonusesReport {
  const nameOf = (id: string) => book.persons.find((p) => p.id === id)?.name ?? "Unassigned";
  // `today` is the as-of date (the proven-through date): a bonus paid after it isn't counted yet.
  const payments: BonusPayment[] = book.stubs
    .filter((s: BookStub) => s.payDate <= today)
    .flatMap((s: BookStub) =>
      s.lines
        .filter((l) => l.kind === "BONUS" && (l.current ?? 0) !== 0)
        .map((l) => ({
          stubId: s.id,
          date: s.payDate,
          personId: s.personId ?? UNKNOWN_PERSON,
          personName: nameOf(s.personId ?? UNKNOWN_PERSON),
          employer: s.employer.replace(/ · payroll .*$/, ""),
          employerKey: s.employerKey,
          line: l.name,
          amountCents: l.current!,
          document: s.documentTitle,
          explains: null as BonusPayment["explains"],
        })),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.employer.localeCompare(b.employer));

  const warnings: BonusWarning[] = [];
  const windows: VestWindow[] = [];
  const awards: AwardRow[] = [];
  const letters: Omit<BonusesReport["letters"][number], "windowTotals">[] = [];
  const blockers = new Map<string, BlockerRef>();
  const groups = stubGroups(book);

  for (const letter of file.letters) {
    const key = employerKey(letter.employer);
    const stubs = book.stubs.filter((s) => sameEmployer(s.employerKey, key)).sort((a, b) => a.payDate.localeCompare(b.payDate));
    const employment = employmentOf(book, stubs, nameOf);
    letters.push({ id: letter.id, title: letter.title, employer: letter.employer, terms: letter.terms ?? null, notes: letter.notes ?? [], employment });
    const years = letter.awards.map((a) => a.year).sort((a, b) => a - b);
    const span = { from: `${years[0] ?? today.slice(0, 4)}-01-01`, to: `${years.at(-1) ?? today.slice(0, 4)}-12-31` };
    if (!employment) warnings.push({ id: `${letter.id}|no-stubs`, gapCents: 0, ...span, text: `No pay stubs from ${letter.employer} are on file, so nothing on the letter "${letter.title}" can be checked against what was paid.` });

    const letterWindows = windowsOf(letter);
    const keys = [...new Set(stubs.map((s) => s.employerKey))];
    for (const w of letterWindows) {
      settle(w, payments, key, employment, today);
      // A missing stub inside one of the letter's windows could hide that window's payment; a
      // gap anywhere else (a later paycheck, years on) has no bearing on it.
      w.payQuery = employment ? windowPayQuery(w, employment.personId, keys, today) : null;
      w.blockers = w.payQuery ? refs(blockersFor(book, w.payQuery)) : [];
      for (const b of w.blockers) blockers.set(b.id, b);
      windows.push(w);
    }

    for (const a of letter.awards) {
      const tranches: Tranche[] = a.payments.map((p) => {
        const w = letterWindows.find((x) => x.key === windowKey(letter.id, p))!;
        const amountCents = cents(p.amount);
        const share = w.scheduledCents ? Math.round((w.paidCents * amountCents) / w.scheduledCents) : 0;
        return { awardYear: a.year, kind: p.kind, amountCents, window: w.key, label: w.label, from: w.from, to: w.to, status: w.status, paidCents: share };
      });
      const sumKind = (k: ScheduledPayment["kind"]) => tranches.filter((t) => t.kind === k).reduce((s, t) => s + t.amountCents, 0);
      const personId = employment?.personId ?? UNKNOWN_PERSON;
      const lastStub = [...groups.entries()].filter(([k]) => {
        const [p, ek, y] = k.split("|");
        return p === personId && sameEmployer(ek!, key) && Number(y) === a.year;
      }).flatMap(([, g]) => g.slice(-1));
      const row: AwardRow = {
        letterId: letter.id,
        employer: letter.employer,
        personId,
        personName: employment?.personName ?? "Unassigned",
        year: a.year,
        partial: !!a.partial,
        baseCents: a.baseSalary != null ? cents(a.baseSalary) : null,
        stubBaseCents: lastStub.length ? lastStub.reduce((s, st) => s + payBreakdown(st.lines).salary, 0) : null,
        totalBonusCents: a.totalBonus != null ? cents(a.totalBonus) : null,
        totalCompCents: a.totalComp != null ? cents(a.totalComp) : null,
        base: null,
        totalComp: null,
        upfrontCents: sumKind("UPFRONT"),
        deferredCents: sumKind("DEFERRED"),
        oneOffCents: sumKind("SIGNING") + sumKind("MAKEWHOLE"),
        planDeferredCents: a.planDeferral != null ? cents(a.planDeferral) : 0,
        paidCents: tranches.reduce((s, t) => s + t.paidCents, 0),
        forfeitedCents: tranches.filter((t) => t.status === "FORFEITED").reduce((s, t) => s + t.amountCents, 0),
        outstandingCents: tranches.filter((t) => t.status === "UPCOMING" || t.status === "DUE" || t.status === "NOT_ON_STUBS" || t.status === "NO_STUBS").reduce((s, t) => s + t.amountCents, 0),
        tranches,
      };
      if (row.baseCents != null) row.base = { cents: row.baseCents, from: "LETTER", parts: [] };
      else if (personId !== UNKNOWN_PERSON) {
        const py = personPayYear(book, personId, a.year);
        const parts = py.employers.filter((e) => e.breakdown.salary > 0).map((e) => ({ employer: e.employer.replace(/ · payroll .*$/, ""), cents: e.breakdown.salary }));
        if (parts.length)
          row.base = { cents: py.totals.salary, from: "STUBS", parts, payQuery: { affects: "PAY", personId, from: `${a.year}-01-01`, to: `${a.year}-12-31` }, blockers: refs(py.blockers) };
        for (const b of refs(py.blockers)) blockers.set(b.id, b);
      }
      if (row.totalCompCents != null) row.totalComp = { cents: row.totalCompCents, from: "LETTER" };
      else if (row.base && row.totalBonusCents != null) row.totalComp = { cents: row.base.cents + row.totalBonusCents + row.oneOffCents, from: "SUM" };
      awards.push(row);
      warnings.push(...letterChecks(letter, row));
    }
  }

  for (const w of windows) {
    if (w.status === "PAID_DIFFERENT") {
      const text = `${w.label}: the letter schedules ${dollars(w.scheduledCents)} but the stubs show ${dollars(w.paidCents)} of bonus paid (${w.payments.map((p) => p.date).join(", ")}).`;
      warnings.push({ id: `${w.key}|paid`, gapCents: w.paidCents - w.scheduledCents, from: w.from, to: w.to, text });
    }
    if (w.status === "NOT_ON_STUBS") {
      const text = `${w.label}: ${dollars(w.scheduledCents)} was due from ${letters.find((l) => l.id === w.letterId)?.employer} and no bonus line on the stubs pays it.`;
      warnings.push({ id: `${w.key}|not-on-stubs`, gapCents: -w.scheduledCents, from: w.from, to: w.to, text });
    }
  }
  const review = applyExceptions(book, warnings);

  const byYearMap = new Map<string, BonusYear>();
  const yearPayments = new Map<string, BonusPayment[]>();
  const lettered = new Set(file.letters.map((l) => employerKey(l.employer)));
  for (const p of payments) {
    const year = Number(p.date.slice(0, 4));
    const k = `${year}|${p.personId}|${p.employer}`;
    const cur = byYearMap.get(k) ?? { year, personId: p.personId, personName: p.personName, employer: p.employer, employerKeys: [], cents: 0, payments: 0, explainedCents: 0, through: null, payQuery: { affects: "PAY", from: "", to: "" }, blockers: [] };
    if (!cur.employerKeys.includes(p.employerKey)) cur.employerKeys.push(p.employerKey);
    cur.cents += p.amountCents;
    cur.payments += 1;
    if (p.explains) cur.explainedCents += p.amountCents;
    byYearMap.set(k, cur);
    yearPayments.set(k, [...(yearPayments.get(k) ?? []), p]);
  }
  for (const [k, y] of byYearMap) {
    y.payQuery = yearPayQuery(y, today);
    // A gap in the stubs (a paycheck with no stub) leaves only the pay after it unread: the
    // year counts up to the day before it, and says so, rather than not at all.
    const gap = blockersFor(book, y.payQuery).map(findingStart).sort()[0];
    if (gap && gap > y.payQuery.from) {
      const through = addDays(gap, -1);
      const kept = yearPayments.get(k)!.filter((p) => p.date <= through);
      y.through = through;
      y.cents = kept.reduce((s, p) => s + p.amountCents, 0);
      y.payments = kept.length;
      y.explainedCents = kept.filter((p) => p.explains).reduce((s, p) => s + p.amountCents, 0);
      y.payQuery = { ...y.payQuery, to: through };
    }
    y.blockers = refs(blockersFor(book, y.payQuery));
    for (const b of y.blockers) blockers.set(b.id, b);
  }
  const stubOnlyKeys = (file.stubOnly ?? []).map((s) => ({ key: employerKey(s.employer), note: s.note ?? null }));
  const unletteredMap = new Map<string, UnletteredEmployer>();
  const stubOnlyMap = new Map<string, UnletteredEmployer & { note: string | null }>();
  for (const p of payments) {
    if ([...lettered].some((key) => sameEmployer(p.employerKey, key))) continue;
    const declared = stubOnlyKeys.find((s) => sameEmployer(p.employerKey, s.key));
    const map: Map<string, UnletteredEmployer> = declared ? stubOnlyMap : unletteredMap;
    const cur = map.get(p.employer) ?? { employer: p.employer, personName: p.personName, cents: 0, count: 0, ...(declared ? { note: declared.note } : {}) };
    cur.cents += p.amountCents;
    cur.count += 1;
    map.set(p.employer, cur);
  }
  const byCents = (a: UnletteredEmployer, b: UnletteredEmployer) => b.cents - a.cents;
  const payYears = stubOnlyPayYears(book, stubOnlyKeys.map((s) => s.key), today, nameOf);
  for (const b of payYears.blockers) blockers.set(b.id, b);

  const full = awards.filter((a) => !a.partial);
  const sum = (f: (a: AwardRow) => number) => full.reduce((s, a) => s + f(a), 0);
  const upcoming = awards.flatMap((a) => a.tranches).filter((t) => t.status === "UPCOMING" || t.status === "DUE").sort((a, b) => a.from.localeCompare(b.from));

  return {
    today,
    letters: letters.map((l) => {
      const mine = windows.filter((w) => w.letterId === l.id);
      const total = (ws: VestWindow[], f: (w: VestWindow) => number) => ws.reduce((s, w) => s + f(w), 0);
      return {
        ...l,
        windowTotals: {
          scheduledCents: total(mine, (w) => w.scheduledCents),
          paidCents: total(mine, (w) => w.paidCents),
          forfeitedCents: total(mine.filter((w) => w.status === "FORFEITED"), (w) => w.scheduledCents),
        },
      };
    }),
    awards: awards.sort((a, b) => b.year - a.year || a.employer.localeCompare(b.employer)),
    windows: windows.sort((a, b) => a.from.localeCompare(b.from)),
    payments,
    byYear: [...byYearMap.values()].sort((a, b) => b.year - a.year || a.personName.localeCompare(b.personName) || b.cents - a.cents),
    totals: {
      headlineCents: sum((a) => a.totalBonusCents ?? a.upfrontCents + a.deferredCents),
      upfrontCents: sum((a) => a.upfrontCents),
      deferredCents: sum((a) => a.deferredCents),
      deferredPaidCents: sum((a) => a.tranches.filter((t) => t.kind === "DEFERRED").reduce((s, t) => s + t.paidCents, 0)),
      forfeitedCents: sum((a) => a.forfeitedCents),
      outstandingCents: sum((a) => a.outstandingCents),
      next: upcoming[0] ?? null,
    },
    unlettered: [...unletteredMap.values()].sort(byCents),
    stubOnly: [...stubOnlyMap.values()].sort(byCents),
    payYears: payYears.rows,
    ...review,
    blockers: [...blockers.values()],
  };
}

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

const windowKey = (letterId: string, p: Pick<ScheduledPayment, "from" | "to">) => `${letterId}|${p.from}|${p.to}`;

function windowsOf(letter: AwardLetter): VestWindow[] {
  const out = new Map<string, VestWindow>();
  for (const a of letter.awards) {
    for (const p of a.payments) {
      const k = windowKey(letter.id, p);
      const w = out.get(k) ?? {
        key: k,
        letterId: letter.id,
        label: windowLabel(p.from, p.to),
        from: `${p.from}-01`,
        to: endOfMonth(`${p.to}-01`),
        parts: [],
        scheduledCents: 0,
        paidCents: 0,
        payments: [],
        status: "UPCOMING" as WindowStatus,
        detail: "",
        payQuery: null as BlockerQuery | null,
        blockers: [] as BlockerRef[],
      };
      w.parts.push({ awardYear: a.year, kind: p.kind, amountCents: cents(p.amount) });
      w.scheduledCents += cents(p.amount);
      out.set(k, w);
    }
  }
  return [...out.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/** The person and span of an employer's stubs, and who paid them next (they left). */
function employmentOf(book: Book, stubs: BookStub[], nameOf: (id: string) => string): Employment | null {
  if (!stubs.length) return null;
  const personId = stubs[0]!.personId ?? UNKNOWN_PERSON;
  const last = stubs.at(-1)!.payDate;
  const later = book.stubs
    .filter((s) => (s.personId ?? UNKNOWN_PERSON) === personId && s.payDate > last && !stubs.includes(s))
    .sort((a, b) => a.payDate.localeCompare(b.payDate))[0];
  return { personId, personName: nameOf(personId), employer: stubs[0]!.employer, employerKey: stubs[0]!.employerKey, first: stubs[0]!.payDate, last, nextEmployer: later?.employer ?? null };
}

/**
 * The stubs a payment window is settled against ("on or about": a little before it opens, a
 * month after it closes, to date), as a pay-findings query: what a missing stub could hide
 * from it. Null before the window opens: nothing is read from the stubs yet.
 */
export function windowPayQuery(w: Pick<VestWindow, "from" | "to">, personId: string, employerKeys: string[], today: string): BlockerQuery | null {
  const from = addDays(w.from, -EARLY_DAYS);
  if (from > today) return null;
  const to = addDays(w.to, LATE_DAYS);
  return { affects: "PAY", personId, employerKeys, from, to: to < today ? to : today };
}

/** A year's bonus paychecks from one employer, to date, as a pay-findings query. */
export function yearPayQuery(y: Pick<BonusYear, "year" | "personId" | "employerKeys">, today: string): BlockerQuery {
  const to = `${y.year}-12-31`;
  return { affects: "PAY", ...(y.personId === UNKNOWN_PERSON ? {} : { personId: y.personId }), employerKeys: y.employerKeys, from: `${y.year}-01-01`, to: to < today ? to : today };
}

function settle(w: VestWindow, payments: BonusPayment[], key: string, employment: Employment | null, today: string) {
  const open = addDays(w.from, -EARLY_DAYS);
  const close = addDays(w.to, LATE_DAYS);
  const paid = payments.filter((p) => !p.explains && sameEmployer(p.employerKey, key) && p.date >= open && p.date <= close);
  const left = employment?.nextEmployer != null && employment.last < w.from;
  if (paid.length) {
    for (const p of paid) p.explains = { letterId: w.letterId, window: w.label };
    w.payments = paid;
    w.paidCents = paid.reduce((s, p) => s + p.amountCents, 0);
    const diff = w.paidCents - w.scheduledCents;
    const ok = Math.abs(diff) <= 100 * w.parts.length;
    w.status = ok ? "PAID" : "PAID_DIFFERENT";
    w.detail = `Paid ${paid.map((p) => `${p.date} (${dollars(p.amountCents)})`).join(" + ")}${diff ? `, ${diff > 0 ? "+" : "−"}${dollars(Math.abs(diff))} vs the letter` : ", exactly as scheduled"}.`;
  } else if (left) {
    w.status = "FORFEITED";
    w.detail = `Vests after the last ${employment!.employer} paycheck (${employment!.last}); pay had moved to ${employment!.nextEmployer}.`;
  } else if (today < open) {
    w.status = "UPCOMING";
    w.detail = `Vests ${w.label}, if still employed then.`;
  } else if (today <= close) {
    w.status = "DUE";
    w.detail = `Due now; not on the stubs yet.`;
  } else if (!employment || employment.last < w.to) {
    w.status = "NO_STUBS";
    w.detail = employment ? `No ${employment.employer} stubs on file after ${employment.last}, so whether it was paid can't be told.` : "No stubs from this employer are on file.";
  } else {
    w.status = "NOT_ON_STUBS";
    w.detail = `Due ${w.label}; no bonus line on the stubs pays it.`;
  }
}

function letterChecks(letter: AwardLetter, a: AwardRow): BonusWarning[] {
  const out: BonusWarning[] = [];
  const id = (check: string) => `${letter.id}|${a.year}|${check}`;
  const year = { from: `${a.year}-01-01`, to: `${a.year}-12-31` };
  // One-offs are outside the headline bonus, so only the cash, deferred and plan parts must add to it.
  const tol = 100 * Math.max(1, a.tranches.filter((t) => t.kind === "UPFRONT" || t.kind === "DEFERRED").length + (a.planDeferredCents ? 1 : 0));
  const parts = a.upfrontCents + a.deferredCents + a.planDeferredCents;
  if (!a.partial && a.totalBonusCents != null && Math.abs(parts - a.totalBonusCents) > tol) {
    const plan = a.planDeferredCents ? ` + to the deferral plan ${dollars(a.planDeferredCents)}` : "";
    const text = `${letter.title}, ${a.year}: up front ${dollars(a.upfrontCents)} + deferred ${dollars(a.deferredCents)}${plan} doesn't add up to the ${dollars(a.totalBonusCents)} bonus.`;
    out.push({ id: id("bonus-adds-up"), gapCents: parts - a.totalBonusCents, ...year, text });
  }
  if (a.totalCompCents != null && a.baseCents != null && a.totalBonusCents != null && Math.abs(a.baseCents + a.totalBonusCents - a.totalCompCents) > 100) {
    const text = `${letter.title}, ${a.year}: base ${dollars(a.baseCents)} + bonus ${dollars(a.totalBonusCents)} doesn't add up to the ${dollars(a.totalCompCents)} total compensation.`;
    out.push({ id: id("comp-adds-up"), gapCents: a.baseCents + a.totalBonusCents - a.totalCompCents, ...year, text });
  }
  if (a.baseCents != null && a.stubBaseCents != null && Math.abs(a.baseCents - a.stubBaseCents) > 100) {
    const text = `${letter.title}, ${a.year}: the letter's base salary is ${dollars(a.baseCents)}; regular pay on the stubs that year is ${dollars(a.stubBaseCents)}.`;
    out.push({ id: id("base-vs-stubs"), gapCents: a.stubBaseCents - a.baseCents, ...year, text });
  }
  return out;
}

/**
 * Base and bonus by year for everyone paid by a stub-only employer: with no letters, the
 * stubs are the whole story (each year's bonus is what was paid that year).
 */
function stubOnlyPayYears(book: Book, keys: string[], today: string, nameOf: (id: string) => string): { rows: PayYearRow[]; blockers: BlockerRef[] } {
  const people = new Set(book.stubs.filter((s) => keys.some((k) => sameEmployer(s.employerKey, k))).map((s) => s.personId ?? UNKNOWN_PERSON));
  people.delete(UNKNOWN_PERSON);
  const rows: PayYearRow[] = [];
  const blockers: BlockerRef[] = [];
  for (const personId of people) {
    const years = [...new Set(book.stubs.filter((s) => s.personId === personId).map((s) => Number(s.payDate.slice(0, 4))))];
    for (const year of years) {
      const py = personPayYear(book, personId, year);
      if (!py.employers.length) continue;
      blockers.push(...refs(py.blockers));
      rows.push({
        personId,
        personName: nameOf(personId),
        year,
        employers: [...new Set(py.employers.map((e) => e.employer.replace(/ · payroll .*$/, "")))],
        baseCents: py.totals.salary,
        bonusCents: py.totals.bonus,
        last: py.through!,
        inProgress: year === Number(today.slice(0, 4)),
      });
    }
  }
  return { rows: rows.sort((a, b) => a.personName.localeCompare(b.personName) || b.year - a.year), blockers };
}

/** Splits warnings into open and reviewed. A review covers its warning only at the gap it was reviewed at. */
function applyExceptions(book: Book, warnings: BonusWarning[]): Pick<BonusesReport, "warnings" | "reviewed" | "staleReviews"> {
  const accepted = new Map(book.integrity.accepted.filter((f) => f.check === "bonus.letters").map((f) => [f.id, f]));
  return {
    warnings: warnings.filter((w) => !accepted.has(bonusFindingId(w))),
    reviewed: warnings.flatMap((w) => {
      const a = accepted.get(bonusFindingId(w));
      return a ? [{ ...w, note: a.note, reviewedAt: a.acceptedAt }] : [];
    }),
    staleReviews: book.integrity.stale.filter((e) => e.check === "bonus.letters").map((e) => ({ id: e.id, warning: e.finding.title, note: e.note, reviewedAt: e.acceptedAt })),
  };
}
