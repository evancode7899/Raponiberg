import { asObject, asString, isNum } from "../settingsStore.ts";
import { CADENCES, productById, type Cadence, type CardProduct, type EarnRuleTemplate, type PerkTemplate, type PerkUnit } from "./catalog.ts";

/**
 * The owner's card perks setup: which product each credit card account is, its fee, earn
 * rates and perks (copied from the catalog when chosen, then theirs to edit), what each
 * point is worth, and the perk uses marked by hand (credits that never reach a
 * statement, like Uber Cash). Stored as one AppSetting, so it's in the database and its
 * backups, never in the code. The figures are built by lib/cardPerks/report.ts.
 */

export type Perk = PerkTemplate & { note: string };
export type EarnRule = EarnRuleTemplate;

export type CardSetup = {
  /** Catalog product it started from, or null for a card set up by hand. */
  productId: string | null;
  /** The name shown on the page (the product's name unless changed). */
  name: string;
  annualFeeCents: number;
  baseRate: number;
  earnRules: EarnRule[];
  perks: Perk[];
  /** Cents a point is worth for this card; null uses the page-wide value. */
  centsPerPoint: number | null;
  /** Left off the page. */
  hidden: boolean;
};

export type CardPerksSettings = {
  version: 1;
  /** What a point is worth, in cents (1 = a cent a point). */
  centsPerPoint: number;
  /** By account id. A card with no entry uses the catalog product its name suggests. */
  cards: Record<string, CardSetup>;
  /**
   * Uses marked by hand, by usageKey(accountId, perkId, period): cents for a USD perk,
   * points for a POINTS perk. Replaces whatever the statements show for that period.
   */
  usage: Record<string, number>;
  /** Points actually earned, by pointsKey(accountId, year), replacing the estimate from spending. */
  pointsEarned: Record<string, number>;
};

export const CARD_PERKS_KEY = "card-perks.v1";
export const DEFAULT_CENTS_PER_POINT = 1;

export const usageKey = (accountId: string, perkId: string, period: string) => `${accountId}|${perkId}|${period}`;
export const pointsKey = (accountId: string, year: number) => `${accountId}|${year}`;

export function defaultCardPerks(): CardPerksSettings {
  return { version: 1, centsPerPoint: DEFAULT_CENTS_PER_POINT, cards: {}, usage: {}, pointsEarned: {} };
}

/** A card's setup copied from a catalog product (or blank when there is none). */
export function setupFromProduct(product: CardProduct | null, fallbackName = "Credit card"): CardSetup {
  return {
    productId: product?.id ?? null,
    name: product?.name ?? fallbackName,
    annualFeeCents: product?.annualFeeCents ?? 0,
    baseRate: product?.baseRate ?? 1,
    earnRules: (product?.earnRules ?? []).map((r) => ({ ...r, categories: [...r.categories] })),
    perks: (product?.perks ?? []).map((p) => ({ ...p, note: p.note ?? "" })),
    centsPerPoint: null,
    hidden: false,
  };
}

const MAX_CARDS = 40;
const MAX_ITEMS = 40;
const isCadence = (v: unknown): v is Cadence => typeof v === "string" && (CADENCES as string[]).includes(v);
const isUnit = (v: unknown): v is PerkUnit => v === "USD" || v === "POINTS";
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const nonNeg = (v: unknown, max: number): number | null => (isNum(v) && v >= 0 && v <= max ? v : null);
/** Ids are unique within their list; a missing or repeated one gets the next free "<prefix>-n". */
function uniqueIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return items.map((x, i) => {
    let id = x.id;
    for (let n = i + 1; !id || seen.has(id); n++) id = `${prefix}-${n}`;
    seen.add(id);
    return id === x.id ? x : { ...x, id };
  });
}

/** A setup from whatever is stored or posted; anything malformed falls back to the product it names. */
export function normalizeCard(raw: unknown): CardSetup {
  const r = asObject(raw);
  const product = productById(asString(r.productId, 60));
  const base = setupFromProduct(product);
  const perks = uniqueIds(
    list(r.perks, MAX_ITEMS).flatMap((x): Perk[] => {
      const o = asObject(x);
      const name = asString(o.name, 80).trim();
      const amount = nonNeg(o.amount, 100_000_000);
      if (!name || !isCadence(o.cadence) || amount == null) return [];
      return [{ id: asString(o.id, 40), name, cadence: o.cadence, unit: isUnit(o.unit) ? o.unit : "USD", amount: Math.round(amount), pattern: asString(o.pattern, 200).trim(), note: asString(o.note, 300) }];
    }),
    "perk",
  );
  const earnRules = uniqueIds(
    list(r.earnRules, MAX_ITEMS).flatMap((x): EarnRule[] => {
      const o = asObject(x);
      const rate = nonNeg(o.rate, 100);
      const categories = list(o.categories, 20).filter((c): c is string => typeof c === "string" && c.length > 0).map((c) => c.slice(0, 60));
      const pattern = asString(o.pattern, 300).trim();
      if (rate == null || (!categories.length && !pattern)) return [];
      return [{ id: asString(o.id, 40), label: asString(o.label, 80).trim() || "Bonus category", categories, pattern, rate }];
    }),
    "rule",
  );
  return {
    productId: product?.id ?? null,
    name: asString(r.name, 80).trim() || base.name,
    annualFeeCents: Math.round(nonNeg(r.annualFeeCents, 10_000_000) ?? base.annualFeeCents),
    baseRate: nonNeg(r.baseRate, 100) ?? base.baseRate,
    earnRules: Array.isArray(r.earnRules) ? earnRules : base.earnRules,
    perks: Array.isArray(r.perks) ? perks : base.perks,
    centsPerPoint: nonNeg(r.centsPerPoint, 100),
    hidden: r.hidden === true,
  };
}

const USAGE_KEY = /^[^|]{1,60}\|[^|]{1,40}\|\d{4}(-(0[1-9]|1[0-2])|-Q[1-4]|-H[12])?$/;
const POINTS_KEY = /^[^|]{1,60}\|\d{4}$/;

export function normalizeCardPerks(raw: unknown): CardPerksSettings {
  const r = asObject(raw);
  const cards: Record<string, CardSetup> = {};
  for (const [id, c] of Object.entries(asObject(r.cards)).slice(0, MAX_CARDS)) cards[id.slice(0, 60)] = normalizeCard(c);
  const numbers = (v: unknown, key: RegExp, max: number) => {
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(asObject(v)).slice(0, 20_000)) if (key.test(k) && isNum(n) && n >= 0 && n <= max) out[k] = Math.round(n);
    return out;
  };
  return {
    version: 1,
    centsPerPoint: nonNeg(r.centsPerPoint, 100) ?? DEFAULT_CENTS_PER_POINT,
    cards,
    usage: numbers(r.usage, USAGE_KEY, 100_000_000),
    pointsEarned: numbers(r.pointsEarned, POINTS_KEY, 1_000_000_000),
  };
}
