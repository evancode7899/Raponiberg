import type { BookRow } from "../book/load.ts";
import { ownedOn, SHARED, type Car, type CarEntry, type CarKind, type GarageSettings, type RowDecision, type RowLink } from "./settings.ts";

/**
 * Which ledger rows are the cars' money, and which statement charge each log entry is.
 *
 * The statements are the only source of money. A row is a car cost when the owner said
 * so (a decision on the row, one of their keywords), when a log entry matches it (the
 * owner's note of what they bought), or when its merchant is unmistakably a car cost (a
 * gas station, an auto insurer, a toll account, parking, or the same store as one of
 * those: the same store number or phone). Places that may or may not be the car (a parts
 * store, a car loan, the town, a merchant seen on a logged entry) are only suggested until
 * the owner says. The issuers' and the classifier's categories are never trusted (a gas
 * station is filed under Dining often enough), but a category the owner set by hand on
 * the Transactions page is their word: a row they filed under anything but Transportation
 * is not the car, unless they placed it here (a decision on the row, or a log entry tied
 * to it), which wins.
 *
 * A log entry is a note on the charge it matches (what it was, gallons, the odometer). It
 * never adds money of its own: an entry with no charge is listed as not found, or as
 * awaiting its statement, and counts nothing unless the owner marks it paid outside the
 * statements. Each row backs at most one match and each entry has at most one, so a
 * dollar counts once however it reached the app.
 */

export type MatchRow = Pick<BookRow, "id" | "date" | "amountCents" | "lane" | "payee" | "merchantKey" | "category" | "accountId"> & Partial<Pick<BookRow, "detail" | "classifiedBy">>;

type Rule = { re: RegExp; kind: CarKind; counted: boolean };

const RULES: Rule[] = [
  // Car loans and lease payments come first: a make's "MOTOR FINANCE" arm is not a dealer visit.
  {
    re: /MOTOR FINANC|AUTO ?FINANC|AUTO ?LOAN|CAR ?LOAN|\bHMF\b|ALLY (AUTO|PAYMT|PAYMENT)|CAPITAL ONE AUTO|TOYOTA (FIN|MOTOR CREDIT)|HONDA FIN|AMERICAN HONDA|GM FINANCIAL|FORD (CREDIT|MOTOR CR)|NISSAN (MOTOR ACCEPT|INFINITI)|SANTANDER CONSUMER|CHASE AUTO|BMW FIN|MERCEDES-?BENZ FIN|VW CREDIT|KIA (MOTORS )?FIN|SUBARU MOTORS FIN|LEXUS FIN|WESTLAKE|EXETER FIN|CREDIT ACCEPTANCE|BRIDGECREST|CARVANA|CARMAX AUTO/,
    kind: "PAYMENT",
    counted: false,
  },
  {
    // Word boundaries matter: "HEALTHCAR INS" (a health insurer, cut short) is not car insurance.
    re: /GEICO|PROGRESSIVE (INS|CASUALTY|DIRECT|\*)|STATE FARM|ALLSTATE|LIBERTY MUTUAL|TRAVELERS (INS|PERS|HOME)|NATIONWIDE (INS|MUTUAL)|\bUSAA\b|FARMERS INS|ESURANCE|ROOT INS|\bAMICA\b|THE GENERAL INS|PLYMOUTH ROCK|SAFECO|MERCURY INS|ERIE INS|KEMPER|DAIRYLAND|\bNJM\b|CLEARCOVER|\bAUTO ?INS|\bCAR ?INS/,
    kind: "INSURANCE",
    counted: true,
  },
  { re: /E-?Z ?PASS|SUNPASS|FASTRAK|I-?PASS|PEACH PASS|TXTAG|\bNTTA\b|TURNPIKE|THRUWAY|PIKEPASS|\bTOLLS?\b|TOLL BY/, kind: "TOLLS", counted: true },
  { re: /PARKING|SPOTHERO|PARKMOBILE|\bPMUSA\b|PARK ?WHIZ|LAZ PARK|ICON PARK|IMPARK|PREMIUM PARK|PAYBYPHONE|\bSP\+|VALET PARK/, kind: "PARKING", counted: true },
  { re: /CAR ?WASH|CAR ?SPA|AUTO ?SPA|AUTO ?DETAIL|WASH ?CLUB|MISTER CAR|TOMMY'?S EXPRESS|ZIPS CAR/, kind: "CARE", counted: true },
  {
    re: /JIFFY|VALVOLINE|TAKE 5 OIL|GREASE MONKEY|\bMIDAS\b|MEINEKE|PEP BOYS|FIRESTONE|GOODYEAR|DISCOUNT TIRE|TIRE ?KINGDOM|\bNTB\b|\bMAVIS\b|\bMONRO\b|\bTIRES?\b|SAFELITE|AUTO ?REPAIR|AUTO ?BODY|COLLISION|\bLUBE\b|OIL CHANGE|BRAKE|MUFFLER|TRANSMISSION/,
    kind: "REPAIR",
    counted: true,
  },
  {
    re: /\bSHELL\b|EXXON|\bMOBIL\b|CHEVRON|SUNOCO|\bBP\b|BP#|CITGO|\bGULF\b|SPEEDWAY|VALERO|MARATHON PETRO|PHILLIPS 66|CONOCO|TEXACO|\bARCO\b|CIRCLE K|CUMBERLAND FARMS|COSTCO GAS|SAMS ?CLUB FUEL|BJ'?S (GAS|FUEL)|\bGETTY\b|\bHESS\b|SHEETZ|RACETRAC|QUIKTRIP|\bPILOT\b|LOVE'?S TRAVEL|ALLIANCE ENERGY|\bFUEL\b|GASOLINE|GAS STATION|SERVICE STATION|\bPETRO(L|LEUM)?\b|PETRO-?CAN/,
    kind: "FUEL",
    counted: true,
  },
  // Places that sell more than car things, or bills that might be the car's: suggested only.
  { re: /AUTOZONE|ADVANCE AUTO|O'?REILLY AUTO|\bNAPA\b|CARQUEST|AUTO ?PARTS/, kind: "REPAIR", counted: false },
  { re: /\bDMV\b|MOTOR VEHICLE|DEPT OF MV|REGISTRATION|TAG RENEWAL|EMISSIONS|TAX COLLECTOR|VEHICLE TAX|\bMV TAX/, kind: "TAX_REG", counted: false },
  { re: /\bWAWA\b|\b7-?ELEVEN\b|\bGAS\b/, kind: "FUEL", counted: false },
];

/** Rows that look like car costs but are something else (gas utility bills, rideshares, transit, home insurance). */
const NOT_CAR = /UBER|LYFT|\bTAXI|AMTRAK|METRO-?NORTH|\bMTA\b|NJ ?TRANSIT|GAS (&|AND) ELEC|NATURAL GAS|NATIONAL GRID|CON ?ED|EVERSOURCE|PSE&G|SOUTHERN CONN|YANKEE GAS|PROPANE|HOME ?INS|RENTERS|LEMONADE/;
/** Categories a car cost is never filed under, for the rules (a matched log entry or the owner's word can still say otherwise). */
const NOT_CAR_CATEGORIES = new Set(["Housing & utilities", "Groceries", "Dining"]);
/** The category the cars' costs are filed under. */
const CAR_CATEGORY = "Transportation";
/** The owner set the category by hand (on this row, or for every row of its merchant). */
const ownerFiled = (r: Pick<MatchRow, "classifiedBy">) => r.classifiedBy === "USER" || r.classifiedBy === "user-merchant-rule";
/** Kinds of the same family: a log entry for a car wash can be the charge the rules read as a repair shop. */
const SERVICE = new Set<CarKind>(["MAINTENANCE", "REPAIR", "CARE", "EQUIPMENT", "OTHER"]);
/** Bills that buy time: one payment, many months. */
const TERM_KINDS = new Set<CarKind>(["INSURANCE", "TAX_REG", "PARKING"]);
/** Bills one payment can settle several of (two months of a loan); never fill-ups or purchases. */
const BILL_KINDS = new Set<CarKind>(["PAYMENT", "INSURANCE", "TAX_REG", "PARKING"]);
/** Merchants that sell everything: one car purchase there says nothing about the next. */
const GENERAL_STORES = /AMAZON|AMZN|WALMART|TARGET|COSTCO WHSE|BEST ?BUY|HOME ?DEPOT|LOWE'?S|EBAY|PAYPAL|VENMO|ZELLE|APPLE\.COM|SQ \*|TST\*/;

export type Basis = "rule" | "keyword" | "decision" | "make" | "log" | "store" | "merchant";

export type Detected = {
  kind: CarKind;
  counted: boolean;
  how: Basis;
  /** A keyword's car, or the one car of a dealer's make. */
  carId: string | null;
  /** The owner's keyword says it's never the car. */
  ignore?: boolean;
  /** Why it's only suggested, or which counted row it shares a store with. */
  why?: string;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const textOf = (r: Pick<MatchRow, "payee" | "merchantKey" | "detail">) => `${r.payee} ${r.merchantKey ?? ""} ${r.detail ?? ""}`.toUpperCase();

/** A matcher for the garage: the built-in rules plus the owner's keywords and each car's make (its dealer's service department). */
export function carMatcher(settings: Pick<GarageSettings, "matchRules" | "cars">) {
  const keywords = settings.matchRules.map((m) => ({ re: new RegExp(escape(m.pattern.toUpperCase())), kind: m.kind, carId: m.carId }));
  const makes = settings.cars.flatMap((c) => {
    const make = c.vehicle.make.trim().toUpperCase();
    return make.length >= 3 ? [{ re: new RegExp(`\\b${escape(make)}\\b`), carId: c.id }] : [];
  });
  return (row: Pick<MatchRow, "payee" | "merchantKey" | "category" | "lane" | "detail">): Detected | null => {
    if (row.lane !== "EXPENSE") return null;
    const text = textOf(row);
    for (const k of keywords) {
      if (!k.re.test(text)) continue;
      return k.kind === "IGNORE" ? { kind: "OTHER", counted: false, how: "keyword", carId: null, ignore: true } : { kind: k.kind, counted: true, how: "keyword", carId: k.carId };
    }
    if (NOT_CAR.test(text) || NOT_CAR_CATEGORIES.has(row.category)) return null;
    for (const r of RULES) {
      if (!r.re.test(text)) continue;
      return { kind: r.kind, counted: r.counted, how: "rule", carId: null };
    }
    // Two cars of one make: the dealer visit could be either's, so it takes the usual choice.
    const make = makes.filter((m) => m.re.test(text));
    if (make.length) return { kind: "MAINTENANCE", counted: false, how: "make", carId: make.length === 1 ? make[0]!.carId : null };
    return null;
  };
}

/** What a row says, which survives a re-import (its id doesn't): date, amount and description. */
export function rowKey(r: Pick<MatchRow, "date" | "amountCents" | "payee">): string {
  return `${r.date}|${r.amountCents}|${r.payee.replace(/\s+/g, " ").trim().toUpperCase()}`;
}

/** A row by its id, or else by its key when exactly one row has it. */
function resolver(rows: MatchRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byKey = new Map<string, MatchRow[]>();
  for (const r of rows) {
    const k = rowKey(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  return (id: string, key: string): MatchRow | undefined => byId.get(id) ?? (key && byKey.get(key)?.length === 1 ? byKey.get(key)![0] : undefined);
}

export type StatementCharge = {
  rowId: string;
  key: string;
  date: string;
  payee: string;
  /** The statement's second line (a merchant's category or phone), when it prints one. */
  detail: string | null;
  accountId: string;
  /** Positive: money spent; a refund is negative. */
  cents: number;
  kind: CarKind;
  /** The car it counts for, or SHARED (split between the cars owned that day). */
  carId: string;
  /** The car was picked for it (more than one car owned that day and nobody said which). */
  carGuessed: boolean;
  /**
   * COUNTED: a car cost (on its own merchant, the owner's word, or a log entry matching
   * it). SUGGESTED: might be the car; counts nothing until the owner says. COVERED: part
   * of a purchase, which depreciation already counts. IGNORED: not the car.
   */
  status: "COUNTED" | "SUGGESTED" | "COVERED" | "IGNORED";
  how: Basis;
  /** The log entries it is (empty: it counts on its own merchant or the owner's word). */
  entryIds: string[];
  /** A logged term (a 6-month premium) this charge is one installment of. */
  termEntryId: string | null;
  /** Why: the entry it matched, the store it shares, why it's only suggested, the purchase part. */
  reason: string | null;
};

/** A statement row as a log entry's match shows it. */
export type RowRef = { rowId: string; key: string; date: string; payee: string; cents: number; accountId: string };

/**
 * What became of one log entry. MATCHED: one or more statement rows are it (counted at
 * the statement's amount). INSTALLMENTS: a logged term paid in monthly charges, which
 * count on their own. AWAITING: dated after the last statement in. NOT_FOUND: no row is
 * it; counts nothing. OFF_STATEMENT: the owner said it was paid outside the statements;
 * its own amount counts. NO_COST: nothing paid (an odometer reading, a free fill).
 */
export type HintStatus = "MATCHED" | "INSTALLMENTS" | "AWAITING" | "NOT_FOUND" | "OFF_STATEMENT" | "NO_COST";

export type HintMatch = {
  entryId: string;
  carId: string;
  date: string;
  kind: CarKind;
  item: string;
  /** What the log says it cost. */
  cents: number;
  status: HintStatus;
  /** pinned: the owner tied it. exact: same amount. close: within a dollar or two percent. split: several rows add up to it (a tax and its fee). combined: one row pays for this and other entries (two months of a loan at once). */
  how: "pinned" | "exact" | "close" | "split" | "combined" | "installments" | null;
  /** sure: the owner's link. strong: the same amount within days at a car merchant. check: worth a look. */
  confidence: "sure" | "strong" | "check" | null;
  rows: RowRef[];
  /** What the statements say: the matched rows' total (for a combined match, the row's whole amount). */
  statementCents: number | null;
  /** Other entries the same row pays for (combined). */
  with: string[];
  note: string | null;
  /** Rows it might be, for the owner to pick (NOT_FOUND, AWAITING). */
  candidates: RowRef[];
};

const DAY = 86_400_000;
const PRE_PURCHASE_DAYS = 14;
const gapDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const dayGap = (a: string, b: string) => Math.abs(gapDays(a, b));
const spent = (r: MatchRow) => -r.amountCents;
const isFee = (r: MatchRow) => /\bFEE\b|CONVENIENCE|SERVICE CHARGE|ICI\*|PROCESSING/.test(r.payee.toUpperCase());
/** A rough name for a merchant across its rows. */
const seriesKey = (r: MatchRow) => r.merchantKey?.toUpperCase() ?? r.payee.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 14);
const normItem = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
/** The brand a bill comes from, however the issuer prints it ("GEICO AUTO (800)…", "GEICO *AUTO One GEICO Plaza"). */
const brand = (r: MatchRow) => r.payee.toUpperCase().replace(/^APLPAYs+/, "").match(/[A-Z]{3,}/)?.[0] ?? seriesKey(r);

const addMonthsIso = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/**
 * Store numbers and phone numbers a row prints: "SHELL SERVICE STATION 10004242001" and
 * "12 MAIN STREET 10004242001" are the same pump (Amex prints either), and its
 * second line carries the station's phone.
 */
function identities(r: MatchRow): string[] {
  const out: string[] = [];
  for (const m of r.payee.matchAll(/\d{6,}/g)) {
    const n = m[0].replace(/^0+/, "");
    if (n.length >= 6) out.push(`#${n}`);
  }
  const phone = (r.detail ?? "").replace(/[^\d]/g, "");
  if (phone.length >= 10 && phone.length <= 11) out.push(`tel${phone.slice(-10)}`);
  return out;
}

/**
 * The car a charge on a day goes to when the owner hasn't said: the one car owned then,
 * or with several, the usual car (else the first). Null when no car was owned, except
 * the two weeks before a purchase (registration and tax are often paid ahead).
 */
export function carFor(cars: Car[], day: string, defaultCarId: string | null): { carId: string; guessed: boolean } | null {
  const owned = cars.filter((c) => ownedOn(c, day));
  if (owned.length === 1) return { carId: owned[0]!.id, guessed: false };
  if (owned.length > 1) return { carId: owned.find((c) => c.id === defaultCarId)?.id ?? owned[0]!.id, guessed: true };
  const soon = cars.find((c) => c.vehicle.purchaseDate && day < c.vehicle.purchaseDate && dayGap(day, c.vehicle.purchaseDate) <= PRE_PURCHASE_DAYS);
  return soon ? { carId: soon.id, guessed: false } : null;
}

export type Reconciled = { charges: StatementCharge[]; hints: HintMatch[] };

/**
 * Every car charge in the ledger, and what became of every log entry.
 *
 * Log entries find their rows in rounds, each round over every entry before the next
 * (so a weaker match never takes a row a stronger one needs):
 *
 * 0. Rows the owner tied the entry to.
 * 1. The same amount, to the cent, within a week; nearest first, car merchants first.
 * 2. Within a dollar (or 2%) within three days, at a merchant that's a car cost of that kind.
 * 3. Two or three rows on one day that add up to it: a tax and its card fee.
 * 4. Several entries one row pays for: two months of a loan paid at once.
 * 5. A term logged as one premium (6 months of insurance) and paid monthly: the monthly
 *    charges in that term count on their own, and the entry adds nothing.
 *
 * A row the owner said an entry isn't is never offered to it again, and a row with an
 * entry is never counted a second time.
 */
export function reconcile(rows: MatchRow[], settings: GarageSettings, opts: { statementsThrough?: string } = {}): Reconciled {
  const cars = settings.cars.filter((c) => c.vehicle.purchaseDate);
  const through = opts.statementsThrough ?? rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const resolve = resolver(rows);
  const keyOf = new Map(rows.map((r) => [r.id, rowKey(r)]));
  const ref = (r: MatchRow): RowRef => ({ rowId: r.id, key: keyOf.get(r.id)!, date: r.date, payee: r.payee, cents: spent(r), accountId: r.accountId });

  // The owner's decisions, found by id or (after a re-import) by what the row says.
  const decided = new Map<string, RowDecision>();
  for (const [id, d] of Object.entries(settings.rowDecisions)) {
    const r = resolve(id, d.key);
    if (r) decided.set(r.id, d);
  }
  // Rows the owner placed on the Car tab: a decision, or a log entry tied to the row.
  const placed = new Set(decided.keys());
  for (const e of settings.entries)
    for (const l of e.links) {
      const r = resolve(l.rowId, l.key);
      if (r) placed.add(r.id);
    }
  // A row the owner filed by hand under another category isn't the car, whatever its
  // merchant, a keyword, a shared store number or a log entry's amount say.
  const filedElsewhere = (r: MatchRow) => ownerFiled(r) && r.category !== CAR_CATEGORY && !placed.has(r.id);
  const expense = rows.filter((r) => r.lane === "EXPENSE" && r.amountCents !== 0 && !filedElsewhere(r));

  // What each row's merchant says.
  const match = carMatcher(settings);
  const det = new Map<string, Detected>();
  for (const r of expense) {
    const d = match(r);
    if (d) det.set(r.id, d);
  }
  // An insurer paid since before there was a car insures something else (a home, the rent).
  const firstOwned = cars.map((c) => c.vehicle.purchaseDate!).sort()[0] ?? null;
  const seriesFirst = new Map<string, string>();
  for (const r of expense) {
    const k = seriesKey(r);
    if (!seriesFirst.has(k)) seriesFirst.set(k, r.date);
  }
  if (firstOwned) {
    for (const r of expense) {
      const d = det.get(r.id);
      const first = seriesFirst.get(seriesKey(r))!;
      if (d?.how === "rule" && d.kind === "INSURANCE" && first < addDaysIso(firstOwned, -31)) {
        det.set(r.id, { ...d, counted: false, why: `Paid to this insurer since ${first}, before you had a car — home or renters insurance?` });
      }
    }
  }

  // Store numbers and phones that belong to one merchant (not an ACH ID every bill shares).
  const tokenSeries = new Map<string, Set<string>>();
  for (const r of expense) for (const t of identities(r)) tokenSeries.set(t, (tokenSeries.get(t) ?? new Set()).add(seriesKey(r)));
  const goodToken = (t: string) => (tokenSeries.get(t)?.size ?? 0) <= 2;
  const isIgnored = (r: MatchRow) => decided.get(r.id)?.kind === "IGNORE" || (!decided.has(r.id) && !!det.get(r.id)?.ignore);
  /** Counted rows teach their store numbers: a row at the same store counts as the same kind. */
  const learnStores = (sources: { r: MatchRow; kind: CarKind }[], skip: (r: MatchRow) => boolean) => {
    const byToken = new Map<string, { r: MatchRow; kind: CarKind } | null>();
    for (const s of sources)
      for (const t of identities(s.r)) {
        if (!goodToken(t)) continue;
        const had = byToken.get(t);
        byToken.set(t, had === undefined ? s : had && had.kind === s.kind ? had : null);
      }
    for (const r of expense) {
      if (skip(r) || det.has(r.id) || decided.has(r.id)) continue;
      const hit = identities(r)
        .map((t) => byToken.get(t))
        .find((x) => x);
      if (hit) det.set(r.id, { kind: hit.kind, counted: true, how: "store", carId: null, why: `Same store as ${hit.r.payee}` });
    }
  };
  const countsOnOwn = (r: MatchRow): CarKind | null => {
    const d = decided.get(r.id);
    if (d) return d.kind === "IGNORE" ? null : d.kind;
    const x = det.get(r.id);
    return x && x.counted && !x.ignore ? x.kind : null;
  };
  learnStores(
    expense.flatMap((r) => {
      const k = countsOnOwn(r);
      return k ? [{ r, kind: k }] : [];
    }),
    isIgnored,
  );
  const looksCar = (r: MatchRow) => {
    const d = decided.get(r.id);
    if (d) return d.kind !== "IGNORE";
    const x = det.get(r.id);
    return !!x && !x.ignore;
  };
  /** Whether a row can be an entry of this kind: anything the rules and the owner haven't read as another kind. */
  const fits = (kind: CarKind, r: MatchRow) => {
    const d = decided.get(r.id);
    const k = d && d.kind !== "IGNORE" ? d.kind : (() => {
      const x = det.get(r.id);
      return x && x.counted && !x.ignore && x.how !== "make" ? x.kind : null;
    })();
    return !k || k === kind || (SERVICE.has(k) && SERVICE.has(kind));
  };

  // ---- log entries → rows
  const claimed = new Map<string, string[]>(); // rowId → entry ids
  const results = new Map<string, HintMatch>();
  const notes = new Map<string, string>();
  const base = (e: CarEntry): HintMatch => ({
    entryId: e.id,
    carId: e.carId,
    date: e.date,
    kind: e.kind,
    item: e.item,
    cents: e.cents,
    status: "NOT_FOUND",
    how: null,
    confidence: null,
    rows: [],
    statementCents: null,
    with: [],
    note: notes.get(e.id) ?? null,
    candidates: [],
  });
  const setMatch = (es: CarEntry[], rs: MatchRow[], how: NonNullable<HintMatch["how"]>, confidence: NonNullable<HintMatch["confidence"]>, note: string | null = null) => {
    for (const r of rs) claimed.set(r.id, es.map((e) => e.id));
    const total = rs.reduce((s, r) => s + spent(r), 0);
    for (const e of es)
      results.set(e.id, { ...base(e), status: "MATCHED", how, confidence, rows: rs.map(ref), statementCents: total, with: es.filter((x) => x.id !== e.id).map((x) => x.id), note: [notes.get(e.id), note].filter(Boolean).join(" ") || null });
  };
  const open = settings.entries.filter((e) => {
    if (e.cents === 0) {
      results.set(e.id, { ...base(e), status: "NO_COST" });
      return false;
    }
    if (e.offStatement) {
      results.set(e.id, { ...base(e), status: "OFF_STATEMENT", note: "You said this was paid outside your statements, so its own amount counts." });
      return false;
    }
    return true;
  });
  const pending = () => open.filter((e) => !results.has(e.id));
  const pool = expense.filter((r) => !isIgnored(r));
  const free = (e: CarEntry, r: MatchRow) => !claimed.has(r.id) && !e.rejected.includes(keyOf.get(r.id)!);

  // 0. tied by the owner
  for (const e of open) {
    if (!e.links.length) continue;
    const linked = e.links.map((l) => resolve(l.rowId, l.key)).filter((r): r is MatchRow => !!r);
    const mine = linked.filter((r) => !claimed.has(r.id));
    if (mine.length) setMatch([e], mine, "pinned", "sure", mine.length < e.links.length ? "Some of the rows you picked are gone or already another entry's." : null);
    // The picked row is gone (or taken): say so, and let the rounds below look for it again.
    else notes.set(e.id, linked.length ? "The row you picked is already another entry's." : "The statement row you picked isn't in the ledger any more (re-imported?).");
  }
  // 1. the same amount within a week
  {
    const pairs: { e: CarEntry; r: MatchRow; score: number; strong: boolean }[] = [];
    for (const e of pending())
      for (const r of pool) {
        if (spent(r) !== e.cents || !free(e, r) || !fits(e.kind, r)) continue;
        const gap = dayGap(e.date, r.date);
        if (gap > 7) continue;
        const car = looksCar(r);
        pairs.push({ e, r, score: gap + (car ? 0 : 0.5), strong: gap <= 3 && (car || (gap <= 1 && e.cents % 100 !== 0)) });
      }
    pairs.sort((a, b) => a.score - b.score || a.r.date.localeCompare(b.r.date));
    for (const p of pairs) if (!results.has(p.e.id) && !claimed.has(p.r.id)) setMatch([p.e], [p.r], "exact", p.strong ? "strong" : "check");
  }
  // 2. a near amount at a car merchant of the same kind (a rounded log, a pump's pre-auth)
  {
    const pairs: { e: CarEntry; r: MatchRow; score: number }[] = [];
    for (const e of pending())
      for (const r of pool) {
        if (!free(e, r) || !looksCar(r) || !fits(e.kind, r) || Math.sign(spent(r)) !== Math.sign(e.cents)) continue;
        const diff = Math.abs(spent(r) - e.cents);
        const gap = dayGap(e.date, r.date);
        if (gap <= 3 && diff <= Math.max(100, Math.abs(e.cents) * 0.02)) pairs.push({ e, r, score: gap + diff / 100 });
      }
    pairs.sort((a, b) => a.score - b.score);
    for (const p of pairs) if (!results.has(p.e.id) && !claimed.has(p.r.id)) setMatch([p.e], [p.r], "close", "check", `The statement says ${usd(spent(p.r))}; your log says ${usd(p.e.cents)}.`);
  }
  // 3. rows on one day that add up to it (a tax and its card fee)
  for (const e of pending()) {
    const near = pool.filter((r) => free(e, r) && dayGap(e.date, r.date) <= 3 && spent(r) > 0 && spent(r) < e.cents && fits(e.kind, r));
    const tol = Math.max(1, Math.round(e.cents * 0.0025));
    let best: MatchRow[] | null = null;
    const consider = (set: MatchRow[]) => {
      if (set.some((r) => r.date !== set[0]!.date)) return;
      const total = set.reduce((s, r) => s + spent(r), 0);
      if (Math.abs(total - e.cents) > tol) return;
      // Coherent: a fee beside the charge, or one merchant's rows.
      if (!set.some(isFee) && new Set(set.map(seriesKey)).size > 1) return;
      if (!best || Math.abs(total - e.cents) < Math.abs(best.reduce((s, r) => s + spent(r), 0) - e.cents)) best = set;
    };
    for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++) {
        consider([near[i]!, near[j]!]);
        for (let k = j + 1; k < near.length; k++) consider([near[i]!, near[j]!, near[k]!]);
      }
    if (best) {
      const rs = best as MatchRow[];
      const total = rs.reduce((s, r) => s + spent(r), 0);
      setMatch([e], rs, "split", "check", total === e.cents ? null : `The statement rows add up to ${usd(total)}; your log says ${usd(e.cents)}.`);
    }
  }
  // 4. one row for several entries (two loan payments made at once)
  {
    const groups = new Map<string, CarEntry[]>();
    for (const e of pending()) {
      if (!BILL_KINDS.has(e.kind)) continue;
      const k = `${e.carId}|${e.kind}|${e.kind === "PAYMENT" ? "" : normItem(e.item)}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.date.localeCompare(b.date));
      for (let size = 2; size <= 4; size++)
        for (let i = 0; i + size <= list.length; i++) {
          const g = list.slice(i, i + size);
          if (g.some((e) => results.has(e.id)) || gapDays(g[0]!.date, g[g.length - 1]!.date) > 62) continue;
          const total = g.reduce((s, e) => s + e.cents, 0);
          const from = addDaysIso(g[0]!.date, -7);
          const to = addDaysIso(g[g.length - 1]!.date, 7);
          const r = pool.find((x) => spent(x) === total && x.date >= from && x.date <= to && g.every((e) => free(e, x)) && fits(g[0]!.kind, x));
          if (r) setMatch(g, [r], "combined", looksCar(r) ? "strong" : "check", `One payment of ${usd(total)} for ${size} entries.`);
        }
    }
  }
  // 5. a term paid in monthly installments
  const termOf = new Map<string, string>(); // rowId → entry id
  for (const e of pending()
    .filter((x) => TERM_KINDS.has(x.kind) && x.months > 1)
    .sort((a, b) => a.date.localeCompare(b.date))) {
    const end = addMonthsIso(e.date, e.months);
    // Monthly charges from the term's start (or just before) to just before the next term.
    const inTerm = pool.filter((r) => countsOnOwn(r) === e.kind && !claimed.has(r.id) && !termOf.has(r.id) && r.date >= addDaysIso(e.date, -10) && r.date < addDaysIso(end, -3));
    // The insurer with the most charges in the term.
    const bySeries = new Map<string, MatchRow[]>();
    for (const r of inTerm) bySeries.set(brand(r), [...(bySeries.get(brand(r)) ?? []), r]);
    const rs = [...bySeries.values()].sort((a, b) => b.length - a.length)[0];
    if (!rs || rs.length < 2 || rs.length > e.months) continue;
    const avg = rs.reduce((s, r) => s + spent(r), 0) / rs.length;
    const perMonth = e.cents / e.months;
    if (Math.abs(avg - perMonth) > perMonth * 0.05) continue;
    for (const r of rs) termOf.set(r.id, e.id);
    const total = rs.reduce((s, r) => s + spent(r), 0);
    const elapsed = end > through ? ` so far (the term runs to ${end})` : "";
    results.set(e.id, {
      ...base(e),
      status: "INSTALLMENTS",
      how: "installments",
      confidence: Math.abs(avg - perMonth) <= perMonth * 0.01 ? "strong" : "check",
      rows: rs.map(ref),
      statementCents: total,
      note: `Paid monthly: ${rs.length} charges of about ${usd(Math.round(avg))} (${usd(total)}${elapsed}). They count on their own; this entry adds nothing.`,
    });
  }
  // Rows that firmly match an entry teach their stores too (a pump the rules don't know).
  learnStores(
    pool.flatMap((r) => {
      const ids = claimed.get(r.id);
      const h = ids && results.get(ids[0]!);
      return h && h.confidence !== "check" ? [{ r, kind: h.kind }] : [];
    }),
    (r) => isIgnored(r) || claimed.has(r.id),
  );
  // What's left: awaiting its statement, or not on any statement in.
  for (const e of open) {
    if (results.get(e.id)?.status === "MATCHED" || results.get(e.id)?.status === "INSTALLMENTS") continue;
    // Rows it might be: the same kind of car charge within five weeks first (they count on
    // their own already), then anything near its amount within two weeks.
    const sameKind = pool
      .filter((r) => !claimed.has(r.id) && !e.rejected.includes(keyOf.get(r.id)!) && countsOnOwn(r) === e.kind && dayGap(e.date, r.date) <= 35)
      .sort((a, b) => Math.abs(spent(a) - e.cents) - Math.abs(spent(b) - e.cents) || dayGap(e.date, a.date) - dayGap(e.date, b.date));
    const nearAmount = pool
      .filter((r) => free(e, r) && !sameKind.includes(r) && dayGap(e.date, r.date) <= 14 && Math.sign(spent(r)) === Math.sign(e.cents))
      .map((r) => ({ r, rel: Math.abs(spent(r) - e.cents) / Math.max(1, Math.abs(e.cents)) }))
      .filter((x) => x.rel <= 0.35)
      .sort((a, b) => a.rel - b.rel || dayGap(e.date, a.r.date) - dayGap(e.date, b.r.date))
      .map((x) => x.r);
    const candidates = [...sameKind.slice(0, 4), ...nearAmount].slice(0, 6).map(ref);
    const prior = results.get(e.id);
    const counting = sameKind.length
      ? sameKind.length === 1
        ? " A charge of this kind around then already counts on its own (listed first below)."
        : ` ${sameKind.length} charges of this kind around then already count on their own (listed first below).`
      : "";
    results.set(e.id, {
      ...base(e),
      status: e.date > through ? "AWAITING" : "NOT_FOUND",
      note:
        prior?.note ??
        notes.get(e.id) ??
        (e.date > through
          ? `Your statements are complete through ${through}; it may be on one that isn't in yet.`
          : `No statement charge is this entry, so it counts nothing.${counting} Pick its row, or mark it paid outside your statements.`),
      candidates,
    });
  }

  // And their merchants are suggested (the town that sells the parking permits).
  const merchantHints = new Map<string, { h: HintMatch; cents: number }[]>();
  for (const [rowId, ids] of claimed) {
    const h = results.get(ids[0]!)!;
    const r = resolve(rowId, "")!;
    if (!r.merchantKey || GENERAL_STORES.test(textOf(r)) || h.kind === "EQUIPMENT" || h.kind === "OTHER") continue;
    merchantHints.set(r.merchantKey, [...(merchantHints.get(r.merchantKey) ?? []), { h, cents: spent(r) }]);
  }
  /** The logged entry at this row's merchant nearest its amount (a permit, not the tax paid to the same town). */
  const merchantHint = (r: MatchRow) =>
    r.merchantKey ? [...(merchantHints.get(r.merchantKey) ?? [])].sort((a, b) => Math.abs(a.cents - spent(r)) - Math.abs(b.cents - spent(r)))[0]?.h : undefined;

  // ---- the car charges
  const known = new Set(cars.map((c) => c.id));
  const pick = (c: string | null | undefined) => (c && (known.has(c) || c === SHARED) ? c : null);
  const entryById = new Map(settings.entries.map((e) => [e.id, e]));
  const out: StatementCharge[] = [];
  for (const r of expense) {
    const ids = claimed.get(r.id) ?? [];
    const h = ids.length ? results.get(ids[0]!)! : null;
    const d = decided.get(r.id);
    const x = det.get(r.id);
    const m = !h && !d && !x ? merchantHint(r) : undefined;
    if (!h && !d && !x && !m) continue;
    const auto = carFor(cars, r.date, settings.defaultCarId);
    const chosen = pick(d?.carId) ?? pick(h ? entryById.get(h.entryId)?.carId : null) ?? pick(x?.carId);
    // Outside every car's ownership only what the owner placed counts.
    if (!auto && !chosen) continue;
    const term = termOf.get(r.id) ?? null;
    let status: StatementCharge["status"];
    let how: Basis;
    let kind: CarKind;
    let reason: string | null = null;
    if (h) {
      status = "COUNTED";
      how = "log";
      kind = d && d.kind !== "IGNORE" ? d.kind : h.kind;
      reason = `Your log: “${h.item}” on ${h.date}${h.with.length ? ` (with ${h.with.length} more)` : ""}`;
    } else if (d) {
      status = d.kind === "IGNORE" ? "IGNORED" : "COUNTED";
      how = "decision";
      kind = d.kind === "IGNORE" ? (x?.kind ?? "OTHER") : d.kind;
    } else if (x) {
      status = x.ignore ? "IGNORED" : x.counted ? "COUNTED" : "SUGGESTED";
      how = x.how;
      kind = x.kind;
      reason = x.why ?? null;
    } else {
      status = "SUGGESTED";
      how = "merchant";
      kind = m!.kind;
      reason = `Same merchant as your logged “${m!.item}” on ${m!.date}`;
    }
    if (term) reason = `One installment of your logged “${entryById.get(term)!.item}” (${entryById.get(term)!.date})`;
    out.push({
      rowId: r.id,
      key: keyOf.get(r.id)!,
      date: r.date,
      payee: r.payee,
      detail: r.detail ?? null,
      accountId: r.accountId,
      cents: spent(r),
      kind,
      carId: chosen ?? auto!.carId,
      carGuessed: !chosen && auto!.guessed,
      status,
      how,
      entryIds: ids,
      termEntryId: term,
      reason,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.rowId.localeCompare(b.rowId));

  // Part of a purchase: a charge near the purchase for the same amount as a part of it
  // (registration, sales tax, fees, warranty, down payment), which depreciation counts.
  const sameAmount = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.005);
  for (const c of out) {
    if (c.status === "IGNORED" || c.entryIds.length || c.how === "decision") continue;
    for (const car of cars) {
      const from = car.vehicle.purchaseDate!;
      if (dayGap(c.date, from) > 45 || c.date < addDaysIso(from, -PRE_PURCHASE_DAYS)) continue;
      const p = car.purchase;
      const parts: [number, string][] = [
        [p.registrationCents, "registration"],
        [p.salesTaxCents, "sales tax"],
        [p.feesCents, "dealer fees"],
        [p.warrantyCents, "extended warranty"],
        [p.downPaymentCents, "down payment"],
        [p.priceCents, "vehicle price"],
        [p.registrationCents + p.salesTaxCents, "registration and tax"],
      ];
      const part = parts.find(([amt]) => amt > 0 && sameAmount(c.cents, amt));
      if (part) {
        c.status = "COVERED";
        c.carId = car.id;
        c.carGuessed = false;
        c.reason = `Part of the purchase (${part[1]})`;
        break;
      }
    }
  }
  // Before a purchase, only what turned out to be part of it (or what the owner placed) is listed.
  const charges = out.filter((c) => c.status === "COVERED" || c.entryIds.length || cars.some((car) => ownedOn(car, c.date)) || decided.has(c.rowId));
  const hints = settings.entries.map((e) => results.get(e.id)!).sort((a, b) => a.date.localeCompare(b.date));
  return { charges, hints };
}

/** The car charges alone (see reconcile). */
export function statementCharges(rows: MatchRow[], settings: GarageSettings, opts: { statementsThrough?: string } = {}): StatementCharge[] {
  return reconcile(rows, settings, opts).charges;
}

/** Links for an entry tied to these rows (what the owner picked), keyed so they survive a re-import. */
export function linksFor(rows: Pick<RowRef, "rowId" | "key">[]): RowLink[] {
  return rows.map((r) => ({ rowId: r.rowId, key: r.key }));
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
