import { addDays, daysBetween, endOfMonth, periodLabel, startOfMonth, ymd } from "../dates/isoDate.ts";
import { reconcile, type HintMatch, type MatchRow, type StatementCharge } from "./detect.ts";
import { carName, KIND_INFO, ownedOn, SHARED, type Car, type CarEntry, type CarKind, type CostGroup, type GarageSettings } from "./settings.ts";

/**
 * Everything the Car page shows, from the owner's garage (lib/car/settings.ts) and the
 * car charges found in the ledger (lib/car/detect.ts). Pure: settings, rows and today in,
 * figures out. Each car gets its own report from the charges that are its, plus its share
 * of the shared ones (split evenly between the cars owned that day).
 *
 * Money comes from the statements alone: every cost is a statement charge (or several,
 * for a tax and its card fee), named as the statement prints it. A log entry matched to
 * a charge lends it what a statement can't say (what it was, gallons, the odometer, the
 * months a premium covers); an entry with no charge adds nothing, unless the owner marked
 * it paid outside the statements. Odometer readings and gallons come from the log either
 * way: they're facts about the car, not money.
 *
 * Costs are counted two ways. Cash: what was paid, on the day it was paid. Accrued: a
 * payment that buys months (a 6-month insurance premium, an annual car tax) is spread
 * day by day over the months it pays for, so a month's cost is what that month used
 * and the figures "to date" leave out what's prepaid. Every per-mile and per-month
 * figure is accrued.
 *
 * Depreciation is the purchase spread over the car's life, two ways: PLANNED, straight
 * line per mile from the all-in purchase cost to the expected resale value at the
 * planned selling odometer; MARKET, the all-in purchase cost less what the car is worth
 * now (the owner's value checks, extended along their trend since the last one). A car
 * that's been sold lost exactly the all-in cost less what it sold for, spread over the
 * miles it was driven.
 */

/** Cost lines: every kind but PAYMENT, plus financing interest and depreciation. */
export type CostLine = Exclude<CarKind, "PAYMENT"> | "INTEREST" | "DEPRECIATION";

export const LINE_INFO: Record<CostLine, { label: string; group: Exclude<CostGroup, "CAPITAL"> | "DEPRECIATION" }> = {
  DEPRECIATION: { label: "Depreciation", group: "DEPRECIATION" },
  FUEL: { label: KIND_INFO.FUEL.label, group: "OPERATING" },
  MAINTENANCE: { label: KIND_INFO.MAINTENANCE.label, group: "OPERATING" },
  REPAIR: { label: KIND_INFO.REPAIR.label, group: "OPERATING" },
  CARE: { label: KIND_INFO.CARE.label, group: "OPERATING" },
  TOLLS: { label: KIND_INFO.TOLLS.label, group: "OPERATING" },
  INSURANCE: { label: KIND_INFO.INSURANCE.label, group: "FIXED" },
  PARKING: { label: KIND_INFO.PARKING.label, group: "FIXED" },
  TAX_REG: { label: KIND_INFO.TAX_REG.label, group: "FIXED" },
  INTEREST: { label: "Financing interest", group: "FIXED" },
  EQUIPMENT: { label: KIND_INFO.EQUIPMENT.label, group: "FIXED" },
  OTHER: { label: KIND_INFO.OTHER.label, group: "FIXED" },
};

export const COST_LINES = Object.keys(LINE_INFO) as CostLine[];

export type CostItem = {
  id: string;
  /** The car it counts for, or SHARED (garage log only; a car's own items are its share). */
  carId: string;
  date: string;
  kind: CarKind;
  /** The statement's description (joined with " + " for a tax and its fee); paid outside the statements or in rent: what the owner called it. */
  item: string;
  /** What the log calls it ("Gas", "Car Note"), when an entry matched the charge. */
  label: string | null;
  note: string;
  cents: number;
  /** First day it pays for, and the day after the last (a one-off: the day after its date). */
  start: string;
  end: string;
  months: number;
  /** STATEMENT: one or more ledger rows. OFF_STATEMENT: an entry the owner said was paid outside the statements. RENT: parking inside the rent. */
  source: "STATEMENT" | "OFF_STATEMENT" | "RENT";
  gallons: number | null;
  odometer: number | null;
  partial: boolean;
  /** The log entries that are it. */
  entryIds: string[];
  /** The ledger rows that are it. */
  rowIds: string[];
  /** What the log said it cost, when that differs from the statement (the statement is what counts). */
  loggedCents: number | null;
  /** A share of a shared cost: how many cars it was split between. */
  splitWays: number | null;
};

/** A line of the garage log: a counted cost, or a log entry that counts nothing (and why). */
export type LogRow = CostItem & {
  counted: boolean;
  /** What became of the log entry behind it (null: a statement charge nobody logged, or rent). */
  match: HintMatch | null;
};

/** A fill-up as the MPG figures see it: gallons and odometer from the log, cost from the statement. */
type FillFact = { date: string; gallons: number | null; odometer: number | null; partial: boolean; /** What the statement says it cost, or null when no charge is known. */ cents: number | null };
/** What the log says about the car itself (not money): odometer readings and fill-ups. */
export type CarFacts = { readings: { date: string; miles: number; source: string }[]; fills: FillFact[] };

export type Fill = {
  date: string;
  odometer: number;
  miles: number;
  gallons: number;
  /** What the gallons cost on the statements, or null when a fill folded in has no charge. */
  cents: number | null;
  mpg: number;
  pricePerGallon: number | null;
  costPerMile: number | null;
  /** Miles a full tank would go at this fill's MPG. */
  range: number | null;
  /** Fills folded into this one (partials, or fills with no odometer). */
  folded: number;
};

export type MonthRow = {
  month: string;
  label: string;
  miles: number;
  /** Accrued cents by line (depreciation by the headline method). */
  lines: Record<CostLine, number>;
  plannedDepreciation: number;
  marketDepreciation: number | null;
  total: number;
  cash: number;
  cumulativeTotal: number;
  cumulativeMiles: number;
  /** Cumulative cost per mile in cents: how the all-in cost per mile settles as miles add up. */
  cumulativePerMile: number | null;
};

export type Milestone = {
  miles: number;
  items: string[];
  status: "DONE" | "OVERDUE" | "SKIPPED" | "NEXT" | "UPCOMING";
  visit: { id: string; date: string; odometer: number | null; note: string } | null;
  /** Estimated date the odometer reaches it at the current pace. */
  eta: string | null;
};

type Breakdown = Record<CostLine, number>;

export type CarReport = {
  carId: string;
  today: string;
  /** The last day the figures run to: today, or the day it was sold. */
  through: string;
  sold: boolean;
  configured: boolean;
  /** What's missing for the figures to work. */
  missing: string[];
  name: string;
  odometer: {
    purchase: number | null;
    current: number | null;
    asOf: string | null;
    driven: number;
    daysOwned: number;
    perDay: number | null;
    perYear: number | null;
    /** Miles over the last 90 days of readings, per day. */
    recentPerDay: number | null;
    readings: { date: string; miles: number; source: string }[];
  };
  acquisition: { cents: number; sunkCents: number; recoverableCents: number; deadLossShare: number | null; financedCents: number; interestCents: number };
  items: CostItem[];
  /** Accrued to date, by line (depreciation by the headline method). */
  accrued: Breakdown;
  /** Paid to date, by kind (no depreciation; PAYMENT included). */
  cash: Record<CarKind, number> & { INTEREST: number };
  /** Paid but not used yet (the rest of a premium…). */
  prepaidCents: number;
  depreciation: {
    method: "PLANNED" | "MARKET" | "SOLD";
    plannedPerMile: number | null;
    plannedToDate: number;
    marketToDate: number | null;
    /** The car's value now: the last value check, moved along the trend since. */
    marketValueNow: number | null;
    /** Trend in the values, cents per year (negative: losing value). */
    marketPerYear: number | null;
    plannedValueNow: number | null;
  };
  totals: {
    tco: number;
    perMile: number | null;
    perMonth: number | null;
    perDay: number | null;
    operating: number;
    fixed: number;
    operatingPerMile: number | null;
    /** What one more mile costs: running costs plus planned wear per mile. */
    marginalPerMile: number | null;
    fixedPerMonth: number | null;
    /** Everything paid, including buying the car (less what it sold for). */
    cashOutTheDoor: number;
  };
  last12: { from: string; lines: Breakdown; total: number; miles: number; perMile: number | null };
  outlook12: { lines: Partial<Breakdown>; total: number; miles: number; perMile: number | null; notes: string[] };
  months: MonthRow[];
  fuel: {
    fills: Fill[];
    mpg: number | null;
    recentMpg: number | null;
    bestMpg: number | null;
    worstMpg: number | null;
    pricePerGallon: number | null;
    gallons: number;
    fuelPerMile: number | null;
    avgRange: number | null;
    fillsCount: number;
    /** Fuel entries and charges with no gallons or odometer (in costs, not in MPG). */
    withoutDetail: number;
  };
  values: {
    points: { date: string; privateCents: number | null; tradeInCents: number | null; source: string }[];
    series: { date: string; label: string; privateCents: number | null; tradeInCents: number | null; planned: number | null; trend: number | null }[];
    latest: { date: string; cents: number } | null;
  };
  warranty: {
    expiresOn: string | null;
    milesLimit: number;
    milesLeft: number | null;
    daysLeft: number | null;
    /** Miles a day that would use up the mileage exactly as time runs out. */
    breakEvenPerDay: number | null;
    /** Odometer when time runs out, at the current pace. */
    odometerAtExpiry: number | null;
    endsBy: "TIME" | "MILES" | null;
    endsOn: string | null;
  };
  service: {
    /** The usual miles between services (the schedule's shortest interval). */
    baseMiles: number;
    milestones: Milestone[];
    /** The next scheduled service on the grid (what work it is). */
    next: Milestone | null;
    /**
     * The odometer the next service is due at: the next grid mileage, or the usual
     * interval on from where the last service was actually done, whichever is sooner
     * (a 56k service done at 53,750 makes the next one due by 61,750, not 64k).
     */
    dueMiles: number | null;
    milesToNext: number | null;
    /** The time limit: last visit + serviceEveryMonths. */
    dueByDate: string | null;
    /** Which limit comes first at the current pace. */
    dueBy: "MILES" | "TIME" | null;
    /** The date it falls due: the time limit, or when the odometer reaches dueMiles at the current pace. */
    nextDueDate: string | null;
    /** The odometer expected on nextDueDate. */
    odometerAtDue: number | null;
    overdue: boolean;
    lastVisit: { date: string; miles: number | null; milestone: number } | null;
  };
  insurance: {
    premiums: { date: string; cents: number; months: number; monthlyCents: number; changeShare: number | null; source: CostItem["source"] }[];
    monthlyCents: number | null;
    renewsOn: string | null;
    expectedCents: number | null;
  };
  equipment: CostItem[];
};

export type GarageReport = {
  today: string;
  /** The last day the statements are in for (a log entry after it is awaiting its statement). */
  statementsThrough: string;
  cars: CarReport[];
  /**
   * The log: every counted cost (statement charges, entries paid outside the statements,
   * rent months) once at its full amount with the car it's for (or SHARED), and every log
   * entry that counts nothing, newest last.
   */
  log: LogRow[];
  statements: {
    charges: StatementCharge[];
    /** What became of every log entry. */
    hints: HintMatch[];
    suggested: number;
    counted: number;
    covered: number;
    ignored: number;
    /** Counted on a car picked for them. */
    guessed: number;
    audit: Audit;
  };
};

/** The proof that every dollar counts once, and where every log entry went. */
export type Audit = {
  /** Statement rows counted, and their total. */
  rows: number;
  rowsCents: number;
  /** Of that, car payments (the purchase, not a cost). */
  paymentCents: number;
  /** Of them, rows a log entry matched, and rows counted on their own merchant or the owner's word. */
  rowsFromLog: number;
  rowsOnOwn: number;
  /** Rows counted more than once (always empty; a check, not a figure). */
  doubleCounted: string[];
  entries: number;
  matched: number;
  /** What the matched entries say they cost, and what the statements say (the one that counts). */
  matchedLoggedCents: number;
  matchedStatementCents: number;
  installments: number;
  awaiting: number;
  awaitingCents: number;
  notFound: number;
  notFoundCents: number;
  offStatement: number;
  /** The only money that comes from the log. */
  offStatementCents: number;
  noCost: number;
  /** Matches worth a look (an amount that differs, a split, a merchant the rules don't know). */
  toCheck: number;
};

const emptyBreakdown = (): Breakdown => Object.fromEntries(COST_LINES.map((l) => [l, 0])) as Breakdown;
const sum = (b: Partial<Breakdown>) => Object.values(b).reduce((s, v) => s + (v ?? 0), 0);
const DAYS_PER_MONTH = 365.25 / 12;

export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const d = Number(iso.slice(8, 10));
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = Number(endOfMonth(ymd(yy, mm + 1, 1)).slice(8, 10));
  return ymd(yy, mm + 1, Math.min(d, last));
}

/** Cents of an item that fall in [from, to] (inclusive days). */
function overlap(item: Pick<CostItem, "start" | "end" | "cents">, from: string, to: string): number {
  const span = daysBetween(item.start, item.end);
  if (span <= 0) return 0;
  const a = item.start > from ? item.start : from;
  const bExcl = item.end < addDays(to, 1) ? item.end : addDays(to, 1);
  const days = daysBetween(a, bExcl);
  if (days <= 0) return 0;
  return days >= span ? item.cents : (item.cents * days) / span;
}

const lineOf = (k: CarKind): CostLine | null => (k === "PAYMENT" ? null : k);

/** Least-squares slope (cents per day) of value points, or null with fewer than two dates. */
function trendPerDay(points: { date: string; cents: number }[]): number | null {
  if (points.length < 2) return null;
  const x0 = points[0]!.date;
  const xs = points.map((p) => daysBetween(x0, p.date));
  const ys = points.map((p) => p.cents);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den ? num / den : null;
}

const spread = (date: string, months: number) => ({ start: date, end: months > 1 ? addMonths(date, months) : addDays(date, 1) });

/**
 * The garage's figures: the statement charges and which car each is for, what became of
 * every log entry, the log, and a report for every car.
 */
export function buildGarage(settings: GarageSettings, rows: MatchRow[], today: string, opts: { statementsThrough?: string } = {}): GarageReport {
  const { charges, hints } = reconcile(rows, settings, opts);
  const statementsThrough = opts.statementsThrough ?? rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const entryById = new Map(settings.entries.map((e) => [e.id, e]));
  const hintById = new Map(hints.map((h) => [h.entryId, h]));
  const counted = charges.filter((c) => c.status === "COUNTED");

  // A premium pays for the time until the insurer's next charge: monthly payers' charges
  // a month apart, a 6-month term's six. A lone charge gets the kind's default; a charge
  // a log entry matched takes the months the entry says.
  const termMonths = new Map<string, number>();
  for (const kind of ["INSURANCE", "TAX_REG"] as const) {
    const byPayee = new Map<string, StatementCharge[]>();
    for (const c of counted) {
      if (c.kind !== kind || c.cents <= 0 || c.entryIds.length) continue;
      const key = `${c.carId}|${c.payee.toUpperCase().replace(/[^A-Z]/g, "")}`;
      byPayee.set(key, [...(byPayee.get(key) ?? []), c]);
    }
    for (const list of byPayee.values()) {
      const gaps = list.slice(1).map((c, i) => Math.min(12, Math.max(1, Math.round(daysBetween(list[i]!.date, c.date) / DAYS_PER_MONTH))));
      list.forEach((c, i) => termMonths.set(c.rowId, c.termEntryId ? 1 : (gaps[i] ?? gaps[i - 1] ?? KIND_INFO[kind].months)));
    }
  }

  // One cost per match: a charge on its own, a tax and its fee together, one payment for two entries.
  const groups = new Map<string, StatementCharge[]>();
  for (const c of counted) {
    const k = c.entryIds.length ? `e:${[...c.entryIds].sort().join(",")}` : `r:${c.rowId}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const base: CostItem[] = [];
  for (const [k, cs] of groups) {
    const first = cs[0]!;
    const es = first.entryIds.map((id) => entryById.get(id)).filter((x): x is CarEntry => !!x);
    const e = es[0] ?? null;
    const cents = cs.reduce((s, c) => s + c.cents, 0);
    const logged = es.reduce((s, x) => s + x.cents, 0);
    const term = first.termEntryId ? entryById.get(first.termEntryId) : undefined;
    const months = e ? e.months : (termMonths.get(first.rowId) ?? KIND_INFO[first.kind].months);
    base.push({
      id: k,
      carId: first.carId,
      date: first.date,
      kind: first.kind,
      item: cs.map((c) => c.payee).join(" + "),
      label: es.length ? [...new Set(es.map((x) => x.item))].join(", ") : term ? `${term.item} (paid monthly)` : null,
      note: es.map((x) => x.note).filter(Boolean).join(" · "),
      cents,
      ...spread(first.date, months),
      months,
      source: "STATEMENT",
      gallons: es.length === 1 ? e!.gallons : null,
      odometer: es.length === 1 ? e!.odometer : null,
      partial: es.length === 1 ? e!.partial : false,
      entryIds: es.map((x) => x.id),
      rowIds: cs.map((c) => c.rowId),
      loggedCents: es.length && logged !== cents ? logged : null,
      splitWays: null,
    });
  }
  // Paid outside the statements: the only costs that come from the log, each one the owner's say-so.
  for (const h of hints) {
    if (h.status !== "OFF_STATEMENT") continue;
    const e = entryById.get(h.entryId)!;
    base.push({
      id: `off:${e.id}`,
      carId: e.carId,
      date: e.date,
      kind: e.kind,
      item: e.item,
      label: null,
      note: e.note,
      cents: e.cents,
      ...spread(e.date, e.months),
      months: e.months,
      source: "OFF_STATEMENT",
      gallons: e.gallons,
      odometer: e.odometer,
      partial: e.partial,
      entryIds: [e.id],
      rowIds: [],
      loggedCents: null,
      splitWays: null,
    });
  }
  base.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // What the log says about each car that isn't money: odometer readings and fill-ups,
  // each fill with what its statement charge cost (null when it has none).
  const fillCents = (e: CarEntry): number | null => {
    const h = hintById.get(e.id);
    if (!h) return null;
    if (h.status === "OFF_STATEMENT") return e.cents;
    if (h.status !== "MATCHED" || h.statementCents == null) return null;
    if (!h.with.length) return h.statementCents;
    // One charge for several fills: each its logged share.
    const group = [e, ...h.with.map((id) => entryById.get(id)).filter((x): x is CarEntry => !!x)];
    const logged = group.reduce((s, x) => s + x.cents, 0);
    return logged ? Math.round((h.statementCents * e.cents) / logged) : null;
  };
  const factsFor = (carId: string): CarFacts => {
    const own = settings.entries.filter((e) => e.carId === carId);
    const fills: FillFact[] = own
      .filter((e) => e.kind === "FUEL" && (e.cents !== 0 || (e.gallons ?? 0) > 0))
      .map((e) => ({ date: e.date, gallons: e.gallons, odometer: e.odometer, partial: e.partial, cents: fillCents(e) }));
    // A fill-up on a statement nobody logged: its cost is known, its gallons aren't.
    for (const it of base)
      if (it.carId === carId && it.kind === "FUEL" && it.source === "STATEMENT" && !it.entryIds.length && it.cents > 0) fills.push({ date: it.date, gallons: null, odometer: null, partial: false, cents: it.cents });
    fills.sort((a, b) => a.date.localeCompare(b.date));
    return { readings: own.filter((e) => e.odometer != null).map((e) => ({ date: e.date, miles: e.odometer!, source: e.item })), fills };
  };

  const cars = settings.cars.map((car) => {
    const own: CostItem[] = [];
    for (const it of base) {
      if (it.carId === car.id) own.push(it);
      else if (it.carId === SHARED) {
        // A shared cost is split between the cars owned that day; an odometer or gallons can't be both cars'.
        const owners = settings.cars.filter((c) => ownedOn(c, it.date));
        const ways = owners.length || 1;
        if (owners.length ? owners.some((c) => c.id === car.id) : settings.cars.length === 1)
          own.push({ ...it, id: `${it.id}:${car.id}`, cents: it.cents / ways, gallons: null, odometer: null, splitWays: ways > 1 ? ways : null });
      }
    }
    return buildCarReport(car, own, factsFor(car.id), today);
  });

  // The log: counted costs, rent months, and every entry that counts nothing.
  const rent = cars.flatMap((c) => c.items.filter((i) => i.source === "RENT"));
  const quiet: CostItem[] = hints
    .filter((h) => h.status !== "MATCHED" && h.status !== "OFF_STATEMENT")
    .map((h) => {
      const e = entryById.get(h.entryId)!;
      return {
        id: `entry:${e.id}`,
        carId: e.carId,
        date: e.date,
        kind: e.kind,
        item: e.item,
        label: null,
        note: e.note,
        cents: e.cents,
        ...spread(e.date, e.months),
        months: e.months,
        source: "STATEMENT" as const,
        gallons: e.gallons,
        odometer: e.odometer,
        partial: e.partial,
        entryIds: [e.id],
        rowIds: h.rows.map((r) => r.rowId),
        loggedCents: null,
        splitWays: null,
      };
    });
  const log: LogRow[] = [
    ...base.map((i) => ({ ...i, counted: true, match: i.entryIds.length ? (hintById.get(i.entryIds[0]!) ?? null) : null })),
    ...rent.map((i) => ({ ...i, counted: true, match: null })),
    ...quiet.map((i) => ({ ...i, counted: false, match: hintById.get(i.entryIds[0]!) ?? null })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // The checks: no row in two costs, and no entry's own money except where the owner said so.
  const seen = new Map<string, number>();
  for (const i of base) for (const r of i.rowIds) seen.set(r, (seen.get(r) ?? 0) + 1);
  const of = (s: HintMatch["status"]) => hints.filter((h) => h.status === s);
  const sumCents = (hs: HintMatch[]) => hs.reduce((s, h) => s + h.cents, 0);
  const matched = of("MATCHED");
  const audit: Audit = {
    rows: seen.size,
    rowsCents: base.filter((i) => i.source === "STATEMENT").reduce((s, i) => s + i.cents, 0),
    paymentCents: base.filter((i) => i.source === "STATEMENT" && i.kind === "PAYMENT").reduce((s, i) => s + i.cents, 0),
    rowsFromLog: counted.filter((c) => c.entryIds.length).length,
    rowsOnOwn: counted.filter((c) => !c.entryIds.length).length,
    doubleCounted: [...seen].filter(([, n]) => n > 1).map(([r]) => r),
    entries: hints.length,
    matched: matched.length,
    matchedLoggedCents: sumCents(matched),
    // A payment for several entries is counted once, however many it pays for.
    matchedStatementCents: [...new Map(matched.map((h) => [h.rows.map((r) => r.rowId).join(","), h.statementCents ?? 0])).values()].reduce((s, c) => s + c, 0),
    installments: of("INSTALLMENTS").length,
    awaiting: of("AWAITING").length,
    awaitingCents: sumCents(of("AWAITING")),
    notFound: of("NOT_FOUND").length,
    notFoundCents: sumCents(of("NOT_FOUND")),
    offStatement: of("OFF_STATEMENT").length,
    offStatementCents: sumCents(of("OFF_STATEMENT")),
    noCost: of("NO_COST").length,
    toCheck: hints.filter((h) => h.confidence === "check").length,
  };

  return {
    today,
    statementsThrough,
    cars,
    log,
    statements: {
      charges,
      hints,
      suggested: charges.filter((c) => c.status === "SUGGESTED").length,
      counted: counted.length,
      covered: charges.filter((c) => c.status === "COVERED").length,
      ignored: charges.filter((c) => c.status === "IGNORED").length,
      guessed: counted.filter((c) => c.carGuessed).length,
      audit,
    },
  };
}

/** One car's figures from its own cost items (its charges, and its share of shared ones) and what its log says (readings, fill-ups). */
export function buildCarReport(car: Car, ownItems: CostItem[], facts: CarFacts, today: string): CarReport {
  const v = car.vehicle;
  const p = car.purchase;
  const purchaseDate = v.purchaseDate;
  const sold = !!car.sale && car.sale.date <= today;
  /** Figures run to here: today, or the day it was sold. */
  const end = sold ? car.sale!.date : today;
  const missing: string[] = [];
  if (!purchaseDate) missing.push("the purchase date");
  if (v.purchaseOdometer == null) missing.push("the odometer at purchase");
  if (!p.priceCents) missing.push("the purchase price");
  const configured = Boolean(purchaseDate && v.purchaseOdometer != null);
  const name = carName(car);

  // ---- cost items: what's the car's, plus parking paid in the rent
  const items: CostItem[] = [...ownItems];
  const thisMonth = end.slice(0, 7);
  for (const rp of car.rentParking) {
    const last = rp.toMonth && rp.toMonth < thisMonth ? rp.toMonth : thisMonth;
    for (let m = rp.fromMonth; m <= last; m = addMonths(`${m}-01`, 1).slice(0, 7)) {
      const date = `${m}-01`;
      const monthEnd = addMonths(date, 1);
      // A month whose spot is already paid for another way (a prepaid stretch of parking in
      // the log, a monthly parking charge on a statement) isn't paid again through the rent.
      const paid = items.some((i) => i.kind === "PARKING" && i.source !== "RENT" && i.start < monthEnd && i.end > date && i.cents / Math.max(1, i.months) >= rp.monthlyCents * 0.5);
      if (paid) continue;
      items.push({
        id: `rent:${car.id}:${rp.id}:${m}`,
        carId: car.id,
        date,
        kind: "PARKING",
        item: "Parking (in rent)",
        label: null,
        note: "",
        cents: rp.monthlyCents,
        start: date,
        end: monthEnd,
        months: 1,
        source: "RENT",
        gallons: null,
        odometer: null,
        partial: false,
        entryIds: [],
        rowIds: [],
        loggedCents: null,
        splitWays: null,
      });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // Financing interest, spread from purchase to payoff.
  const interestItem =
    purchaseDate && p.interestCents
      ? { start: purchaseDate, end: p.loanPaidOffDate && p.loanPaidOffDate > purchaseDate ? addDays(p.loanPaidOffDate, 1) : addDays(purchaseDate, 1), cents: p.interestCents }
      : null;

  // ---- odometer
  const readings: { date: string; miles: number; source: string }[] = [];
  if (purchaseDate && v.purchaseOdometer != null) readings.push({ date: purchaseDate, miles: v.purchaseOdometer, source: "Purchase" });
  readings.push(...facts.readings);
  for (const s of car.serviceVisits) if (s.odometer != null) readings.push({ date: s.date, miles: s.odometer, source: "Service" });
  if (car.sale?.odometer != null) readings.push({ date: car.sale.date, miles: car.sale.odometer, source: "Sold" });
  readings.sort((a, b) => a.date.localeCompare(b.date) || a.miles - b.miles);
  // An odometer never goes back: a reading below an earlier one is a typo and is dropped.
  const odo: typeof readings = [];
  for (const r of readings) {
    if (purchaseDate && r.date < purchaseDate) continue;
    if (r.date > end) continue;
    if (odo.length && r.miles < odo[odo.length - 1]!.miles) continue;
    if (odo.length && odo[odo.length - 1]!.date === r.date) {
      if (r.miles > odo[odo.length - 1]!.miles) odo[odo.length - 1] = r;
    } else odo.push(r);
  }
  const first = odo[0] ?? null;
  const lastR = odo[odo.length - 1] ?? null;
  const odoAt = (date: string): number | null => {
    if (!first) return null;
    if (date <= first.date) return first.miles;
    for (let i = 1; i < odo.length; i++) {
      const b = odo[i]!;
      if (date <= b.date) {
        const a = odo[i - 1]!;
        return a.miles + ((b.miles - a.miles) * daysBetween(a.date, date)) / Math.max(1, daysBetween(a.date, b.date));
      }
    }
    return lastR!.miles;
  };
  const driven = first && lastR ? lastR.miles - first.miles : 0;
  const daysOwned = purchaseDate ? Math.max(0, daysBetween(purchaseDate, end)) : 0;
  const readDays = first && lastR ? daysBetween(first.date, lastR.date) : 0;
  const perDay = readDays >= 14 ? driven / readDays : null;
  let recentPerDay: number | null = null;
  if (lastR && readDays >= 14) {
    const from = addDays(lastR.date, -90);
    const o = odoAt(from > first!.date ? from : first!.date)!;
    const d = daysBetween(from > first!.date ? from : first!.date, lastR.date);
    recentPerDay = d >= 14 ? (lastR.miles - o) / d : perDay;
  }
  const pace = recentPerDay ?? perDay;
  /** Where the odometer is on a day at the current pace (past the last reading). */
  const odoProjected = (date: string): number | null => (lastR && pace ? lastR.miles + pace * Math.max(0, daysBetween(lastR.date, date)) : (lastR?.miles ?? null));
  const etaFor = (miles: number): string | null => {
    if (!lastR || !pace || pace <= 0) return null;
    if (miles <= lastR.miles) return null;
    return addDays(lastR.date, Math.ceil((miles - lastR.miles) / pace));
  };

  // ---- purchase & depreciation
  const acquisition = p.priceCents + p.feesCents + p.warrantyCents + p.registrationCents + p.salesTaxCents;
  const recoverable = p.priceCents + p.warrantyCents;
  const realized = sold ? acquisition - car.sale!.priceCents : null;
  const lifeMiles = v.purchaseOdometer != null ? car.plan.sellAtMiles - v.purchaseOdometer : 0;
  const plannedPerMile =
    realized != null ? (driven > 0 ? Math.max(0, realized) / driven : null) : acquisition && lifeMiles > 0 ? Math.max(0, acquisition - car.plan.residualCents) / lifeMiles : null;
  const plannedToDate = realized != null ? Math.max(0, realized) : plannedPerMile ? plannedPerMile * driven : 0;
  const plannedValueAt = (date: string) => {
    const o = odoAt(date);
    return plannedPerMile != null && o != null && v.purchaseOdometer != null ? acquisition - plannedPerMile * (o - v.purchaseOdometer) : null;
  };

  const valuePts = car.values.map((x) => ({ date: x.date, cents: x.privateCents ?? x.tradeInCents! })).filter((x) => (!purchaseDate || x.date >= purchaseDate) && x.date <= end);
  const slope = trendPerDay(valuePts);
  const trendSlope = slope != null ? Math.min(0, slope) : null;
  const lastValue = valuePts[valuePts.length - 1] ?? null;
  /** Market value on a day: purchase cost on the day of purchase, between checks a straight line, after the last one along the trend. */
  const marketValueAt = (date: string): number | null => {
    if (!lastValue || !purchaseDate) return null;
    const pts = [{ date: purchaseDate, cents: acquisition }, ...valuePts.filter((x) => x.date > purchaseDate)];
    // The day-one loss (fees, tax, dealer margin) lands on the first check, so the curve starts at the first check's value.
    if (valuePts[0] && valuePts[0].date === purchaseDate) pts[0] = { date: purchaseDate, cents: valuePts[0].cents };
    if (date <= pts[0]!.date) return pts[0]!.cents;
    for (let i = 1; i < pts.length; i++) {
      const b = pts[i]!;
      if (date <= b.date) {
        const a = pts[i - 1]!;
        return a.cents + ((b.cents - a.cents) * daysBetween(a.date, date)) / Math.max(1, daysBetween(a.date, b.date));
      }
    }
    const last = pts[pts.length - 1]!;
    return last.cents + (trendSlope ?? 0) * daysBetween(last.date, date);
  };
  const marketValueNow = sold ? car.sale!.priceCents : marketValueAt(end);
  const marketToDate = marketValueNow != null ? acquisition - marketValueNow : null;
  const method: CarReport["depreciation"]["method"] = sold ? "SOLD" : car.plan.depreciation === "MARKET" && marketToDate != null ? "MARKET" : "PLANNED";
  const depreciationToDate = method === "MARKET" ? marketToDate! : plannedToDate;

  // ---- totals to date
  const accrued = emptyBreakdown();
  const cash = { ...Object.fromEntries((Object.keys(KIND_INFO) as CarKind[]).map((k) => [k, 0])), INTEREST: 0 } as CarReport["cash"];
  let prepaid = 0;
  for (const it of items) {
    if (it.date > end) continue;
    cash[it.kind] += it.cents;
    const line = lineOf(it.kind);
    const used = overlap(it, it.start, end);
    if (line) accrued[line] += used;
    if (line) prepaid += it.cents - used;
  }
  if (interestItem && interestItem.start <= end) {
    cash.INTEREST = interestItem.end <= addDays(end, 1) ? interestItem.cents : Math.round(overlap(interestItem, interestItem.start, end));
    accrued.INTEREST = overlap(interestItem, interestItem.start, end);
  }
  accrued.DEPRECIATION = depreciationToDate;
  for (const l of COST_LINES) accrued[l] = Math.round(accrued[l]);
  for (const k of Object.keys(cash) as (keyof typeof cash)[]) cash[k] = Math.round(cash[k]);

  const tco = sum(accrued);
  const operating = COST_LINES.filter((l) => LINE_INFO[l].group === "OPERATING").reduce((s, l) => s + accrued[l], 0);
  const fixed = COST_LINES.filter((l) => LINE_INFO[l].group === "FIXED").reduce((s, l) => s + accrued[l], 0);
  const monthsOwned = daysOwned / DAYS_PER_MONTH;
  const per = (c: number, d: number) => (d > 0 ? c / d : null);
  const cashOutTheDoor = acquisition + p.interestCents - (sold ? car.sale!.priceCents : 0) + Object.entries(cash).reduce((s, [k, c]) => (k === "PAYMENT" || k === "INTEREST" ? s : s + c), 0);

  // ---- months
  const months: MonthRow[] = [];
  if (purchaseDate) {
    let cumTotal = 0;
    let cumMiles = 0;
    for (let m = startOfMonth(purchaseDate); m <= end; m = addMonths(m, 1)) {
      const from = m < purchaseDate ? purchaseDate : m;
      const to = endOfMonth(m) < end ? endOfMonth(m) : end;
      const lines = emptyBreakdown();
      let cashM = 0;
      for (const it of items) {
        const line = lineOf(it.kind);
        if (it.date >= m && it.date <= endOfMonth(m)) cashM += it.cents;
        if (line && it.start <= to && it.end > from) lines[line] += overlap(it, from, to);
      }
      if (interestItem) lines.INTEREST = overlap(interestItem, from, to);
      const o1 = odoAt(addDays(from, -1) < purchaseDate ? purchaseDate : addDays(from, -1)) ?? 0;
      const o2 = odoAt(to) ?? 0;
      const miles = Math.max(0, o2 - o1);
      const planned = plannedPerMile ? plannedPerMile * miles : 0;
      const prior = from === purchaseDate ? acquisition : marketValueAt(addDays(from, -1));
      const mv = marketValueAt(to);
      const market = mv != null && prior != null ? prior - mv : null;
      lines.DEPRECIATION = method === "MARKET" && market != null ? market : planned;
      for (const l of COST_LINES) lines[l] = Math.round(lines[l]);
      const total = sum(lines);
      cumTotal += total;
      cumMiles += miles;
      months.push({
        month: m.slice(0, 7),
        label: periodLabel(m, "month"),
        miles: Math.round(miles),
        lines,
        plannedDepreciation: Math.round(planned),
        marketDepreciation: market == null ? null : Math.round(market),
        total,
        cash: Math.round(cashM),
        cumulativeTotal: cumTotal,
        cumulativeMiles: Math.round(cumMiles),
        cumulativePerMile: cumMiles >= 100 ? cumTotal / cumMiles : null,
      });
    }
  }

  // ---- last 12 months (of ownership)
  const l12from = purchaseDate && addDays(addMonths(end, -12), 1) < purchaseDate ? purchaseDate : addDays(addMonths(end, -12), 1);
  const l12 = emptyBreakdown();
  for (const it of items) {
    const line = lineOf(it.kind);
    if (line) l12[line] += overlap(it, l12from, end);
  }
  if (interestItem) l12.INTEREST = overlap(interestItem, l12from, end);
  const l12miles = Math.max(0, (odoAt(end) ?? 0) - (odoAt(l12from) ?? 0));
  if (method === "MARKET") {
    const a = marketValueAt(l12from === purchaseDate ? purchaseDate : addDays(l12from, -1));
    const b = marketValueAt(end);
    l12.DEPRECIATION = a != null && b != null ? (l12from === purchaseDate ? acquisition : a) - b : 0;
  } else l12.DEPRECIATION = plannedPerMile ? plannedPerMile * l12miles : 0;
  for (const l of COST_LINES) l12[l] = Math.round(l12[l]);
  const l12total = sum(l12);

  // ---- fuel
  // Fill-ups from the log (gallons, odometer) with their statement cost, plus statement
  // fill-ups nobody logged; a fill whose cost is unknown leaves its span's price unknown.
  const fuelFacts = facts.fills.filter((f) => (!purchaseDate || f.date >= purchaseDate) && f.date <= end);
  const fills: Fill[] = [];
  let prevOdo = v.purchaseOdometer;
  let accG = 0;
  let accC: number | null = 0;
  let folded = 0;
  // A fill-up with no gallons (a bare statement charge) leaves the gallons for the next
  // span unknown: MPG restarts at the next full fill with an odometer reading.
  let gap = false;
  for (const f of fuelFacts) {
    if (f.gallons == null || f.gallons <= 0) {
      if ((f.cents ?? 0) > 0) gap = true;
      continue;
    }
    if (gap) {
      if (f.odometer != null && !f.partial) {
        prevOdo = f.odometer;
        accG = 0;
        accC = 0;
        folded = 0;
        gap = false;
      }
      continue;
    }
    accG += f.gallons;
    accC = accC == null || f.cents == null ? null : accC + f.cents;
    if (f.partial || f.odometer == null || prevOdo == null) {
      folded++;
      if (f.odometer != null && prevOdo == null) {
        prevOdo = f.odometer;
        accG = 0;
        accC = 0;
        folded = 0;
      }
      continue;
    }
    const miles = f.odometer - prevOdo;
    if (miles > 0 && accG > 0) {
      const mpg = miles / accG;
      fills.push({
        date: f.date,
        odometer: f.odometer,
        miles,
        gallons: Math.round(accG * 1000) / 1000,
        cents: accC,
        mpg,
        pricePerGallon: accC == null ? null : accC / accG,
        costPerMile: accC == null ? null : accC / miles,
        range: v.tankGallons ? mpg * v.tankGallons : null,
        folded,
      });
    }
    prevOdo = f.odometer;
    accG = 0;
    accC = 0;
    folded = 0;
  }
  const fMiles = fills.reduce((s, f) => s + f.miles, 0);
  const fGal = fills.reduce((s, f) => s + f.gallons, 0);
  const recent = fills.slice(-5);
  const withGallons = fuelFacts.filter((f) => f.gallons != null && f.gallons > 0);
  const allGallons = withGallons.reduce((s, f) => s + f.gallons!, 0);
  const priced = withGallons.filter((f) => f.cents != null);
  const pricedGallons = priced.reduce((s, f) => s + f.gallons!, 0);
  const mpgs = fills.map((f) => f.mpg);

  // ---- values
  const valueSeries: CarReport["values"]["series"] = [];
  if (purchaseDate) {
    const dates = new Set<string>([purchaseDate, ...car.values.map((x) => x.date).filter((d) => d >= purchaseDate && d <= end)]);
    for (let m = addMonths(startOfMonth(purchaseDate), 1); m <= end; m = addMonths(m, 1)) dates.add(m);
    dates.add(end);
    const byDate = new Map(car.values.map((x) => [x.date, x]));
    for (const d of [...dates].sort()) {
      const x = byDate.get(d);
      const planned = plannedValueAt(d);
      valueSeries.push({
        date: d,
        label: new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
        privateCents: x?.privateCents ?? (sold && d === end ? car.sale!.priceCents : null),
        tradeInCents: x?.tradeInCents ?? null,
        planned: planned == null ? null : Math.round(planned),
        trend: !sold && lastValue && d >= lastValue.date ? Math.round(marketValueAt(d)!) : null,
      });
    }
  }

  // ---- warranty
  const w = car.plan;
  const expiresOn = v.inServiceDate && w.warrantyYears ? addMonths(v.inServiceDate, Math.round(w.warrantyYears * 12)) : null;
  const curMiles = lastR?.miles ?? null;
  const milesLeft = curMiles != null && w.warrantyMiles ? w.warrantyMiles - curMiles : null;
  const daysLeft = expiresOn ? daysBetween(today, expiresOn) : null;
  const odometerAtExpiry = expiresOn && lastR && pace ? lastR.miles + pace * daysBetween(lastR.date, expiresOn) : null;
  const milesEnd = w.warrantyMiles ? etaFor(w.warrantyMiles) : null;
  const endsBy: "TIME" | "MILES" | null = !expiresOn && !milesEnd ? null : !milesEnd ? "TIME" : !expiresOn ? "MILES" : milesEnd < expiresOn ? "MILES" : "TIME";

  // ---- service: every-N-miles rules, and rules listing their exact mileages (a manual's grid)
  const periodic = car.serviceRules.filter((r) => !r.atMiles?.length && r.everyMiles > 0);
  const listed = [...new Set(car.serviceRules.flatMap((r) => r.atMiles ?? []))].sort((a, b) => a - b);
  const gaps = listed.slice(1).map((m, i) => m - listed[i]!).filter((g) => g > 0);
  // A grid's interval is its usual step between columns (a last odd column, 144k → 150k, isn't it).
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  const usualGap = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const baseMiles = periodic.length ? Math.min(...periodic.map((r) => r.everyMiles)) : (usualGap ?? 8000);
  const startMiles = Math.max(baseMiles, Math.round((v.purchaseOdometer ?? 0) / baseMiles) * baseMiles);
  const lastVisit = [...car.serviceVisits].sort((a, b) => a.milestoneMiles - b.milestoneMiles).pop() ?? null;
  const cur = lastR?.miles ?? v.purchaseOdometer ?? 0;
  const endMiles = Math.max(cur, lastVisit?.milestoneMiles ?? 0) + 5 * baseMiles;
  const visitsBy = new Map(car.serviceVisits.map((s) => [s.milestoneMiles, s]));
  const candidates = new Set<number>(listed.filter((m) => m >= Math.min(startMiles, listed[0] ?? startMiles) && m <= endMiles));
  if (periodic.length) for (let m = startMiles; m <= endMiles; m += baseMiles) candidates.add(m);
  for (const s of car.serviceVisits) candidates.add(s.milestoneMiles);
  const milestones: Milestone[] = [];
  for (const m of [...candidates].sort((a, b) => a - b)) {
    const due = car.serviceRules.filter((r) => {
      if (r.atMiles?.length) return r.atMiles.includes(m);
      if (!r.everyMiles) return false;
      const f = r.firstAtMiles ?? r.everyMiles;
      return m >= f && (m - f) % r.everyMiles === 0;
    });
    const visit = visitsBy.get(m) ?? null;
    if (!due.length && !visit) continue;
    milestones.push({
      miles: m,
      items: due.map((r) => r.item),
      status: visit ? "DONE" : "UPCOMING",
      visit: visit ? { id: visit.id, date: visit.date, odometer: visit.odometer ?? (odoAt(visit.date) == null ? null : Math.round(odoAt(visit.date)!)), note: visit.note } : null,
      eta: visit ? null : etaFor(m),
    });
  }
  const lastDoneIdx = milestones.map((m) => m.status).lastIndexOf("DONE");
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i]!;
    if (m.status === "DONE") continue;
    if (i < lastDoneIdx) m.status = "SKIPPED";
    else if (m.miles <= cur) m.status = "OVERDUE";
  }
  const next = milestones.find((m, i) => i > lastDoneIdx && m.status !== "DONE") ?? null;
  if (next && next.status === "UPCOMING") next.status = "NEXT";
  // When the next service is due: the usual interval on from where the last one was
  // really done (early services pull the next one in), the next grid mileage, or the
  // months since the last visit, whichever comes first.
  const lastVisitByDate = [...car.serviceVisits].sort((a, b) => a.date.localeCompare(b.date) || a.milestoneMiles - b.milestoneMiles).pop() ?? null;
  const lastVisitOdo = lastVisitByDate ? (lastVisitByDate.odometer ?? odoAt(lastVisitByDate.date)) : null;
  const fromVisit = lastVisitOdo != null ? Math.round(lastVisitOdo + baseMiles) : null;
  const dueMiles = next && fromVisit != null ? Math.min(next.miles, fromVisit) : (next?.miles ?? fromVisit);
  const dueByDate = lastVisitByDate && w.serviceEveryMonths ? addMonths(lastVisitByDate.date, w.serviceEveryMonths) : null;
  const milesDate = dueMiles != null ? etaFor(dueMiles) : null;
  const milesOverdue = dueMiles != null && cur >= dueMiles;
  const dueBy: "MILES" | "TIME" | null = milesOverdue ? "MILES" : dueByDate && (!milesDate || dueByDate <= milesDate) ? "TIME" : dueMiles != null ? "MILES" : null;
  const nextDueDate = dueBy === "TIME" ? dueByDate : milesDate;
  const odometerAtDue = dueBy === "TIME" && dueByDate ? odoProjected(dueByDate) : dueMiles;

  // ---- insurance
  const prem = items.filter((i) => i.kind === "INSURANCE" && i.cents > 0);
  const premiums = prem.map((i, k) => {
    const monthly = i.cents / i.months;
    const prev = k > 0 ? prem[k - 1]!.cents / prem[k - 1]!.months : null;
    return { date: i.date, cents: Math.round(i.cents), months: i.months, monthlyCents: Math.round(monthly), changeShare: prev ? monthly / prev - 1 : null, source: i.source };
  });
  const lastPrem = prem[prem.length - 1] ?? null;
  const renewsOn = !sold && lastPrem && lastPrem.months > 1 ? lastPrem.end : null;

  // ---- next 12 months (estimate)
  const yearMiles = sold ? 0 : pace ? pace * 365 : l12miles;
  const notes: string[] = [];
  const out: Partial<Breakdown> = {};
  if (!sold) {
    const l12perMile = (line: CostLine) => (l12miles > 0 ? l12[line] / l12miles : 0);
    for (const line of ["FUEL", "MAINTENANCE", "REPAIR", "CARE", "TOLLS"] as const) out[line] = Math.round(l12perMile(line) * yearMiles);
    if (lastPrem) {
      out.INSURANCE = Math.round((lastPrem.cents / lastPrem.months) * 12);
      notes.push("Insurance at the latest premium");
    }
    const rentNow = car.rentParking.find((r) => r.fromMonth <= thisMonth && (!r.toMonth || r.toMonth >= thisMonth));
    out.PARKING = Math.round(rentNow ? rentNow.monthlyCents * 12 + items.filter((i) => i.kind === "PARKING" && i.source !== "RENT").reduce((s, i) => s + overlap(i, l12from, end), 0) : l12.PARKING);
    out.TAX_REG = l12.TAX_REG;
    if (interestItem && interestItem.end > addDays(end, 1)) out.INTEREST = Math.round(overlap(interestItem, addDays(end, 1), addMonths(end, 12)));
    if (method === "MARKET" && trendSlope != null) {
      out.DEPRECIATION = Math.round(-trendSlope * 365);
      notes.push("Depreciation along the trend in your value checks");
    } else out.DEPRECIATION = plannedPerMile ? Math.round(plannedPerMile * yearMiles) : 0;
    notes.push(`Driving costs per mile from the last 12 months, at ${Math.round(yearMiles).toLocaleString("en-US")} miles a year`);
  }
  const outTotal = sum(out);

  return {
    carId: car.id,
    today,
    through: end,
    sold,
    configured,
    missing,
    name,
    odometer: {
      purchase: v.purchaseOdometer,
      current: lastR?.miles ?? null,
      asOf: lastR?.date ?? null,
      driven,
      daysOwned,
      perDay,
      perYear: perDay ? perDay * 365 : null,
      recentPerDay,
      readings: odo,
    },
    acquisition: {
      cents: acquisition,
      sunkCents: acquisition - recoverable,
      recoverableCents: recoverable,
      deadLossShare: acquisition ? 1 - recoverable / acquisition : null,
      financedCents: Math.max(0, acquisition - p.downPaymentCents),
      interestCents: p.interestCents,
    },
    items,
    accrued,
    cash,
    prepaidCents: Math.round(prepaid),
    depreciation: {
      method,
      plannedPerMile,
      plannedToDate: Math.round(plannedToDate),
      marketToDate: marketToDate == null ? null : Math.round(marketToDate),
      marketValueNow: marketValueNow == null ? null : Math.round(marketValueNow),
      marketPerYear: trendSlope == null ? null : Math.round(trendSlope * 365),
      plannedValueNow: plannedValueAt(end) == null ? null : Math.round(plannedValueAt(end)!),
    },
    totals: {
      tco,
      perMile: per(tco, driven),
      perMonth: monthsOwned >= 1 ? tco / monthsOwned : null,
      perDay: per(tco, daysOwned),
      operating,
      fixed,
      operatingPerMile: per(operating, driven),
      marginalPerMile: driven > 0 ? operating / driven + (plannedPerMile ?? 0) : null,
      fixedPerMonth: monthsOwned >= 1 ? fixed / monthsOwned : null,
      cashOutTheDoor: Math.round(cashOutTheDoor),
    },
    last12: { from: l12from, lines: l12, total: l12total, miles: Math.round(l12miles), perMile: per(l12total, l12miles) },
    outlook12: { lines: out, total: outTotal, miles: Math.round(yearMiles), perMile: per(outTotal, yearMiles), notes },
    months,
    fuel: {
      fills,
      mpg: fGal > 0 ? fMiles / fGal : null,
      recentMpg: recent.length ? recent.reduce((s, f) => s + f.miles, 0) / recent.reduce((s, f) => s + f.gallons, 0) : null,
      bestMpg: mpgs.length ? Math.max(...mpgs) : null,
      worstMpg: mpgs.length ? Math.min(...mpgs) : null,
      pricePerGallon: pricedGallons > 0 ? priced.reduce((s, f) => s + f.cents!, 0) / pricedGallons : null,
      gallons: Math.round(allGallons * 1000) / 1000,
      fuelPerMile: per(accrued.FUEL, driven),
      avgRange: v.tankGallons && fGal > 0 ? (fMiles / fGal) * v.tankGallons : null,
      fillsCount: fuelFacts.filter((f) => (f.cents ?? 0) > 0 || (f.gallons ?? 0) > 0).length,
      withoutDetail: fuelFacts.filter((f) => (f.cents ?? 0) > 0 && (f.gallons == null || f.odometer == null)).length,
    },
    values: { points: car.values, series: valueSeries, latest: lastValue },
    warranty: {
      expiresOn,
      milesLimit: w.warrantyMiles,
      milesLeft,
      daysLeft,
      breakEvenPerDay: milesLeft != null && daysLeft != null && daysLeft > 0 ? milesLeft / daysLeft : null,
      odometerAtExpiry: odometerAtExpiry == null ? null : Math.round(odometerAtExpiry),
      endsBy,
      endsOn: endsBy === "MILES" ? milesEnd : expiresOn,
    },
    service: {
      baseMiles,
      milestones,
      next,
      dueMiles,
      milesToNext: dueMiles != null ? dueMiles - cur : null,
      dueByDate,
      dueBy,
      nextDueDate,
      odometerAtDue: odometerAtDue == null ? null : Math.round(odometerAtDue),
      overdue: milesOverdue || (dueByDate != null && dueByDate < today),
      lastVisit: lastVisitByDate ? { date: lastVisitByDate.date, miles: lastVisitOdo == null ? null : Math.round(lastVisitOdo), milestone: lastVisitByDate.milestoneMiles } : null,
    },
    insurance: {
      premiums,
      monthlyCents: lastPrem ? Math.round(lastPrem.cents / lastPrem.months) : null,
      renewsOn,
      expectedCents: lastPrem ? Math.round(lastPrem.cents) : null,
    },
    equipment: items.filter((i) => i.kind === "EQUIPMENT"),
  };
}
