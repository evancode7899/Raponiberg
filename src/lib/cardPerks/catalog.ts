/**
 * Credit card products and what they offer: the annual fee, the rewards program and how
 * fast spending earns in it, and the recurring credits. Public card terms only, as of
 * `CATALOG_AS_OF`; nothing here is about a household. A credit card account is matched
 * to a product by its name and institution (guessProduct), or the owner picks one on the
 * page's Setup tab.
 *
 * Perks and earn rules carry the months they applied (`from`/`to`, YYYY-MM, inclusive),
 * so a past year is scored by the terms of that year. Every perk says how its use shows
 * up, which is how the page tells, with no input, whether it was used:
 * - `credit`: the statement credit's description (AMEX DINING CREDIT, …).
 * - `merchants`: the merchants the perk pays for. A credit from one of them on the card is
 *   the perk (Amex sometimes names the merchant, not the perk), and a credit is counted
 *   in the period of the charge it pays back.
 * - `inApp`: the perk never reaches a statement (Uber Cash). A household charge at one of
 *   its merchants in the period means it was used: each charge vouches for one card's
 *   perk, so two charges cover two cards.
 */

export const CATALOG_AS_OF = "2026-10";

export type Cadence = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
export const CADENCES: Cadence[] = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"];
export const CADENCE_INFO: Record<Cadence, { label: string; perYear: number; months: number }> = {
  MONTHLY: { label: "Monthly", perYear: 12, months: 1 },
  QUARTERLY: { label: "Quarterly", perYear: 4, months: 3 },
  SEMIANNUAL: { label: "Twice a year", perYear: 2, months: 6 },
  ANNUAL: { label: "Yearly", perYear: 1, months: 12 },
};

/** POINTS: points or miles, worth what the owner says a point is worth. CASH: cash back, worth its face. NONE: no rewards. */
export type RewardKind = "POINTS" | "CASH" | "NONE";

export type ProgramId = "amex-mr" | "amex-cash" | "chase-ur" | "capital-one-cash" | "capital-one-miles" | "bilt" | "citi-cash" | "none";

export type Program = {
  id: ProgramId;
  name: string;
  kind: RewardKind;
  /** Cents a point is worth unless the owner says otherwise (cash: 1 reward cent = 1 cent). */
  defaultCentsPerPoint: number;
  /** One balance shared by every card in the program (an Amex Membership Rewards account). */
  pooled: boolean;
  /** The issuer prints the balance on statements (lib/cardPerks/rewardsText.ts). */
  onStatements: boolean;
  /** How the statement balance is dated, for the page's explanation. */
  statementNote: string;
};

export const PROGRAMS: Record<ProgramId, Program> = {
  "amex-mr": {
    id: "amex-mr",
    name: "Membership Rewards",
    kind: "POINTS",
    defaultCentsPerPoint: 1,
    pooled: true,
    onStatements: true,
    statementNote: "Each statement prints the Membership Rewards balance as of the last month end, shared by every card on the account.",
  },
  "amex-cash": { id: "amex-cash", name: "Reward Dollars", kind: "CASH", defaultCentsPerPoint: 1, pooled: false, onStatements: true, statementNote: "Each statement prints the Reward Dollars balance." },
  "chase-ur": {
    id: "chase-ur",
    name: "Ultimate Rewards",
    kind: "POINTS",
    defaultCentsPerPoint: 1,
    pooled: false,
    onStatements: true,
    statementNote: "Each statement prints the points earned that cycle, category by category, and the balance.",
  },
  "capital-one-cash": {
    id: "capital-one-cash",
    name: "Capital One cash back",
    kind: "CASH",
    defaultCentsPerPoint: 1,
    pooled: false,
    onStatements: true,
    statementNote: "Each statement prints the rewards balance with what was earned and redeemed that cycle.",
  },
  "capital-one-miles": {
    id: "capital-one-miles",
    name: "Capital One miles",
    kind: "POINTS",
    defaultCentsPerPoint: 1,
    pooled: false,
    onStatements: true,
    statementNote: "Each statement prints the miles balance with what was earned and redeemed that cycle.",
  },
  bilt: { id: "bilt", name: "Bilt Points", kind: "POINTS", defaultCentsPerPoint: 1, pooled: true, onStatements: false, statementNote: "Bilt statements don't print points: they're estimated from spending." },
  "citi-cash": { id: "citi-cash", name: "Citi cash back", kind: "CASH", defaultCentsPerPoint: 1, pooled: false, onStatements: false, statementNote: "Estimated from spending." },
  none: { id: "none", name: "No rewards", kind: "NONE", defaultCentsPerPoint: 0, pooled: false, onStatements: false, statementNote: "This card earns no rewards." },
};

export type Window = { from?: string; to?: string };

/**
 * One rate. A purchase earns the first rule it matches (by its ledger category, or its
 * description and the statement's second line against `pattern`; both when `requireBoth`).
 * `capCents` is the yearly spending that earns the rate; past it, the base rate.
 * `portal` rules (bookings through the issuer's travel site) can't be told from a
 * statement line: they're listed so the page can say so, and the statement's own
 * figures (where printed) catch them.
 */
export type EarnRule = Window & { id: string; label: string; rate: number; categories?: string[]; pattern?: string; requireBoth?: boolean; capCents?: number; portal?: boolean };

export type Perk = Window & {
  id: string;
  name: string;
  cadence: Cadence;
  amountCents: number;
  /** Paid on top in one month of the year (Uber Cash's December bonus). */
  bonus?: { month: number; cents: number };
  credit?: string;
  merchants?: string;
  /** Charges at `merchants` that don't count (a membership the perk can't pay for). */
  notMerchants?: string;
  inApp?: boolean;
  /** How to use it, shown beside it. */
  how: string;
};

export type CardProduct = {
  id: string;
  name: string;
  issuer: string;
  /** The fee today; the statements' own fee rows decide what a year cost. */
  annualFeeCents: number;
  program: ProgramId;
  baseRate: number;
  earn: EarnRule[];
  perks: Perk[];
  /** Credits on the statement that are neither perks nor refunds (Bilt's rent charge reversal). */
  ignoreCredits?: string;
  /** Matched against the institution and account name. */
  guess: RegExp;
  note?: string;
};

// ---- Merchant patterns (matched case-insensitively against a row's description and detail line) ----
export const AIRLINES =
  "AIRLINE|AIR LINES|AIRWAYS|DELTA AIR|UNITED AIR|AMERICAN AIR|JETBLUE|SOUTHWEST|ALASKA AIR|SPIRIT AIR|FRONTIER AIR|AIR CANADA|BRITISH A|PORTER ?AIR|WESTJET|LUFTHANSA|AIR FRANCE|KLM|ICELANDAIR|AER LINGUS|VIRGIN ATL|EMIRATES|QATAR AIR";
export const HOTELS = "HOTEL|MARRIOTT|HILTON|HYATT|IHG|WESTIN|SHERATON|RITZ|FOUR SEASONS|RESORT|\\bINN\\b|COURTYARD|HAMPTON|HOLIDAY INN|KIMPTON|W HOTEL";
const TRAVEL = `${AIRLINES}|${HOTELS}|AIRBNB|VRBO|EXPEDIA|BOOKING\\.COM|HOTELS\\.COM|PRICELINE|HERTZ|AVIS|ENTERPRISE RENT|NATIONAL CAR|BUDGET RENT|AMTRAK|VIA RAIL|CRUISE|TRAVEL`;
const TRANSIT = "\\bMTA\\b|\\bMNR\\b|METRO-?NORTH|LIRR|NJ ?TRANSIT|\\bPATH\\b|AMTRAK|UBER|LYFT|TAXI|\\bCAB\\b|PARKING|PARKMOBILE|TOLL|E-?Z ?PASS|LOCAL ?TRANSPORTATION";
const STREAMING = "NETFLIX|SPOTIFY|HULU|DISNEY|HBO|MAX\\.COM|YOUTUBE|PEACOCK|PARAMOUNT|APPLE\\.COM/BILL|SIRIUS|AUDIBLE|TIDAL|STARZ";
const GAS = "SHELL\\b|EXXON|MOBIL\\b|CHEVRON|\\bBP\\b|SUNOCO|CITGO|GULF OIL|SPEEDWAY|WAWA|VALERO|MARATHON PETRO|PHILLIPS 66|\\bFUEL\\b|GAS STATION|SERVICE STATION|\\bGAS\\b";
const DRUGSTORES = "CVS|WALGREENS|DUANE READE|RITE AID|PHARMAC|DRUG ?STORE";
/** U.S. online retail: a shopping purchase made online. */
const ONLINE = "AMAZON|AMZN|\\bAMZ|ETSY|EBAY|WAYFAIR|\\.COM\\b|WWW\\.|ONLINE|INTERNET|SHOPIFY|\\bSP \\b";
const UBER = "\\bUBER\\b";
/** A membership (Uber One) is paid with the card, never with Uber Cash. */
const UBER_MEMBERSHIP = "UBER ONE|UBER PASS";

export const CARD_PRODUCTS: CardProduct[] = [
  {
    id: "amex-gold",
    name: "American Express Gold Card",
    issuer: "American Express",
    annualFeeCents: 32_500,
    program: "amex-mr",
    baseRate: 1,
    earn: [
      { id: "dining", label: "Restaurants", rate: 4, categories: ["Dining"], capCents: 5_000_000 },
      { id: "groceries", label: "U.S. supermarkets", rate: 4, categories: ["Groceries"], capCents: 2_500_000 },
      { id: "flights", label: "Flights booked with airlines", rate: 3, pattern: AIRLINES },
      { id: "hotels", label: "Prepaid hotels on amextravel.com", rate: 2, portal: true, from: "2024-07" },
    ],
    perks: [
      { id: "uber", name: "Uber Cash", cadence: "MONTHLY", amountCents: 1_000, merchants: UBER, notMerchants: UBER_MEMBERSHIP, inApp: true, how: "Loaded into the Uber app each month with the card in the Uber wallet." },
      {
        id: "dining",
        name: "Dining credit",
        cadence: "MONTHLY",
        amountCents: 1_000,
        credit: "DINING CREDIT",
        merchants: "GRUBHUB|SEAMLESS|CHEESECAKE|GOLDBELLY|WINE\\.COM|FIVE GUYS|MILK BAR",
        how: "Grubhub, The Cheesecake Factory, Goldbelly, Wine.com or Five Guys, paid with the card.",
      },
      { id: "resy", name: "Resy credit", cadence: "SEMIANNUAL", amountCents: 5_000, credit: "RESY", from: "2024-07", how: "Dining at a U.S. Resy restaurant, paid with the card." },
      { id: "dunkin", name: "Dunkin' credit", cadence: "MONTHLY", amountCents: 700, credit: "DUNKIN", merchants: "DUNKIN", from: "2024-07", how: "Any U.S. Dunkin' purchase with the card." },
    ],
    guess: /(AMERICAN EXPRESS|AMEX).*\bGOLD\b/i,
  },
  {
    id: "amex-platinum",
    name: "The Platinum Card from American Express",
    issuer: "American Express",
    annualFeeCents: 89_500,
    program: "amex-mr",
    baseRate: 1,
    earn: [
      { id: "flights", label: "Flights booked with airlines", rate: 5, pattern: AIRLINES, capCents: 50_000_000 },
      { id: "hotels", label: "Prepaid hotels on amextravel.com", rate: 5, portal: true },
    ],
    perks: [
      { id: "uber", name: "Uber Cash", cadence: "MONTHLY", amountCents: 1_500, bonus: { month: 12, cents: 2_000 }, merchants: UBER, notMerchants: UBER_MEMBERSHIP, inApp: true, how: "Loaded into the Uber app each month ($35 in December) with the card in the Uber wallet." },
      {
        id: "entertainment",
        name: "Digital entertainment credit",
        cadence: "MONTHLY",
        amountCents: 2_000,
        credit: "ENTERTAINMENT CREDIT",
        merchants: "HULU|DISNEY|ESPN|PEACOCK|NYTIMES|NEW YORK TIMES|\\bWSJ\\b|WALL STREET JOURNAL|AUDIBLE|SIRIUS ?XM",
        to: "2025-09",
        how: "Disney+, Hulu, ESPN+, Peacock, The New York Times, The Wall Street Journal or SiriusXM, paid with the card.",
      },
      {
        id: "entertainment-25",
        name: "Digital entertainment credit",
        cadence: "MONTHLY",
        amountCents: 2_500,
        credit: "ENTERTAINMENT CREDIT",
        merchants: "HULU|DISNEY|ESPN|PEACOCK|NYTIMES|NEW YORK TIMES|\\bWSJ\\b|WALL STREET JOURNAL|YOUTUBE|PARAMOUNT",
        from: "2025-10",
        how: "Disney+, Hulu, ESPN+, Peacock, Paramount+, YouTube Premium or TV, The New York Times or The Wall Street Journal, paid with the card.",
      },
      { id: "airline", name: "Airline fee credit", cadence: "ANNUAL", amountCents: 20_000, credit: "AIRLINE FEE|AIRLINE CREDIT|AIRLINE INCIDENTAL", how: "Incidental fees (bags, seats) on the one airline you select." },
      { id: "hotel", name: "Hotel credit (Fine Hotels + Resorts)", cadence: "ANNUAL", amountCents: 20_000, credit: "HOTEL CREDIT|FINE HOTELS|\\bFHR\\b|HOTEL COLLECTION", to: "2025-09", how: "A prepaid Fine Hotels + Resorts or Hotel Collection stay on amextravel.com." },
      { id: "hotel-300", name: "Hotel credit (Fine Hotels + Resorts)", cadence: "SEMIANNUAL", amountCents: 30_000, credit: "HOTEL CREDIT|FINE HOTELS|\\bFHR\\b|HOTEL COLLECTION", from: "2025-10", how: "A prepaid Fine Hotels + Resorts or Hotel Collection stay on amextravel.com." },
      { id: "saks", name: "Saks credit", cadence: "SEMIANNUAL", amountCents: 5_000, credit: "SAKS", merchants: "SAKS", to: "2025-09", how: "Saks Fifth Avenue, in store or online." },
      { id: "walmart", name: "Walmart+ credit", cadence: "MONTHLY", amountCents: 1_295, credit: "WALMART\\+? ?(PLUS )?CREDIT", merchants: "WALMART\\+|WALMART PLUS|WMT PLUS", from: "2022-01", how: "A monthly Walmart+ membership paid with the card." },
      { id: "equinox", name: "Equinox credit", cadence: "MONTHLY", amountCents: 2_500, credit: "EQUINOX", merchants: "EQUINOX", from: "2022-01", to: "2025-09", how: "Equinox club or Equinox+ membership." },
      { id: "clear", name: "CLEAR Plus credit", cadence: "ANNUAL", amountCents: 18_900, credit: "\\bCLEAR\\b", merchants: "\\bCLEAR\\b", to: "2025-09", how: "A CLEAR Plus membership paid with the card." },
      { id: "clear-209", name: "CLEAR Plus credit", cadence: "ANNUAL", amountCents: 20_900, credit: "\\bCLEAR\\b", merchants: "\\bCLEAR\\b", from: "2025-10", how: "A CLEAR Plus membership paid with the card." },
      { id: "uber-one", name: "Uber One credit", cadence: "MONTHLY", amountCents: 1_000, credit: "UBER ONE CREDIT", merchants: "UBER ONE", from: "2025-10", how: "An auto-renewing Uber One membership paid with the card." },
      { id: "resy", name: "Resy credit", cadence: "QUARTERLY", amountCents: 10_000, credit: "RESY", from: "2025-10", how: "Dining at a U.S. Resy restaurant, paid with the card." },
      { id: "lululemon", name: "lululemon credit", cadence: "QUARTERLY", amountCents: 7_500, credit: "LULULEMON", merchants: "LULULEMON", from: "2025-10", how: "lululemon in U.S. stores or online (not outlets)." },
      { id: "oura", name: "Oura Ring credit", cadence: "ANNUAL", amountCents: 20_000, credit: "OURA", merchants: "OURA", from: "2025-10", how: "An Oura Ring bought on ouraring.com." },
    ],
    guess: /(AMERICAN EXPRESS|AMEX).*\bPLATINUM\b|THE PLATINUM CARD/i,
    note: "Fee rose to $895 with the 2025 refresh (at renewal for existing members); refreshed credits are counted from Q4 2025.",
  },
  {
    id: "amex-green",
    name: "American Express Green Card",
    issuer: "American Express",
    annualFeeCents: 15_000,
    program: "amex-mr",
    baseRate: 1,
    earn: [
      { id: "dining", label: "Restaurants", rate: 3, categories: ["Dining"] },
      { id: "travel", label: "Travel", rate: 3, pattern: TRAVEL },
      { id: "transit", label: "Transit", rate: 3, pattern: TRANSIT },
    ],
    perks: [{ id: "clear", name: "CLEAR Plus credit", cadence: "ANNUAL", amountCents: 20_900, credit: "\\bCLEAR\\b", merchants: "\\bCLEAR\\b", how: "A CLEAR Plus membership paid with the card." }],
    guess: /(AMERICAN EXPRESS|AMEX).*\bGREEN\b/i,
  },
  {
    id: "amex-blue-cash-everyday",
    name: "Blue Cash Everyday Card from American Express",
    issuer: "American Express",
    annualFeeCents: 0,
    program: "amex-cash",
    baseRate: 1,
    earn: [
      { id: "groceries", label: "U.S. supermarkets", rate: 3, categories: ["Groceries"], capCents: 600_000 },
      { id: "online", label: "U.S. online retail", rate: 3, categories: ["Shopping & gifts"], pattern: ONLINE, requireBoth: true, capCents: 600_000 },
      { id: "gas", label: "U.S. gas stations", rate: 3, pattern: GAS, capCents: 600_000 },
    ],
    perks: [
      { id: "disney", name: "Disney Bundle credit", cadence: "MONTHLY", amountCents: 700, credit: "DISNEY.*CREDIT|BUNDLE CREDIT", merchants: "DISNEY|HULU|ESPN", from: "2023-01", how: "A Disney+, Hulu or ESPN+ subscription (or the bundle) of $9.99 or more, paid with the card." },
      { id: "home-chef", name: "Home Chef credit", cadence: "MONTHLY", amountCents: 1_500, credit: "HOME CHEF", merchants: "HOME ?CHEF", from: "2025-01", how: "A Home Chef order paid with the card." },
    ],
    guess: /BLUE CASH EVERYDAY/i,
    note: "Each 3% category earns 3% on up to $6,000 a year, then 1%.",
  },
  {
    id: "amex-blue-cash-preferred",
    name: "Blue Cash Preferred Card from American Express",
    issuer: "American Express",
    annualFeeCents: 9_500,
    program: "amex-cash",
    baseRate: 1,
    earn: [
      { id: "groceries", label: "U.S. supermarkets", rate: 6, categories: ["Groceries"], capCents: 600_000 },
      { id: "streaming", label: "Select U.S. streaming", rate: 6, pattern: STREAMING },
      { id: "gas", label: "U.S. gas stations", rate: 3, pattern: GAS },
      { id: "transit", label: "Transit", rate: 3, pattern: TRANSIT },
    ],
    perks: [{ id: "disney", name: "Disney Bundle credit", cadence: "MONTHLY", amountCents: 1_000, credit: "DISNEY.*CREDIT|BUNDLE CREDIT", merchants: "DISNEY|HULU|ESPN", from: "2023-01", how: "A Disney+, Hulu or ESPN+ subscription paid with the card." }],
    guess: /BLUE CASH PREFERRED/i,
  },
  {
    id: "chase-freedom-unlimited",
    name: "Chase Freedom Unlimited",
    issuer: "Chase",
    annualFeeCents: 0,
    program: "chase-ur",
    baseRate: 1.5,
    earn: [
      { id: "dining", label: "Dining", rate: 3, categories: ["Dining"] },
      { id: "drugstores", label: "Drugstores", rate: 3, pattern: DRUGSTORES },
      { id: "travel", label: "Chase Travel", rate: 5, portal: true },
    ],
    perks: [],
    guess: /FREEDOM UNLIMITED/i,
    note: "Advertised as cash back, paid as Ultimate Rewards points worth a cent each in cash (more when moved to a Sapphire card).",
  },
  {
    id: "chase-freedom-flex",
    name: "Chase Freedom Flex",
    issuer: "Chase",
    annualFeeCents: 0,
    program: "chase-ur",
    baseRate: 1,
    earn: [
      { id: "dining", label: "Dining", rate: 3, categories: ["Dining"] },
      { id: "drugstores", label: "Drugstores", rate: 3, pattern: DRUGSTORES },
      { id: "rotating", label: "Quarterly 5% categories", rate: 5, portal: true },
      { id: "travel", label: "Chase Travel", rate: 5, portal: true },
    ],
    perks: [],
    guess: /FREEDOM FLEX|\bFREEDOM\b/i,
    note: "The quarterly 5% categories change each quarter: the statements' own points figures catch them.",
  },
  {
    id: "chase-sapphire-preferred",
    name: "Chase Sapphire Preferred",
    issuer: "Chase",
    annualFeeCents: 9_500,
    program: "chase-ur",
    baseRate: 1,
    earn: [
      { id: "dining", label: "Dining", rate: 3, categories: ["Dining"] },
      { id: "streaming", label: "Select streaming", rate: 3, pattern: STREAMING },
      { id: "travel", label: "Other travel", rate: 2, pattern: TRAVEL },
      { id: "portal", label: "Chase Travel", rate: 5, portal: true },
    ],
    perks: [
      { id: "hotel", name: "Chase Travel hotel credit", cadence: "ANNUAL", amountCents: 5_000, credit: "HOTEL CREDIT|TRAVEL CREDIT", how: "A hotel booked through Chase Travel." },
      { id: "doordash", name: "DoorDash promo", cadence: "MONTHLY", amountCents: 1_000, merchants: "DOORDASH", inApp: true, from: "2025-01", how: "Applied in the DoorDash app with DashPass." },
    ],
    guess: /SAPPHIRE PREFERRED|\bCSP\b/i,
  },
  {
    id: "chase-sapphire-reserve",
    name: "Chase Sapphire Reserve",
    issuer: "Chase",
    annualFeeCents: 79_500,
    program: "chase-ur",
    baseRate: 1,
    earn: [
      { id: "flights", label: "Flights booked with airlines", rate: 4, pattern: AIRLINES, from: "2025-06" },
      { id: "hotels", label: "Hotels booked direct", rate: 4, pattern: HOTELS, from: "2025-06" },
      { id: "travel", label: "Travel", rate: 3, pattern: TRAVEL, to: "2025-05" },
      { id: "dining", label: "Dining", rate: 3, categories: ["Dining"] },
      { id: "portal", label: "Chase Travel", rate: 8, portal: true },
    ],
    perks: [
      { id: "travel", name: "Annual travel credit", cadence: "ANNUAL", amountCents: 30_000, credit: "TRAVEL CREDIT", how: "Applied automatically to the first $300 of travel each year." },
      { id: "edit", name: "The Edit hotel credit", cadence: "SEMIANNUAL", amountCents: 25_000, credit: "\\bTHE EDIT\\b|EDIT CREDIT", from: "2025-06", how: "A prepaid two-night stay from The Edit on Chase Travel." },
      { id: "dining", name: "Exclusive Tables dining credit", cadence: "SEMIANNUAL", amountCents: 15_000, credit: "EXCLUSIVE TABLES|DINING CREDIT", from: "2025-06", how: "Dining at a Sapphire Reserve Exclusive Tables restaurant on OpenTable." },
      { id: "stubhub", name: "StubHub credit", cadence: "SEMIANNUAL", amountCents: 15_000, credit: "STUBHUB|VIAGOGO", merchants: "STUBHUB|VIAGOGO", from: "2025-06", how: "Tickets on StubHub or viagogo." },
      { id: "doordash", name: "DoorDash promos", cadence: "MONTHLY", amountCents: 2_500, merchants: "DOORDASH", inApp: true, from: "2025-06", how: "Applied in the DoorDash app with DashPass." },
      { id: "lyft", name: "Lyft credit", cadence: "MONTHLY", amountCents: 1_000, merchants: "\\bLYFT\\b", inApp: true, from: "2025-06", how: "Applied in the Lyft app." },
    ],
    guess: /SAPPHIRE RESERVE|\bCSR\b/i,
  },
  {
    id: "capital-one-quicksilver",
    name: "Capital One Quicksilver",
    issuer: "Capital One",
    annualFeeCents: 0,
    program: "capital-one-cash",
    baseRate: 1.5,
    earn: [{ id: "portal", label: "Hotels and rental cars on Capital One Travel", rate: 5, portal: true }],
    perks: [],
    guess: /QUICKSILVER/i,
  },
  {
    id: "capital-one-savor",
    name: "Capital One Savor",
    issuer: "Capital One",
    annualFeeCents: 0,
    program: "capital-one-cash",
    baseRate: 1,
    earn: [
      { id: "dining", label: "Dining", rate: 3, categories: ["Dining"] },
      { id: "groceries", label: "Grocery stores", rate: 3, categories: ["Groceries"] },
      { id: "entertainment", label: "Entertainment and streaming", rate: 3, pattern: STREAMING },
    ],
    perks: [],
    guess: /\bSAVOR/i,
  },
  {
    id: "capital-one-venture",
    name: "Capital One Venture",
    issuer: "Capital One",
    annualFeeCents: 9_500,
    program: "capital-one-miles",
    baseRate: 2,
    earn: [{ id: "portal", label: "Hotels and rental cars on Capital One Travel", rate: 5, portal: true }],
    perks: [],
    guess: /\bVENTURE\b(?! X)/i,
  },
  {
    id: "capital-one-venture-x",
    name: "Capital One Venture X",
    issuer: "Capital One",
    annualFeeCents: 39_500,
    program: "capital-one-miles",
    baseRate: 2,
    earn: [{ id: "portal", label: "Capital One Travel", rate: 10, portal: true }],
    perks: [{ id: "travel", name: "Capital One Travel credit", cadence: "ANNUAL", amountCents: 30_000, credit: "TRAVEL CREDIT|CAPITAL ONE TRAVEL", how: "Bookings through Capital One Travel." }],
    guess: /VENTURE X/i,
    note: "The 10,000 anniversary miles show up in the statements' miles balance.",
  },
  {
    id: "capital-one-platinum",
    name: "Capital One Platinum",
    issuer: "Capital One",
    annualFeeCents: 0,
    program: "none",
    baseRate: 0,
    earn: [],
    perks: [],
    guess: /CAPITAL ONE.*PLATINUM/i,
    note: "A credit-building card: it earns no rewards.",
  },
  {
    id: "bilt-blue",
    name: "Bilt Blue Card",
    issuer: "Bilt",
    annualFeeCents: 0,
    program: "bilt",
    baseRate: 1,
    earn: [{ id: "rent", label: "Rent paid through Bilt", rate: 1, pattern: "BILT HOUSING|BILT RENT|BPS\\*BILT" }],
    perks: [],
    ignoreCredits: "RENT CHARGE ADJUSTMENT",
    guess: /BILT BLUE/i,
    note: "Rent earns up to 1.25× depending on everyday spending; the 4% Bilt Cash on purchases isn't counted here.",
  },
  {
    id: "bilt-obsidian",
    name: "Bilt Obsidian Card",
    issuer: "Bilt",
    annualFeeCents: 9_500,
    program: "bilt",
    baseRate: 1,
    earn: [
      { id: "rent", label: "Rent paid through Bilt", rate: 1, pattern: "BILT HOUSING|BILT RENT|BPS\\*BILT" },
      { id: "dining", label: "Dining", rate: 3, categories: ["Dining"] },
      { id: "travel", label: "Travel", rate: 2, pattern: TRAVEL },
    ],
    perks: [],
    ignoreCredits: "RENT CHARGE ADJUSTMENT",
    guess: /BILT OBSIDIAN/i,
  },
  {
    id: "bilt-palladium",
    name: "Bilt Palladium Card",
    issuer: "Bilt",
    annualFeeCents: 49_500,
    program: "bilt",
    baseRate: 2,
    earn: [{ id: "rent", label: "Rent paid through Bilt", rate: 1, pattern: "BILT HOUSING|BILT RENT|BPS\\*BILT" }],
    perks: [],
    ignoreCredits: "RENT CHARGE ADJUSTMENT",
    guess: /BILT PALLADIUM/i,
  },
  {
    id: "bilt-mastercard",
    name: "Bilt Mastercard",
    issuer: "Bilt",
    annualFeeCents: 0,
    program: "bilt",
    baseRate: 1,
    earn: [
      { id: "rent", label: "Rent paid through Bilt", rate: 1, pattern: "BILT HOUSING|BILT RENT|BPS\\*BILT" },
      { id: "dining", label: "Dining", rate: 3, categories: ["Dining"] },
      { id: "travel", label: "Travel", rate: 2, pattern: TRAVEL },
    ],
    perks: [],
    ignoreCredits: "RENT CHARGE ADJUSTMENT",
    guess: /\bBILT\b/i,
  },
  {
    id: "citi-double-cash",
    name: "Citi Double Cash",
    issuer: "Citi",
    annualFeeCents: 0,
    program: "citi-cash",
    baseRate: 2,
    earn: [],
    perks: [],
    guess: /DOUBLE CASH/i,
  },
];

/** The product an account most likely is, from its institution and name; null when nothing fits. */
export function guessProduct(account: { name: string; institution: string | null }): CardProduct | null {
  const text = `${account.institution ?? ""} ${account.name}`;
  return CARD_PRODUCTS.find((p) => p.guess.test(text)) ?? null;
}

export const productById = (id: string | null | undefined): CardProduct | null => CARD_PRODUCTS.find((p) => p.id === id) ?? null;

/** A perk or rule applies to a period (YYYY-MM-DD bounds) when their months overlap. */
export function applies(w: Window, start: string, end: string): boolean {
  return (!w.from || end.slice(0, 7) >= w.from) && (!w.to || start.slice(0, 7) <= w.to);
}
