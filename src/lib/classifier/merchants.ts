import { normalizeMerchant } from "../categorization/normalizeMerchant.ts";

export type MerchantRule = [RegExp, string];

/**
 * Spending categorization by merchant text. Ordered: the first matching pattern wins,
 * so specific merchants sit above broad keywords (e.g. "UBER EATS" before "UBER").
 * Patterns run against the uppercased raw description plus any detail line.
 *
 * Only merchants anyone might meet live here. A rule with an id also takes the
 * household's own keywords (data/household.json `merchantKeywords`, see
 * lib/household): the local restaurants, shops and landlords that would otherwise
 * say where the household lives.
 */
const BUILT_IN: [RegExp, string, string?][] = [
  // Subscriptions & digital services (before generic Apple/Google/Amazon)
  [/AMAZON PRIME|PRIME VIDEO|AMAZON\.CA PRIME|AMZN PRIME/, "Subscriptions"],
  [/SPOTIFY|HULU|NETFLIX|YOUTUBE ?PREMIUM|YOUTUBEPREMIUM|DISNEY ?PLUS|HBO ?MAX|PARAMOUNT\+|PEACOCK|SIRIUSXM|AUDIBLE/, "Subscriptions"],
  [/APPLE\.COM\/BILL|ICLOUD|GOOGLE ?\*?ONE|GOOGLE \*GOOGLE ONE|GOOGLE STORAGE|GOOGLE ?\*?NEST|DROPBOX|MICROSOFT|ADOBE/, "Subscriptions"],
  [/OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|MIDJOURNEY|GITHUB/, "Subscriptions"],
  [/WSJ|WSJOURNAL|NYTIMES|NEW YORK TIMES|ECONOMIST|BLOOMBERG|FT\.COM|NEWS CORP|WASHINGTON POST/, "Subscriptions"],
  [/UBER ONE|UBER PASS|DASHPASS|GRUBHUB ?\+|GRUBHUBGHPLUS|WALMART\+|COSTCO MEMBERSHIP|SHIPPINGCLUB|ANNUAL MEMBERSHIP/, "Subscriptions"],
  [/OURARING|WHOOP|STRAVA|PELOTON/, "Subscriptions"],
  [/GLOBE AND MAIL|POSTMEDIA|TORONTO STAR|SUBSTACK|PATREON/, "Subscriptions", "subscriptions-media"],
  [/CITY CLERK|NYS DOS|\bCBP\b|CUSTOMS|FREETAXUSA|TURBOTAX|H&R BLOCK/, "Government & services"],
  [/FISHING|FH\* .*FISH|CHARTER/, "Entertainment"],
  // Raw card-network descriptors (Capital One prints them with no industry line, the city
  // and state glued on): airline tickets are the carrier plus a ticket number.
  [/^(UNITED|DELTA|AMERICAN|ALASKA|JETBLUE|SOUTHWEST|SPIRIT|AIR CANADA|WESTJET|PORTER) ?\d{8,}/, "Travel"],
  [/HELP\.MAX\.COM|CRUNCHYROLL/, "Subscriptions"],
  [/^NJT\b|\bSTIB \d|CITIBIK|NATIONAL CAR RENTAL|IMPARK/, "Transportation"],
  [/HOSPITALITY|RISTORAN|GELATERI|PANINO|TRATTORI|FOCACCERIA|CIBO EXPRESS|HMS HOST|AIRPORT-F&B|CONCESSION|BAKING|TIM HORTON'?S|ELEPHANT & CASTLE/, "Dining", "dining-early"],
  [/CARREFOUR|FORTINOS/, "Groceries", "groceries-early"],
  [/VINEYARDS|CELLARS|WINERY/, "Groceries"],
  [/ALBERGO|RENAISSANC|HOPEGOO/, "Travel"],
  [/\bYMCA\b|\bDDS\b|DOCTO/, "Health & fitness", "health-early"],
  [/VAGARO|ALTERATIONS/, "Personal care", "personal-care-early"],
  [/KALSHI|POLYMARKET/, "Entertainment"],
  [/ADMISSION|ADMITONE|NATL PARK|NATIONAL PARK|STAMPEDE|BOAT RENTA/, "Entertainment"],
  [/\bUPS\*|LA POSTE/, "Government & services"],
  [/FLEURS/, "Gifts & donations"],
  [/AZAZIE/, "Events & celebrations", "events-early"],
  [/DOLLAR TREE|T ?J ?MAXX|VALUE VILLAGE|TRACTOR SUPPLY|CARHARTT|NEWBALANCE|NEW BALANCE|\bLEGO|SWAROVSKI|LA VIE EN ROSE|SAXX|INDIGO #|LOVESHACKFANCY|\bC&A\b/, "Shopping"],
  [/ITALIARAIL|TRENITALIA|\bSNAV\b|FERRY|CRUISE|EUROSTAR|VIA RAIL|FLIXBUS|GREYHOUND/, "Travel", "travel-early"],

  // Food delivery & dining
  [/UBER ?\*?EATS|SEAMLSS|SEAMLESS|GRUBHUB|DOORDASH|\bDD \*|CAVIAR|POSTMATES|MENUMVN|CHOWNOW|TOAST TAB/, "Dining"],
  [/STARBUCKS|BLUE BOTTLE|DUNKIN|TIM HORTONS|PARIS BAGUETTE|LE PAIN|COFFEE|CAFE|CAFFE|ESPRESSO|BAKERY|BAGEL|DONUT|CREPE/, "Dining"],
  [/SWEETGREEN|CHIPOTLE|CHOPT|CAVA\b|POTBELLY|SHAKE ?SHACK|MCDONALD|WENDY|BURGER|FIVE ?GUYS|WINGSTOP|DOMINO|PIZZA|PIZZERIA|SUSHI|TACO|TAQUERIA|RAMEN|NOODLE|PHO\b|THAI|KITCHEN|GRILL|BISTRO|TRATTORIA|RISTORANTE|OSTERIA|STEAKHOUSE|DINER|DELI\b|EATALY|MANGIA|SOUVLAKI|GYRO|KEBAB|HALAL|CHICKEN|BBQ|BRASSERIE|TAVERN|PUB\b|\bBAR\b|TAPROOM|BREWERY|BEER|WINE BAR|LOUNGE|ROOFTOP|CANTINA|ICE CREAM|GELATO|PINKBERRY|CRUMBL|CONFECTION|CANDY|FROZEN YOGURT|JUICE|SMOOTHIE|RESTAURANT|RESTAUR|EATERY|FOOD ORDER|FOOD HALL|CATERING|TST\*/, "Dining"],
  [/\bPITA|FALAFEL|DAIRY QUEEN|CHICK-FIL-A|HOT DOG|OMAKASE|STEAK|SAKE|PASTA|WAFFLE|EARLS|ALE HOUSE|BEER HALL|SPEAKEASY|COCKTAIL|CHEESE|FOOD SHACK|FOODANDBEVERAGE|SNACK|SALAD/, "Dining", "dining-places"],

  // Groceries
  [/WHOLE ?FOODS|WHOLEFDS|TRADER JOE|MORTON WILLIAMS|CITARELLA|WEGMANS|STOP & SHOP|SHOPRITE|KEY FOOD|FAIRWAY|GRISTEDES|D'AGOSTINO|ALDI|PUBLIX|KROGER|SAFEWAY|LOBLAWS|METRO MARCHE|RABBA|SOBEYS|FOOD BASICS|NO FRILLS|INSTACART|FRESH DIRECT|FRESHDIRECT|GROCERY|SUPERMARKET|MARKET DISTRICT|MEAT|BUTCHER|FISH MARKET|PRODUCE/, "Groceries", "groceries"],
  [/WINE|LIQUOR|SPIRITS|LCBO|BEER STORE/, "Groceries", "groceries-drink"],

  // Transportation
  [/UBER ?\*?TRIP|UBER TRIP|\bUBER\b|LYFT|CURB|TAXI|CAB\b|CITYCAB|LIMO|VIA RIDE|REVEL/, "Transportation"],
  [/NYCT|MTA|OMNY|PAYGO|MNR|METRO-?NORTH|LIRR|NJ TRANSIT|PATH TAPP|PATH\b|AMTRAK|GO TRANSIT|PRESTO|TTC|SEPTA/, "Transportation"],
  [/\bSHELL\b|EXXON|\bMOBIL\b|CHEVRON|SUNOCO|\bBP\b|CITGO|GULF|SPEEDWAY|\bGAS\b|\bFUEL|PETRO/, "Transportation"],
  [/COACH USA|MAGIC PASS|RENTAL ?TOLL|ERACTOLL|TOLL BY|NJ TURNPIKE/, "Transportation", "transportation-passes"],
  [/PARKING|PARK OF AMERICA|VALET|E-?ZPASS|PASSNY|\bTOLLS?\b|DMV|AUTOZONE|JIFFY|CAR WASH|\bTIRES?\b|SPOTHERO|ICON PARKING|ZIPCAR|HERTZ|AVIS|ENTERPRISE RENT|TRUCK RENTAL|U-HAUL/, "Transportation"],

  // Travel
  [/AIRLINE|AIRWAYS|AIR CANADA|PORTER AIR|UNITED AIRLINES|DELTA AIR|AMERICAN AIR|JETBLUE|SOUTHWEST|SPIRIT AIR|WESTJET|SWISS INTL|LUFTHANSA|BRITISH AIRWAYS|EXPEDIA|BOOKING\.COM|HOTELS\.COM|AIRBNB|VRBO|MARRIOTT|HILTON|HYATT|SHERATON|WESTIN|HOLIDAY INN|RESIDENCE INN|HOTEL|INN\b|RESORT|LODGE|HOSTEL|AMEX TRAVEL|AMERICAN EXPRESS TRAVEL|AIRALO|DUTY FREE|TRAVEL AGENCY/, "Travel"],

  // Health & fitness
  [/CVS|DUANE READE|WALGREENS|RITE AID|PHARMAC|FARMACIA|SHOPPERS DRUG|DRUG STORE/, "Health & fitness"],
  [/(?<!PET |ANIMAL |VETERINARY )HOSPITAL(?!ITY)|MEDICAL|DOCTOR|PHYSICIAN|CLINIC|DENTAL|DENTIST|ORTHO|DERMATOLOG|OPTOMETR|LENSCRAFTERS|VISION|PHYSICAL THERAPY|CHIROPRACT|ONE MEDICAL|ZOCDOC|EAR NOSE|THERAP|LABCORP|QUEST DIAG|HEALTHCARE/, "Health & fitness", "health-medical"],
  [/LIFETIMEFITNESS|LIFE TIME|EQUINOX|BLINK FITNESS|PLANET FITNESS|SOULCYCLE|BARRY'?S|ORANGETHEORY|CLASSPASS|GYM|FITNESS|YOGA|PILATES|CLIMB|TRANSPARENT LABS|ST PHORM|SUPPLEMENT/, "Health & fitness"],

  // Insurance
  [/GEICO|STATE FARM|ALLSTATE|PROGRESSIVE|LEMONADE|INSURANCE|METLIFE|ASSURANCE/, "Insurance"],

  // Utilities, phone, internet
  [/CON ?EDISON|CONED|EVERSOURCE|NATIONAL GRID|PSE&G|UTILITY|UTILITIES|WATER AUTHORITY|AQUARION/, "Utilities"],
  [/T-?MOBILE|TMOBILE|VERIZON|AT&T|SPECTRUM|COMCAST|XFINITY|OPTIMUM|FIOS|ROGERS|BELL CANADA|STARLINK|MINT MOBILE|GOOGLE FI/, "Phone & internet"],

  // Housing
  [/^YSI\*|\bYSI\*|YARDI|RENTCAFE|APPFOLIO|BUILDIUM|GREYSTAR|BILT CARD HOUSING|RENT PAYMENT|APARTMENTS|PROPERTY MGMT|PROPERTY MANAGEMENT|LANDLORD|EXTRA SPACE|STORAGE|MOVING|MOVERS|HOME DEPOT|LOWE'?S|IKEA|WAYFAIR|WILLIAMS-?SONOMA|CRATE|POTTERY BARN|BED BATH|HOME FURNISH|HARDWARE/, "Housing", "housing"],

  // Pets
  [/CHEWY|PETCO|PETSMART|PET SHOP|PETPOCKETBOOK|PET SUPPL|VETERIN|ANIMAL HOSPITAL|PET HOSPITAL|ROVER\.COM|BARKBOX/, "Pets"],

  // Personal care
  [/BARBER|SALON|\bHAIR|\bNAILS?\b|\bSPA\b|MASSAGE|DRY CLEAN|CLEANERS|LAUNDR|TAILOR|SEPHORA|ULTA|AESOP|KIEHL/, "Personal care"],

  // Gifts & donations
  [/FLORIST|FLOWERS|1-800-FLOWERS|CHARIT|DONAT|MOVEMBER|GOFUNDME|RED CROSS|UNICEF|ZOLA|REGISTRY|GIFT/, "Gifts & donations"],

  // Events
  [/WEDDING|BRIDAL|THE KNOT/, "Events & celebrations", "events"],

  // Entertainment
  [/AMC\b|REGAL|CINEMA|THEATER|THEATRE|MOVIE|TICKETMASTER|LIVE NATION|STUBHUB|SEATGEEK|AXS\.COM|EVENTBRITE|TICKET|CONCERT|MUSEUM|ZOO|AQUARIUM|GREAT ADVENTURE|SIX FLAGS|BOWLING|GOLF|RACEWAY|ARCADE|CASINO|\bBET\b|DRAFTKINGS|FANDUEL|\bSTEAM\b|PLAYSTATION|XBOX|NINTENDO|F1\.COM|NASCAR|ARENA|STADIUM|COMEDY|KARAOKE|KONA ICE/, "Entertainment", "entertainment"],

  // Kids & education
  [/DAYCARE|CHILD ?CARE|PRESCHOOL|TUITION|UNIVERSITY|COLLEGE|SCHOOL|BUY BUY BABY|CARTER'?S|BABY|KIDS|TOYS|COURSERA|UDEMY/, "Kids & education"],

  // Government & services
  [/USPS|UPS STORE|FEDEX|DHL|POSTAL|PASSPORT|IMMIGRATION|CITY OF|STATE OF|COUNTY|COURT|GOVERNMENT|DMV|NOTARY/, "Government & services"],

  // Shopping (broad, last among merchants)
  [/FARMERS MARKET|NATURAL M(AR)?KT|ORGANIC/, "Groceries", "groceries-late"],
  [/EYECARE|EYE CARE|\bMD\b|\bM\.D\.|PEDIATRIC|URGENT CARE/, "Health & fitness", "health-late"],
  [/CIGAR|SMOKE|TOBACCO|VAPE|SHOE|TISSOT|TED BAKER|CLOTHNG|SUR LA TABLE|BALSAM HILL|SODASTREAM|LUSH\b|RTIC|PHOTO|SOFT-MOC|POUCH/, "Shopping"],
  [/PET MARKET|PET VALU|SERVICE ANIMALS/, "Pets"],
  [/ASSOCIATION|ALUMNI|DUES/, "Gifts & donations", "gifts-late"],
  [/OPHTHALM|OPTOMET|EYE (DOCTOR|ASSOC)/, "Health & fitness"],
  [/PARKMOBILE|PMUSA|SELF PARKING|VALET PARK|PARKING|SHELL OIL|EXXON/, "Transportation", "transportation-late"],
  [/FUDGE|VAN LEEUWEN|ICE CR(EAM)?\b|CREAMERY|GELATO|BAKERY|DONUT/, "Dining", "dining-late"],
  [/FISH MARKET|SEAFOOD MARKET/, "Groceries"],
  [/WCS E-?COMMERCE|WILDLIFE CONSERVATION|BRONX ZOO/, "Entertainment"],
  [/SHOP LOCAL/, "Shopping", "shopping-late"],
  [/\bICI\*|ICI\*FEE/, "Government & services"],
  [/AMAZON|AMZN|TARGET|WALMART|COSTCO|BJ'?S|NORDSTROM|MACY|BLOOMINGDALE|SAKS|BARNES|BOOK|APPLE STORE|APPLE ENGRAVING|BEST BUY|STAPLES|UNIQLO|ZARA|H&M|GAP\b|J\.?CREW|LULULEMON|NIKE|ADIDAS|HARRY ROSEN|WATCHES OF SWITZERLAND|SHUTTERFLY|ZAZZLE|ETSY|EBAY|WAYFAIR|STORE|SHOP|BOUTIQUE|OUTLET|APPAREL|CLOTHING|NEWSSTAND|NEWS DEALER/, "Shopping", "shopping"],
];

/** Amex prints an industry line under many merchants; map it when the name alone fails. */
export const AMEX_INDUSTRY_HINTS: [RegExp, string][] = [
  [/RESTAURANT|FAST FOOD|BAR\/NIGHTCLUB|BAKERY|CANDY|CONFECTION|CATERER/, "Dining"],
  [/GROCERY|MISC FOOD STORE|FREEZER & LOCKER MEAT|LIQUOR STORE|CONVENIENCE/, "Groceries"],
  [/LOCAL TRANSPORTATION|TAXICAB|LIMOUSINE|PARKING|AUTOMOTIVE|SERVICE STATION|TOLL|E-ZPASS|TRUCK RENTAL/, "Transportation"],
  [/AIRLINE|LODGING|HOTEL|TRAVEL AGENCY|TOURIST ATTRACTION/, "Travel"],
  [/PHARMAC|DRUG STORE|MEDICAL|HEALTHCARE|DENTAL|OPTICIAN|DOCTOR/, "Health & fitness"],
  [/CABLE|UTILITIES|TELECOM|MOBILE/, "Phone & internet"],
  [/INSURANCE/, "Insurance"],
  [/SUBSCRIPTION|DIGITAL|RECORD STORE|COMPUTER PROGRAMMING|NEWS DEALER|VIDEO RENTAL/, "Subscriptions"],
  [/CHARITABLE|FLORIST/, "Gifts & donations"],
  [/DRY CLEANER|BARBER|BEAUTY|LAUNDRY/, "Personal care"],
  [/PET SHOP/, "Pets"],
  [/TICKET SALES|THEATRICAL|AMUSEMENT|SPORTS|VIDEO PRODUCTION/, "Entertainment"],
  [/COLLEGE|UNIVERSITY|SCHOOL|EDUCATION/, "Kids & education"],
  [/GOVERNMENT/, "Government & services"],
  [/HOME FURNISH|HARDWARE/, "Housing"],
  [/MERCHANDISE|STORE|APPAREL|CLOTHING|RETAIL|GOODS|ELECTRONICS|COMPUTERS|DEPARTMENT|DISCOUNT|SPORTING|BOOK/, "Shopping"],
];

/** Ids of the rules a household can add keywords to. */
export const MERCHANT_RULE_IDS: readonly string[] = BUILT_IN.flatMap(([, , id]) => (id ? [id] : []));

/** The built-in rules, each extended with the household's keywords for its id (regex sources). */
export function compileMerchantRules(keywords: Record<string, string> = {}): MerchantRule[] {
  return BUILT_IN.map(([re, cat, id]) => [id && keywords[id] ? new RegExp(`${re.source}|${keywords[id]}`) : re, cat]);
}

/** The built-in rules alone (no household keywords). */
export const MERCHANT_RULES: MerchantRule[] = compileMerchantRules();

export function categorizeMerchant(description: string, detail?: string, rules: MerchantRule[] = MERCHANT_RULES): string | null {
  const d = description.toUpperCase();
  for (const [re, cat] of rules) if (re.test(d)) return cat;
  if (detail) {
    const det = detail.toUpperCase();
    for (const [re, cat] of rules) if (re.test(det)) return cat;
    for (const [re, cat] of AMEX_INDUSTRY_HINTS) if (re.test(det)) return cat;
  }
  return null;
}

/**
 * Weak signal: small Square-processed charges are overwhelmingly food and drink.
 * Used only when nothing better matched, and flagged as low confidence.
 */
export function squareSmallTicketGuess(detail: string | undefined, amountCents: number): string | null {
  return detail && /squareup\.com/i.test(detail) && Math.abs(amountCents) <= 7_500 ? "Dining" : null;
}

const AGGREGATOR_PREFIX = /^(SEAMLSS|SEAMLESS|GRUBHUB|DD|PY|BT|CKE|FSP|SPO|BLVD|PAR|SP|TST|LS|YSI|SQ|POS|PP|PAYPAL|GOOGLE|MENUMVN|UBER)\s+/;
/** Bank verbs in front of the actual payee ("Online Payment 2568 To Ala", "Zelle Payment To Jordan"). */
const BANK_VERB_PREFIX = /^(Online Payment(\s+\d+)?\s+To|Zelle Payment (From|To)|Payment To)\s+/i;

/**
 * Descriptions that name a kind of bank movement rather than a merchant. A rule taught
 * on one of these would relabel unrelated rows, so they're decided one row at a time.
 */
const GENERIC_MERCHANT_KEYS = new Set([
  "REAL TIME TRANSFER",
  "DEPOSIT",
  "WITHDRAWAL",
  "REMOTE ONLINE DEPOSIT",
  "ATM CASH DEPOSIT",
  "ATM WITHDRAWAL",
  "NON CHASE ATM",
  "ONLINE DOMESTIC WIRE",
  "CONSUMER ONLINE WIRE",
  "CONSUMER ONLINE",
  "BOOK TRANSFER CREDIT",
  "INCOMING WIRE FEE",
  "CHECK",
  "OFFICIAL CHECKS CHARGE",
]);

export function isGenericMerchantKey(key: string | null | undefined): boolean {
  return !key || GENERIC_MERCHANT_KEYS.has(key) || /^CHECK\b/.test(key);
}

/**
 * Stable key for a merchant across its noisy statement spellings, used for user-taught
 * category rules: "AplPay SEAMLSS*SHAKESHACK NEW YORK NY" and "SEAMLSS*SHAKESHACK" both
 * become "SHAKESHACK". Card-purchase wrappers (Chase debit) and cardmember names
 * (Amex credits; `cardholder` is the household's, from lib/household) are stripped first.
 */
export function merchantKey(description: string, cardholder: RegExp | null = null): string {
  let d = description
    .replace(/^(Card Purchase( With Pin)?|Recurring Card Purchase|Non-Chase ATM Withdraw|Reversal:)\s+(\d{2}\/\d{2}\s+)?/i, "")
    .replace(/\s+Card \d{4}\b.*$/i, "");
  if (cardholder) d = d.replace(cardholder, "");
  d = d.replace(BANK_VERB_PREFIX, "");
  d = normalizeMerchant(d);
  let prev = "";
  while (prev !== d) {
    prev = d;
    d = d.replace(AGGREGATOR_PREFIX, "");
  }
  const tokens = d.split(" ").filter((t) => t && !/\d/.test(t) && t.length > 1);
  return tokens.slice(0, 3).join(" ") || normalizeMerchant(description);
}
