/**
 * Scenarios: named "what if" plans the owner compares side by side against today's plan
 * (the shared forecast, lib/forecast). A scenario only lists what it changes; everything it
 * leaves alone is today's plan, so a new scenario starts identical to it. Stored as one
 * JSON file in the data folder (lib/scenarios/store.ts), covered by backup and restore.
 *
 * Money is integer cents, rates are ratios, dates are months (YYYY-MM).
 */

/** One adult's pay, changed. Every field left null keeps today's plan. */
export type PersonChange = {
  personId: string;
  /** Yearly raise on base pay; null = the forecast's. */
  raise: number | null;
  /** Estimated bonuses as a share of today's plan (1 = as planned, 0 = none). Letters and paid bonuses stay as dated. */
  bonusLevel: number;
  /** A new job from `from`: annual base pay then (raises follow each January), and its bonus as a share of base (null = scale today's estimates with pay). */
  jobChange: { from: string; salary: number; bonusPct: number | null } | null;
  /** Part-time from `from`: this share of full pay. */
  partTime: { from: string; share: number } | null;
  /** Stops working from `from`: pay, bonuses and retirement saving stop. `endsCare`: childcare that needs both adults working stops too. */
  stop: { from: string; endsCare: boolean } | null;
};

/** A child the scenario adds, expected in month `born`. */
export type AddedChild = { id: string; label: string; born: string };

export type BuyHome = {
  /** Month of the purchase (down payment and closing leave cash then; rent stops). */
  at: string;
  price: number;
  /** Share of the price paid down. */
  downPct: number;
  /** Mortgage rate and term. */
  rate: number;
  termYears: number;
  /** Property tax and upkeep, each a share of the home's value a year. */
  taxRate: number;
  upkeepRate: number;
  /** Homeowner's insurance a year (grows with inflation). */
  insurance: number;
  /** HOA dues and utilities a month (grow with inflation). */
  hoa: number;
  utilities: number;
  /** Closing costs, a share of the price. */
  closingPct: number;
  /** Yearly change in the home's value; null = inflation. */
  appreciation: number | null;
};

export type Housing = {
  /** Rent's yearly growth (renting, and until a purchase); null = like the rest of living cost. */
  rentGrowth: number | null;
  /** Null: keep renting. */
  buy: BuyHome | null;
};

export type OneOff = { id: string; label: string; amount: number; at: string };

export type Scenario = {
  id: string;
  name: string;
  people: PersonChange[];
  children: {
    added: AddedChild[];
    /** Today's children leave care by the age bands too (today's plan keeps today's childcare). */
    ageOut: boolean;
  };
  housing: Housing;
  spending: {
    /** Annual living cost (today's dollars); null = the forecast's. */
    living: number | null;
    /** A change to it a year (today's dollars, negative: less), on top of either; null = none. */
    livingChange: number | null;
    /** Its yearly growth; null = the forecast's (or a changed inflation when the forecast ties them). */
    growth: number | null;
    oneOffs: OneOff[];
  };
  /** Shared assumptions; null = the forecast's. */
  assumptions: { returnRate: number | null; inflation: number | null };
  /** Years more of work before walking away (negative: sooner): FIRE's plan moves its walk-away year by this much. */
  retire: { workYears: number };
};

/** A band of children's ages and the share of full-time childcare a child that age needs. */
export type CareBand = { fromAge: number; toAge: number; share: number };

/** The modeling choices every scenario shares (the page shows and edits them in one place). */
export type ScenarioModel = {
  careBands: CareBand[];
  /** Childcare a year for one child in full-time care (today's dollars); null = from the ledger. */
  carePerChild: number | null;
  /** Fallback when the ledger shows no childcare and none is typed. */
  carePerChildDefault: number;
  /** Other costs of each added child a year (food, clothes, activities; today's dollars), until `otherUntilAge`. */
  otherPerChild: number;
  otherUntilAge: number;
  /** Rent and utilities a month; null = the ledger's housing & utilities. */
  rent: number | null;
};

export type ScenarioFile = {
  version: 1;
  model: ScenarioModel;
  scenarios: Scenario[];
  /** Scenario ids drawn side by side against today's plan (up to MAX_COMPARED). */
  compare: string[];
};

export const MAX_SCENARIOS = 12;
export const MAX_COMPARED = 4;

/**
 * Childcare by age (judgment calls, editable on the page): full-time care from birth to
 * five; school-age children need before/after-school and summer care, about a third of
 * full time, through twelve; none from thirteen.
 */
export const DEFAULT_CARE_BANDS: CareBand[] = [
  { fromAge: 0, toAge: 4, share: 1 },
  { fromAge: 5, toAge: 12, share: 0.3 },
];

export const DEFAULT_MODEL: ScenarioModel = {
  careBands: DEFAULT_CARE_BANDS,
  carePerChild: null,
  carePerChildDefault: 24_000_00,
  otherPerChild: 8_000_00,
  otherUntilAge: 18,
  rent: null,
};

export const emptyScenario = (id: string, name: string): Scenario => ({
  id,
  name,
  people: [],
  children: { added: [], ageOut: false },
  housing: { rentGrowth: null, buy: null },
  spending: { living: null, livingChange: null, growth: null, oneOffs: [] },
  assumptions: { returnRate: null, inflation: null },
  retire: { workYears: 0 },
});

export const personChange = (personId: string): PersonChange => ({ personId, raise: null, bonusLevel: 1, jobChange: null, partTime: null, stop: null });

export const EMPTY_FILE: ScenarioFile = { version: 1, model: DEFAULT_MODEL, scenarios: [], compare: [] };

// ---------------------------------------------------------------- reading untrusted JSON

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const cents = (v: unknown, d: number | null = null, lo = 0, hi = 1e12) => (num(v) && v >= lo && v <= hi ? Math.round(v) : d);
const ratio = (v: unknown, d: number | null, lo: number, hi: number) => (num(v) && v >= lo && v <= hi ? v : d);
const str = (v: unknown, d = "", max = 80) => (typeof v === "string" ? v.slice(0, max) : d);
const MONTH = /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/;
const month = (v: unknown): string | null => (typeof v === "string" && MONTH.test(v) ? v : null);
const list = <T,>(v: unknown, f: (x: unknown) => T | null, max = 24): T[] => (Array.isArray(v) ? v.slice(0, max).map(f).filter((x): x is T => x != null) : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function readPerson(v: unknown): PersonChange | null {
  const x = obj(v);
  if (!x || typeof x.personId !== "string") return null;
  const jc = obj(x.jobChange);
  const pt = obj(x.partTime);
  const st = obj(x.stop);
  return {
    personId: x.personId.slice(0, 80),
    raise: ratio(x.raise, null, -0.5, 1),
    bonusLevel: ratio(x.bonusLevel, 1, 0, 5)!,
    jobChange: jc && month(jc.from) ? { from: month(jc.from)!, salary: cents(jc.salary, 0)!, bonusPct: ratio(jc.bonusPct, null, 0, 10) } : null,
    partTime: pt && month(pt.from) ? { from: month(pt.from)!, share: ratio(pt.share, 0.6, 0, 1)! } : null,
    stop: st && month(st.from) ? { from: month(st.from)!, endsCare: st.endsCare !== false } : null,
  };
}

function readBuy(v: unknown): BuyHome | null {
  const x = obj(v);
  if (!x || !month(x.at)) return null;
  const d = DEFAULT_BUY;
  return {
    at: month(x.at)!,
    price: cents(x.price, d.price)!,
    downPct: ratio(x.downPct, d.downPct, 0, 1)!,
    rate: ratio(x.rate, d.rate, 0, 0.3)!,
    termYears: Math.round(ratio(x.termYears, d.termYears, 1, 50)!),
    taxRate: ratio(x.taxRate, d.taxRate, 0, 0.1)!,
    upkeepRate: ratio(x.upkeepRate, d.upkeepRate, 0, 0.1)!,
    insurance: cents(x.insurance, d.insurance)!,
    hoa: cents(x.hoa, d.hoa)!,
    utilities: cents(x.utilities, d.utilities)!,
    closingPct: ratio(x.closingPct, d.closingPct, 0, 0.2)!,
    appreciation: ratio(x.appreciation, null, -0.2, 0.3),
  };
}

/** A purchase's starting figures when the Home budget page has none saved. */
export const DEFAULT_BUY: Omit<BuyHome, "at"> = {
  price: 750_000_00,
  downPct: 0.2,
  rate: 0.065,
  termYears: 30,
  taxRate: 0.018,
  upkeepRate: 0.01,
  insurance: 2_400_00,
  hoa: 0,
  utilities: 400_00,
  closingPct: 0.03,
  appreciation: null,
};

export function normalizeScenario(v: unknown): Scenario | null {
  const x = obj(v);
  if (!x || typeof x.id !== "string" || !x.id) return null;
  const ch = obj(x.children) ?? {};
  const h = obj(x.housing) ?? {};
  const sp = obj(x.spending) ?? {};
  const as = obj(x.assumptions) ?? {};
  return {
    id: x.id.slice(0, 40),
    name: str(x.name, "Scenario", 60) || "Scenario",
    people: list(x.people, readPerson, 8),
    children: {
      added: list(ch.added, (c) => {
        const y = obj(c);
        return y && typeof y.id === "string" && month(y.born) ? { id: y.id.slice(0, 40), label: str(y.label, "Child"), born: month(y.born)! } : null;
      }, 8),
      ageOut: ch.ageOut === true,
    },
    housing: { rentGrowth: ratio(h.rentGrowth, null, -0.2, 0.3), buy: readBuy(h.buy) },
    spending: {
      living: cents(sp.living),
      livingChange: cents(sp.livingChange, null, -1e12, 1e12),
      growth: ratio(sp.growth, null, -0.2, 0.3),
      oneOffs: list(sp.oneOffs, (o) => {
        const y = obj(o);
        return y && typeof y.id === "string" && month(y.at) && num(y.amount) ? { id: y.id.slice(0, 40), label: str(y.label), amount: Math.round(y.amount), at: month(y.at)! } : null;
      }),
    },
    assumptions: { returnRate: ratio(as.returnRate, null, -0.5, 1), inflation: ratio(as.inflation, null, -0.05, 0.2) },
    retire: { workYears: Math.round(ratio(obj(x.retire)?.workYears, 0, -20, 20)!) },
  };
}

export function normalizeModel(v: unknown): ScenarioModel {
  const x = obj(v) ?? {};
  const d = DEFAULT_MODEL;
  const bands = list(x.careBands, (b) => {
    const y = obj(b);
    if (!y || !num(y.fromAge) || !num(y.toAge)) return null;
    const fromAge = Math.max(0, Math.min(25, Math.round(y.fromAge)));
    const toAge = Math.max(fromAge, Math.min(25, Math.round(y.toAge)));
    return { fromAge, toAge, share: ratio(y.share, 0, 0, 2)! };
  }, 6);
  return {
    careBands: Array.isArray(x.careBands) ? bands : d.careBands,
    carePerChild: cents(x.carePerChild),
    carePerChildDefault: cents(x.carePerChildDefault, d.carePerChildDefault)!,
    otherPerChild: cents(x.otherPerChild, d.otherPerChild)!,
    otherUntilAge: Math.round(ratio(x.otherUntilAge, d.otherUntilAge, 0, 30)!),
    rent: cents(x.rent),
  };
}

/** Coerces untrusted JSON (the file, the API) into a well-formed scenario file. */
export function normalizeScenarioFile(v: unknown): ScenarioFile {
  const x = obj(v) ?? {};
  const seen = new Set<string>();
  const scenarios = list(x.scenarios, normalizeScenario, MAX_SCENARIOS).filter((s) => !seen.has(s.id) && seen.add(s.id));
  const ids = new Set(scenarios.map((s) => s.id));
  const compare = [...new Set(list(x.compare, (c) => (typeof c === "string" && ids.has(c) ? c : null)))].slice(0, MAX_COMPARED);
  return { version: 1, model: normalizeModel(x.model), scenarios, compare };
}
