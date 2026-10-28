/**
 * Well-known cards and what they offer: the annual fee, the recurring credits (monthly,
 * quarterly, semiannual, annual) and how fast spending earns points. A starting point
 * only: issuers change these every year or two, so choosing a card copies its entry
 * into the owner's setup (lib/cardPerks/settings.ts), where every figure can be edited.
 *
 * Perk patterns are matched (case-insensitive) against the statement credit's
 * description; an empty pattern means the perk never shows on a statement (in-app
 * credits like Uber Cash) and is marked used by hand. Earn rules match a row's ledger
 * category or its description; the first rule that matches sets the rate.
 */

export type Cadence = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
export const CADENCES: Cadence[] = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"];
export const CADENCE_INFO: Record<Cadence, { label: string; perYear: number; months: number }> = {
  MONTHLY: { label: "Monthly", perYear: 12, months: 1 },
  QUARTERLY: { label: "Quarterly", perYear: 4, months: 3 },
  SEMIANNUAL: { label: "Twice a year", perYear: 2, months: 6 },
  ANNUAL: { label: "Yearly", perYear: 1, months: 12 },
};

/** USD: `amount` is cents per period. POINTS: `amount` is points per period. */
export type PerkUnit = "USD" | "POINTS";

export type PerkTemplate = { id: string; name: string; cadence: Cadence; unit: PerkUnit; amount: number; pattern: string; note?: string };
export type EarnRuleTemplate = { id: string; label: string; categories: string[]; pattern: string; rate: number };

export type CardProduct = {
  id: string;
  name: string;
  issuer: string;
  annualFeeCents: number;
  /** Points per dollar on anything no rule matches. */
  baseRate: number;
  earnRules: EarnRuleTemplate[];
  perks: PerkTemplate[];
  /** Matched against the account's name and institution to suggest this card. */
  guess: RegExp;
  /** When the figures were last checked against the issuer. */
  asOf: string;
};

const AIRLINES = "AIRLINE|AIR LINES|AIRWAYS|DELTA AIR|UNITED AIR|AMERICAN AIR|JETBLUE|SOUTHWEST|ALASKA AIR|SPIRIT AIR|FRONTIER AIR|AIR CANADA|BRITISH A";
const HOTELS = "HOTEL|MARRIOTT|HILTON|HYATT|IHG|WESTIN|SHERATON|RITZ|FOUR SEASONS|RESORT";
const STREAMING = "NETFLIX|SPOTIFY|HULU|DISNEY|HBO|MAX\\.COM|YOUTUBE|PEACOCK|PARAMOUNT|APPLE\\.COM/BILL";

export const CARD_PRODUCTS: CardProduct[] = [
  {
    id: "amex-gold",
    name: "American Express Gold Card",
    issuer: "American Express",
    annualFeeCents: 32_500,
    baseRate: 1,
    earnRules: [
      { id: "flights", label: "Flights booked with airlines", categories: [], pattern: AIRLINES, rate: 3 },
      { id: "dining", label: "Restaurants", categories: ["Dining"], pattern: "", rate: 4 },
      { id: "groceries", label: "U.S. supermarkets", categories: ["Groceries"], pattern: "", rate: 4 },
    ],
    perks: [
      { id: "uber", name: "Uber Cash", cadence: "MONTHLY", unit: "USD", amount: 1_000, pattern: "", note: "Loaded into the Uber app, not the statement: mark it used by hand." },
      { id: "dining", name: "Dining credit", cadence: "MONTHLY", unit: "USD", amount: 1_000, pattern: "DINING CREDIT|GRUBHUB|CHEESECAKE|GOLDBELLY|WINE\\.COM|FIVE GUYS" },
      { id: "resy", name: "Resy credit", cadence: "SEMIANNUAL", unit: "USD", amount: 5_000, pattern: "RESY" },
      { id: "dunkin", name: "Dunkin' credit", cadence: "MONTHLY", unit: "USD", amount: 700, pattern: "DUNKIN" },
    ],
    guess: /(AMERICAN EXPRESS|AMEX).*\bGOLD\b/i,
    asOf: "2026-06",
  },
  {
    id: "amex-platinum",
    name: "The Platinum Card from American Express",
    issuer: "American Express",
    annualFeeCents: 89_500,
    baseRate: 1,
    earnRules: [{ id: "flights", label: "Flights booked with airlines", categories: [], pattern: AIRLINES, rate: 5 }],
    perks: [
      { id: "hotel", name: "Hotel credit (FHR / Hotel Collection)", cadence: "SEMIANNUAL", unit: "USD", amount: 30_000, pattern: "HOTEL|FHR|FINE HOTELS" },
      { id: "resy", name: "Resy credit", cadence: "QUARTERLY", unit: "USD", amount: 10_000, pattern: "RESY" },
      { id: "lululemon", name: "lululemon credit", cadence: "QUARTERLY", unit: "USD", amount: 7_500, pattern: "LULULEMON" },
      { id: "entertainment", name: "Digital entertainment credit", cadence: "MONTHLY", unit: "USD", amount: 2_500, pattern: "ENTERTAINMENT|DIGITAL" },
      { id: "uber", name: "Uber Cash", cadence: "MONTHLY", unit: "USD", amount: 1_500, pattern: "UBER CASH", note: "Usually loaded into the Uber app rather than the statement: mark it used by hand if so." },
      { id: "uber-dec", name: "Uber Cash (December bonus)", cadence: "ANNUAL", unit: "USD", amount: 2_000, pattern: "UBER CASH" },
      { id: "uber-one", name: "Uber One credit", cadence: "MONTHLY", unit: "USD", amount: 1_000, pattern: "UBER ONE" },
      { id: "airline", name: "Airline fee credit", cadence: "ANNUAL", unit: "USD", amount: 20_000, pattern: "AIRLINE" },
      { id: "clear", name: "CLEAR+ credit", cadence: "ANNUAL", unit: "USD", amount: 20_900, pattern: "\\bCLEAR\\b" },
      { id: "walmart", name: "Walmart+ credit", cadence: "MONTHLY", unit: "USD", amount: 1_295, pattern: "WALMART" },
      { id: "oura", name: "Oura Ring credit", cadence: "ANNUAL", unit: "USD", amount: 20_000, pattern: "OURA" },
    ],
    guess: /(AMERICAN EXPRESS|AMEX).*\bPLATINUM\b/i,
    asOf: "2026-06",
  },
  {
    id: "chase-sapphire-reserve",
    name: "Chase Sapphire Reserve",
    issuer: "Chase",
    annualFeeCents: 79_500,
    baseRate: 1,
    earnRules: [
      { id: "flights", label: "Flights booked with airlines", categories: [], pattern: AIRLINES, rate: 4 },
      { id: "hotels", label: "Hotels booked direct", categories: [], pattern: HOTELS, rate: 4 },
      { id: "dining", label: "Dining", categories: ["Dining"], pattern: "", rate: 3 },
    ],
    perks: [
      { id: "travel", name: "Annual travel credit", cadence: "ANNUAL", unit: "USD", amount: 30_000, pattern: "TRAVEL CREDIT" },
      { id: "edit", name: "The Edit hotel credit", cadence: "SEMIANNUAL", unit: "USD", amount: 25_000, pattern: "\\bTHE EDIT\\b|EDIT CREDIT" },
      { id: "dining", name: "Exclusive Tables dining credit", cadence: "SEMIANNUAL", unit: "USD", amount: 15_000, pattern: "EXCLUSIVE TABLES|DINING CREDIT" },
      { id: "stubhub", name: "StubHub credit", cadence: "SEMIANNUAL", unit: "USD", amount: 15_000, pattern: "STUBHUB|VIAGOGO" },
      { id: "apple", name: "Apple TV+ and Apple Music", cadence: "ANNUAL", unit: "USD", amount: 25_000, pattern: "APPLE" },
      { id: "peloton", name: "Peloton credit", cadence: "MONTHLY", unit: "USD", amount: 1_000, pattern: "PELOTON" },
      { id: "doordash", name: "DoorDash promos", cadence: "MONTHLY", unit: "USD", amount: 2_500, pattern: "", note: "Applied in the DoorDash app: mark it used by hand." },
      { id: "lyft", name: "Lyft credit", cadence: "MONTHLY", unit: "USD", amount: 1_000, pattern: "", note: "Applied in the Lyft app: mark it used by hand." },
    ],
    guess: /SAPPHIRE RESERVE|\bCSR\b/i,
    asOf: "2026-06",
  },
  {
    id: "chase-sapphire-preferred",
    name: "Chase Sapphire Preferred",
    issuer: "Chase",
    annualFeeCents: 9_500,
    baseRate: 1,
    earnRules: [
      { id: "dining", label: "Dining", categories: ["Dining"], pattern: "", rate: 3 },
      { id: "streaming", label: "Select streaming", categories: [], pattern: STREAMING, rate: 3 },
      { id: "travel", label: "Other travel", categories: [], pattern: `${AIRLINES}|${HOTELS}|AIRBNB|EXPEDIA|HERTZ|AVIS|AMTRAK`, rate: 2 },
    ],
    perks: [
      { id: "hotel", name: "Chase Travel hotel credit", cadence: "ANNUAL", unit: "USD", amount: 5_000, pattern: "HOTEL CREDIT|TRAVEL CREDIT" },
      { id: "doordash", name: "DoorDash promo", cadence: "MONTHLY", unit: "USD", amount: 1_000, pattern: "", note: "Applied in the DoorDash app: mark it used by hand." },
    ],
    guess: /SAPPHIRE PREFERRED|\bCSP\b/i,
    asOf: "2026-06",
  },
  {
    id: "capital-one-venture-x",
    name: "Capital One Venture X",
    issuer: "Capital One",
    annualFeeCents: 39_500,
    baseRate: 2,
    earnRules: [],
    perks: [
      { id: "travel", name: "Capital One Travel credit", cadence: "ANNUAL", unit: "USD", amount: 30_000, pattern: "TRAVEL CREDIT|CAPITAL ONE TRAVEL" },
      { id: "anniversary", name: "Anniversary bonus miles", cadence: "ANNUAL", unit: "POINTS", amount: 10_000, pattern: "", note: "Posted to your miles balance each account anniversary: mark it received by hand." },
    ],
    guess: /VENTURE X/i,
    asOf: "2026-06",
  },
  {
    id: "bilt",
    name: "Bilt Mastercard",
    issuer: "Bilt",
    annualFeeCents: 0,
    baseRate: 1,
    earnRules: [
      { id: "dining", label: "Dining", categories: ["Dining"], pattern: "", rate: 3 },
      { id: "travel", label: "Travel", categories: [], pattern: `${AIRLINES}|${HOTELS}|AIRBNB|EXPEDIA|HERTZ|AVIS|AMTRAK`, rate: 2 },
    ],
    perks: [],
    guess: /\bBILT\b/i,
    asOf: "2026-06",
  },
];

/** The product an account most likely is, from its name and institution; null when nothing fits. */
export function guessProduct(account: { name: string; institution: string | null }): CardProduct | null {
  const text = `${account.institution ?? ""} ${account.name}`;
  return CARD_PRODUCTS.find((p) => p.guess.test(text)) ?? null;
}

export const productById = (id: string | null | undefined): CardProduct | null => CARD_PRODUCTS.find((p) => p.id === id) ?? null;
