import { isIsoDate } from "../dates/isoDate.ts";
import { asObject, asString, isNum } from "../settingsStore.ts";

/**
 * The garage: every car the household owns or has owned, each with its purchase, plan,
 * value checks and service history, and one log of costs and odometer readings in which
 * each entry belongs to a car (or is shared between the cars owned that day). Statement
 * charges are given to a car the same way. All of it is the owner's input, entered in the
 * app; the figures (cost per mile, MPG, depreciation…) are built from it and the ledger
 * by lib/car/report.ts. The money always comes from the statements: a log entry is a
 * note on the statement charge it matches (what it was, gallons, the odometer) and adds
 * nothing of its own unless the owner marks it paid outside the statements. Stored as one AppSetting, so it's in the database and its
 * backups, never in the code.
 */

/** What a cost was for. Each kind sits in one cost group (see KIND_INFO). */
export type CarKind = "FUEL" | "MAINTENANCE" | "REPAIR" | "CARE" | "TOLLS" | "INSURANCE" | "PARKING" | "TAX_REG" | "EQUIPMENT" | "OTHER" | "PAYMENT";

export const CAR_KINDS: CarKind[] = ["FUEL", "MAINTENANCE", "REPAIR", "CARE", "TOLLS", "INSURANCE", "PARKING", "TAX_REG", "EQUIPMENT", "OTHER", "PAYMENT"];

/**
 * OPERATING costs grow with every mile (the marginal cost of driving); FIXED costs come
 * with owning the car whether it moves or not; CAPITAL is money toward buying the car
 * itself (down payment, loan payments), which the purchase and depreciation already
 * count, so it is cash out the door but never a cost on its own.
 */
export type CostGroup = "OPERATING" | "FIXED" | "CAPITAL";

export const KIND_INFO: Record<CarKind, { label: string; group: CostGroup; /** Default months a payment covers (spread over). */ months: number }> = {
  FUEL: { label: "Fuel", group: "OPERATING", months: 1 },
  MAINTENANCE: { label: "Scheduled maintenance", group: "OPERATING", months: 1 },
  REPAIR: { label: "Repairs & tires", group: "OPERATING", months: 1 },
  CARE: { label: "Washes & care", group: "OPERATING", months: 1 },
  TOLLS: { label: "Tolls", group: "OPERATING", months: 1 },
  INSURANCE: { label: "Insurance", group: "FIXED", months: 6 },
  PARKING: { label: "Parking", group: "FIXED", months: 1 },
  TAX_REG: { label: "Taxes & registration", group: "FIXED", months: 12 },
  EQUIPMENT: { label: "Equipment & accessories", group: "FIXED", months: 1 },
  OTHER: { label: "Other", group: "FIXED", months: 1 },
  PAYMENT: { label: "Car payment (purchase)", group: "CAPITAL", months: 1 },
};

export const isCarKind = (v: unknown): v is CarKind => typeof v === "string" && (CAR_KINDS as string[]).includes(v);

/** An entry or charge split evenly between the cars owned on its date (one policy, one parking bill). */
export const SHARED = "shared";

export type CarEntry = {
  id: string;
  /** The car it belongs to, or SHARED. */
  carId: string;
  date: string;
  kind: CarKind;
  /** What it was ("Oil change", "Gas"). */
  item: string;
  note: string;
  cents: number;
  /** Fuel: gallons bought. */
  gallons: number | null;
  /** Odometer at the time, if read. */
  odometer: number | null;
  /** Fuel: not filled to full (its gallons roll into the next full fill's MPG). */
  partial: boolean;
  /** Months the payment pays for, from its date (a 6-month premium is 6). */
  months: number;
  /**
   * Statement rows the owner tied this entry to (one, or several that add up to it: a
   * tax and its card fee). Empty: the engine finds them (lib/car/detect.ts).
   */
  links: RowLink[];
  /** Statement rows (by key) the owner said this entry is not. */
  rejected: string[];
  /**
   * Paid outside the statements (cash, an account the app doesn't have): the owner
   * confirmed it, so the entry's own amount counts. Every other entry is only a note
   * on a statement charge and never adds money of its own.
   */
  offStatement: boolean;
};

/**
 * A statement row, held by its id and by what it says (date, amount, description), so a
 * link or decision survives a re-import or a rebuilt database that gives rows new ids.
 */
export type RowLink = { rowId: string; key: string };

export type ValuePoint = { id: string; date: string; /** Private-party value. */ privateCents: number | null; tradeInCents: number | null; source: string };

export type ServiceRule = {
  id: string;
  item: string;
  /** Due every this many miles (0 when `atMiles` lists the mileages instead). */
  everyMiles: number;
  /** First due at this odometer (default: everyMiles). */
  firstAtMiles: number | null;
  /** Due at exactly these mileages (a schedule copied from the manual's grid), or null. */
  atMiles?: number[] | null;
};

export type ServiceVisit = { id: string; date: string; odometer: number | null; /** The scheduled service it fulfils (e.g. 56000). */ milestoneMiles: number; note: string };

/** Parking paid inside the rent: a monthly amount over a span of months. */
export type RentParking = { id: string; fromMonth: string; /** Last month, or null for "still paying". */ toMonth: string | null; monthlyCents: number };

/** A merchant word the owner wants read as a car cost (their town's tax collector, a local garage), or never as one (IGNORE). */
export type MatchRule = { id: string; pattern: string; kind: CarKind | "IGNORE"; /** The car it's for, or null for the usual choice. */ carId: string | null };

/** The owner's word on a statement row: what it is (or not the car), and which car (null: the usual choice). */
export type RowDecision = { kind: CarKind | "IGNORE"; carId: string | null; /** The row's key (see RowLink), "" when not known yet. */ key: string };

export type Car = {
  id: string;
  vehicle: {
    name: string;
    make: string;
    model: string;
    year: number | null;
    trim: string;
    color: string;
    vin: string;
    /** When the car first went into service (the warranty clock starts here). */
    inServiceDate: string | null;
    /** When you bought it. Ownership, statements and every per-mile figure start here. */
    purchaseDate: string | null;
    purchaseOdometer: number | null;
    tankGallons: number | null;
  };
  purchase: {
    priceCents: number;
    feesCents: number;
    warrantyCents: number;
    registrationCents: number;
    salesTaxCents: number;
    downPaymentCents: number;
    /** Total interest paid on the loan. */
    interestCents: number;
    /** When the loan was paid off; interest is spread from purchase to here. */
    loanPaidOffDate: string | null;
  };
  plan: {
    /** Odometer you expect to sell at (planned depreciation spreads the purchase to here). */
    sellAtMiles: number;
    /** What you expect to get for it then. */
    residualCents: number;
    warrantyMiles: number;
    warrantyYears: number;
    /** Service is also due this many months after the last visit, whichever comes first. */
    serviceEveryMonths: number;
    /** Headline depreciation: planned straight line, or market value (needs values below). */
    depreciation: "PLANNED" | "MARKET";
  };
  /** Sold (or otherwise gone): ownership and every figure stop here. */
  sale: { date: string; odometer: number | null; priceCents: number } | null;
  values: ValuePoint[];
  serviceRules: ServiceRule[];
  serviceVisits: ServiceVisit[];
  rentParking: RentParking[];
};

export type GarageSettings = {
  version: 2;
  cars: Car[];
  /** Every cost and odometer reading, each tied to a car (or SHARED). */
  entries: CarEntry[];
  matchRules: MatchRule[];
  /** Statement rows the owner has decided on. */
  rowDecisions: Record<string, RowDecision>;
  /** Where a statement charge goes when more than one car was owned that day and nobody said. */
  defaultCarId: string | null;
};

export const CAR_KEY = "car.v1";

/** A typical gasoline-car schedule; edit it to match the owner's manual. */
export const DEFAULT_SERVICE_RULES: Omit<ServiceRule, "id">[] = [
  { item: "Engine oil & filter", everyMiles: 8000, firstAtMiles: null },
  { item: "Tire rotation", everyMiles: 8000, firstAtMiles: null },
  { item: "Multi-point inspection (brakes, belts, hoses, suspension, battery)", everyMiles: 8000, firstAtMiles: null },
  { item: "Cabin air filter", everyMiles: 16000, firstAtMiles: null },
  { item: "Engine air filter", everyMiles: 24000, firstAtMiles: null },
  { item: "Brake fluid", everyMiles: 48000, firstAtMiles: null },
  { item: "Spark plugs", everyMiles: 96000, firstAtMiles: null },
  { item: "Coolant", everyMiles: 120000, firstAtMiles: null },
];

const MAX_ENTRIES = 5000;
const MAX_CARS = 12;

const date = (v: unknown) => (typeof v === "string" && isIsoDate(v) ? v : null);
const month = (v: unknown) => (typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : null);
const cents = (v: unknown) => (isNum(v) ? Math.round(v) : 0);
const posCents = (v: unknown) => (isNum(v) && v >= 0 ? Math.round(v) : 0);
const optCents = (v: unknown) => (isNum(v) && v >= 0 ? Math.round(v) : null);
const optNum = (v: unknown, max = 1e7) => (isNum(v) && v >= 0 && v <= max ? v : null);
const id = (v: unknown) => asString(v, 40) || newId();
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

export function newId(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** "2022 Zephyr Roadster", or the nickname. */
export function carName(car: Pick<Car, "vehicle">, fallback = "Car"): string {
  const v = car.vehicle;
  return v.name.trim() || [v.year, v.make, v.model].filter(Boolean).join(" ") || fallback;
}

/** Whether the car was the household's on a day (bought on or before it, not yet sold). */
export function ownedOn(car: Car, day: string): boolean {
  return !!car.vehicle.purchaseDate && car.vehicle.purchaseDate <= day && (!car.sale || day <= car.sale.date);
}

export function defaultGarage(): GarageSettings {
  return normalizeGarage(null);
}

export function newCar(): Car {
  return normalizeCar({ id: newId() });
}

export function normalizeEntry(raw: unknown, fallbackCar = SHARED): CarEntry | null {
  const o = asObject(raw);
  const d = date(o.date);
  if (!d) return null;
  const kind = isCarKind(o.kind) ? o.kind : "OTHER";
  const months = isNum(o.months) && o.months >= 1 && o.months <= 60 ? Math.round(o.months) : KIND_INFO[kind].months;
  return {
    id: id(o.id),
    carId: asString(o.carId, 40) || fallbackCar,
    date: d,
    kind,
    item: asString(o.item, 80) || KIND_INFO[kind].label,
    note: asString(o.note, 200),
    cents: cents(o.cents),
    gallons: kind === "FUEL" ? optNum(o.gallons, 500) : null,
    odometer: optNum(o.odometer, 2_000_000),
    partial: kind === "FUEL" && o.partial === true,
    months,
    links: rowLinks(o.links, o.rowId),
    rejected: list(o.rejected, 50).flatMap((k) => (typeof k === "string" && k ? [k.slice(0, 200)] : [])),
    offStatement: o.offStatement === true,
  };
}

/** Tied rows; an entry from before links held keys kept one bare row id. */
function rowLinks(raw: unknown, legacyRowId: unknown): RowLink[] {
  const out: RowLink[] = [];
  for (const x of list(raw, 12)) {
    const o = asObject(x);
    const rowId = asString(o.rowId, 60);
    const key = asString(o.key, 200);
    if ((rowId || key) && !out.some((l) => (rowId && l.rowId === rowId) || (key && l.key === key))) out.push({ rowId, key });
  }
  const legacy = asString(legacyRowId, 60);
  if (!out.length && legacy) out.push({ rowId: legacy, key: "" });
  return out;
}

export function normalizeCar(raw: unknown): Car {
  const r = asObject(raw);
  const v = asObject(r.vehicle);
  const p = asObject(r.purchase);
  const pl = asObject(r.plan);
  const sale = asObject(r.sale);
  const saleDate = date(sale.date);
  const rules = Array.isArray(r.serviceRules) ? r.serviceRules : DEFAULT_SERVICE_RULES;
  return {
    id: asString(r.id, 40) || "car-1",
    vehicle: {
      name: asString(v.name, 60),
      make: asString(v.make, 40),
      model: asString(v.model, 40),
      year: isNum(v.year) && v.year >= 1900 && v.year <= 2100 ? Math.round(v.year) : null,
      trim: asString(v.trim, 40),
      color: asString(v.color, 40),
      vin: asString(v.vin, 20),
      inServiceDate: date(v.inServiceDate),
      purchaseDate: date(v.purchaseDate),
      purchaseOdometer: optNum(v.purchaseOdometer, 2_000_000),
      tankGallons: optNum(v.tankGallons, 100),
    },
    purchase: {
      priceCents: posCents(p.priceCents),
      feesCents: posCents(p.feesCents),
      warrantyCents: posCents(p.warrantyCents),
      registrationCents: posCents(p.registrationCents),
      salesTaxCents: posCents(p.salesTaxCents),
      downPaymentCents: posCents(p.downPaymentCents),
      interestCents: posCents(p.interestCents),
      loanPaidOffDate: date(p.loanPaidOffDate),
    },
    plan: {
      sellAtMiles: isNum(pl.sellAtMiles) && pl.sellAtMiles > 0 ? Math.round(pl.sellAtMiles) : 100_000,
      residualCents: posCents(pl.residualCents),
      warrantyMiles: isNum(pl.warrantyMiles) && pl.warrantyMiles >= 0 ? Math.round(pl.warrantyMiles) : 100_000,
      warrantyYears: isNum(pl.warrantyYears) && pl.warrantyYears >= 0 && pl.warrantyYears <= 30 ? pl.warrantyYears : 10,
      serviceEveryMonths: isNum(pl.serviceEveryMonths) && pl.serviceEveryMonths >= 0 && pl.serviceEveryMonths <= 60 ? Math.round(pl.serviceEveryMonths) : 12,
      depreciation: pl.depreciation === "MARKET" ? "MARKET" : "PLANNED",
    },
    sale: saleDate ? { date: saleDate, odometer: optNum(sale.odometer, 2_000_000), priceCents: posCents(sale.priceCents) } : null,
    values: list(r.values, 500)
      .flatMap((x) => {
        const o = asObject(x);
        const d = date(o.date);
        const priv = optCents(o.privateCents);
        const trade = optCents(o.tradeInCents);
        return d && (priv != null || trade != null) ? [{ id: id(o.id), date: d, privateCents: priv, tradeInCents: trade, source: asString(o.source, 40) }] : [];
      })
      .sort((a, b) => a.date.localeCompare(b.date)),
    serviceRules: list(rules, 60).flatMap((x, i) => {
      const o = asObject(x);
      const item = asString(o.item, 120).trim();
      const atMiles = Array.isArray(o.atMiles) ? [...new Set(o.atMiles.filter((m): m is number => isNum(m) && m > 0 && m < 2_000_000).map(Math.round))].sort((a, b) => a - b) : [];
      const every = isNum(o.everyMiles) && o.everyMiles >= 500 ? Math.round(o.everyMiles) : 0;
      if (!item || (!every && !atMiles.length)) return [];
      return [{ id: asString(o.id, 40) || `rule-${i}`, item, everyMiles: atMiles.length ? 0 : every, firstAtMiles: optNum(o.firstAtMiles, 2_000_000), atMiles: atMiles.length ? atMiles : null }];
    }),
    serviceVisits: list(r.serviceVisits, 500)
      .flatMap((x) => {
        const o = asObject(x);
        const d = date(o.date);
        if (!d || !isNum(o.milestoneMiles)) return [];
        return [{ id: id(o.id), date: d, odometer: optNum(o.odometer, 2_000_000), milestoneMiles: Math.round(o.milestoneMiles), note: asString(o.note, 200) }];
      })
      .sort((a, b) => a.milestoneMiles - b.milestoneMiles),
    rentParking: list(r.rentParking, 50).flatMap((x) => {
      const o = asObject(x);
      const from = month(o.fromMonth);
      const to = month(o.toMonth);
      if (!from || !isNum(o.monthlyCents) || o.monthlyCents <= 0) return [];
      return [{ id: id(o.id), fromMonth: from, toMonth: to && to >= from ? to : null, monthlyCents: Math.round(o.monthlyCents) }];
    }),
  };
}

/**
 * The garage, from what's stored. A version-1 log (one car, kept before cars could be
 * added) becomes the garage's first car, with every entry and statement decision its own.
 */
export function normalizeGarage(raw: unknown): GarageSettings {
  const r = asObject(raw);
  const v1 = r.version !== 2 && (r.vehicle != null || r.entries != null);
  const carsRaw = v1 ? [{ ...r, id: "car-1", values: list(r.values, 500).map((x) => ({ ...asObject(x), source: asObject(x).source === "Workbook" ? "" : asObject(x).source })) }] : list(r.cars, MAX_CARS);
  const seen = new Set<string>();
  const cars = carsRaw.map(normalizeCar).map((c) => (seen.has(c.id) ? { ...c, id: newId() } : c));
  for (const c of cars) seen.add(c.id);
  const only = cars.length === 1 ? cars[0]!.id : SHARED;
  const known = (c: unknown) => (typeof c === "string" && (seen.has(c) || c === SHARED) ? c : null);

  const decisions: Record<string, RowDecision> = {};
  for (const [k, d] of Object.entries(asObject(r.rowDecisions)).slice(0, 5000)) {
    // Version 1 kept just the kind.
    const o = typeof d === "string" ? { kind: d } : asObject(d);
    if (o.kind === "IGNORE" || isCarKind(o.kind)) decisions[k.slice(0, 60)] = { kind: o.kind, carId: known(o.carId), key: asString(o.key, 200) };
  }
  return {
    version: 2,
    cars,
    entries: list(r.entries, MAX_ENTRIES)
      .map((e) => normalizeEntry(e, v1 ? only : SHARED))
      .filter((e): e is CarEntry => e !== null)
      .map((e) => (known(e.carId) ? e : { ...e, carId: only }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    matchRules: list(r.matchRules, 50).flatMap((x) => {
      const o = asObject(x);
      const pattern = asString(o.pattern, 60).trim();
      return pattern && (isCarKind(o.kind) || o.kind === "IGNORE") ? [{ id: id(o.id), pattern, kind: o.kind, carId: known(o.carId) }] : [];
    }),
    rowDecisions: decisions,
    defaultCarId: known(r.defaultCarId) === SHARED ? null : known(r.defaultCarId),
  };
}
