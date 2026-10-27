/**
 * Which spending is an HSA-qualified medical expense (IRS Publication 502), judged from
 * the text a statement prints. The classifier's "Health & insurance" category is too
 * broad for this — it also holds gyms, insurance premiums, salons and supplements, none
 * of which an HSA can reimburse — so this reads the payee itself:
 *
 *   LIKELY  care that qualifies on its face: doctors, hospitals, labs, dental, vision,
 *           physical therapy, prescriptions at a pharmacy counter.
 *   CHECK   a drug store or big-box pharmacy: the basket may mix prescriptions and
 *           over-the-counter medicine (both qualify since 2020) with shampoo and snacks
 *           (which don't), so the receipt decides.
 *   null    not medical, or medical-adjacent but not qualified (gym, premiums, spa).
 */

export type ExpenseKind = "MEDICAL" | "PHARMACY" | "DENTAL" | "VISION" | "THERAPY" | "HOSPITAL" | "MENTAL_HEALTH" | "FERTILITY" | "EQUIPMENT" | "OTHER";

export const EXPENSE_KINDS: { id: ExpenseKind; label: string }[] = [
  { id: "MEDICAL", label: "Doctor & specialist" },
  { id: "HOSPITAL", label: "Hospital, ER & surgery" },
  { id: "PHARMACY", label: "Pharmacy & prescriptions" },
  { id: "DENTAL", label: "Dental" },
  { id: "VISION", label: "Vision & eye care" },
  { id: "THERAPY", label: "Physical therapy & chiro" },
  { id: "MENTAL_HEALTH", label: "Mental health" },
  { id: "FERTILITY", label: "Fertility & family planning" },
  { id: "EQUIPMENT", label: "Equipment & supplies" },
  { id: "OTHER", label: "Other qualified" },
];

export const KIND_LABEL: Record<ExpenseKind, string> = Object.fromEntries(EXPENSE_KINDS.map((k) => [k.id, k.label])) as Record<ExpenseKind, string>;
export const isExpenseKind = (v: unknown): v is ExpenseKind => typeof v === "string" && v in KIND_LABEL;

export type Tier = "LIKELY" | "CHECK";
export type Qualification = { tier: Tier; kind: ExpenseKind; reason: string };

/** Medical-adjacent spending an HSA can't reimburse; checked first so it always wins. */
const NOT_QUALIFIED =
  /\bGYM\b|FITNESS|EQUINOX|YOGA|PILATES|SOULCYCLE|PELOTON|CLASSPASS|ORANGETHEORY|\bYMCA\b|SUPPLEMENT|VITAMIN SHOPPE|GNC\b|\bSPA\b|MASSAGE ENVY|SALON|BARBER|\bNAILS?\b|COSMETIC|BOTOX|MEDSPA|MED SPA|AESTHETIC|LASER HAIR|INSURANCE|PREMIUM|AETNA|CIGNA|UNITED ?HEALTH|UHC\b|BLUE ?CROSS|BCBS|ANTHEM|HUMANA|OSCAR HEALTH|OXFORD HEALTH|EMBLEM|HARVARD PILGRIM|KAISER PERM|METLIFE|GEICO|STATE FARM|ALLSTATE|LEMONADE|PROGRESSIVE|VETERIN|ANIMAL HOSPITAL|PET HOSPITAL|\bVCA\b|BANFIELD|HOSPITALITY|HEALTHEQUITY|HSA BANK|FURTHER HSA|OPTUM BANK|ZOCDOC|ONE MEDICAL MEMBERSHIP|AMUSEMENT|ICE CREAM|HARDWARE|GO ?FU?NDME|\bIKEA\b/;

const RULES: [RegExp, ExpenseKind, Tier, string][] = [
  [/FERTILIT|\bIVF\b|REPRODUCTIVE|\bRMA\b|SHADY GROVE|KINDBODY|CCRM|MIDWIFE|\bOB ?GYN|OBSTETRIC|LACTATION/, "FERTILITY", "LIKELY", "fertility or obstetric care"],
  // Card descriptors cut words short ("SPECIAL SURGRY"), so the vowel is optional.
  [/HOSPITAL(?!ITY)|EMERGENCY|\bER\b|URGENT ?CARE|CITYMD|SURGE?RY|SURGICAL|SURGEON|ANESTHES|AMBULANCE|\bEMS\b|RADIOLOG|IMAGING|\bMRI\b|PATHOLOG|MEDICAL CENTER|MED CTR|HEALTH SYSTEM|HLTH SYS|PRESBYTERIAN|NORTHWELL|YALE NEW HAVEN|HACKENSACK|MAYO CLINIC|CLEVELAND CLINIC/, "HOSPITAL", "LIKELY", "hospital, ER, imaging or surgery"],
  [/DENTAL|DENTIST|\bDDS\b|\bDMD\b|ORTHODONT|PERIODONT|ENDODONT|ORAL SURG|SMILE DIRECT|INVISALIGN/, "DENTAL", "LIKELY", "dental care"],
  [/OPHTHALM|OPTOMET|OPTICIAN|EYE ?CARE?|EYE (DOCTOR|ASSOC|CENTER|INSTITUTE|PHYSICIAN|SURG)|\bEYE\b.*\b(EXAM|MD|DR)\b|LENSCRAFTERS|WARBY PARKER|1-?800 ?CONTACTS|CONTACTS ?DIRECT|COSTCO OPTICAL|VISIONWORKS|PEARLE VISION|AMERICA'?S BEST|LASIK|ZENNI/, "VISION", "LIKELY", "eye care, glasses or contacts"],
  // "PT" alone is too common (Pt. Pleasant, a store number): only a processor prefix ("PT *CLINIC").
  [/PHYSICAL THERAP|\bPHYSIO|(?:^|\s)PT ?\*|CHIROPRACT|ACUPUNCT|OCCUPATIONAL THERAP|SPEECH THERAP|ORTHOPED|SPORTS MED|PODIATR/, "THERAPY", "LIKELY", "therapy, chiropractic or orthopedics"],
  [/PSYCHIATR|PSYCHOLOG|COUNSEL|THERAPIST|BEHAVIORAL HEALTH|MENTAL HEALTH|TALKSPACE|BETTERHELP|HEADWAY|ALMA ?HEALTH|SONDERMIND|\bLCSW\b|\bLMFT\b/, "MENTAL_HEALTH", "LIKELY", "mental health care"],
  [/LABCORP|QUEST DIAG|MEDICAL LAB|CLINICAL LAB|PATHOLOGY LAB|DIAGNOSTIC/, "MEDICAL", "LIKELY", "lab work"],
  // A health system's billing office bills under its own name, with nothing that says care
  // ("RIVERBEND HEALTH CUST SERV"); insurers saying the same are caught by NOT_QUALIFIED first.
  [/HEALTH ?(?:CUST(?:OMER)? ?SERV|BILLING|PATIENT|PMT|PAYMENT)|PATIENT ?(?:ACCT|ACCOUNT|BILLING|FINANCIAL|SERV)|HOSP(?:ITAL)? BILLING|SCH(?:OOL)? OF MED/, "HOSPITAL", "LIKELY", "a health system's billing office"],
  [/HEARING|AUDIOLOG|CPAP|\bDME\b|DURABLE MEDICAL|MEDICAL SUPPL|\bBRACE\b|CRUTCH|GLUCOSE|DEXCOM|OMNIPOD|BLOOD PRESSURE/, "EQUIPMENT", "LIKELY", "medical equipment or supplies"],
  [/PRESCRIPTION|\bRX\b|PHARMACY ?RX|EXPRESS SCRIPTS|CAREMARK|OPTUM ?RX|ALTO PHARM|CAPSULE|PILLPACK|AMAZON PHARM|COST PLUS DRUG|GOODRX|HONEYBEE|BLINK HEALTH/, "PHARMACY", "LIKELY", "prescriptions"],
  // "MD" alone is also Maryland and "DR" a shop's name ("Dr. Mike's Ice Cream"): a practice suffix only.
  [/PHYSICIAN|DOCTOR|\bM\.?D\.? ?(?:PC|PL|PA|PLLC|LLC|P\.C\.)(?:\b|$)|MEDICAL|CLINIC|PEDIATRIC|DERMATOLOG|ALLERG|CARDIOLOG|GASTROENTER|NEUROLOG|ONCOLOG|UROLOG|ENDOCRIN|RHEUMATOL|PULMON|NEPHROL|\bENT\b|EAR,? NOSE|OTOLARYNG|INTERNAL MED|FAMILY MED|PRIMARY CARE|HEALTHCARE|HEALTH CARE|PATIENT ?PAY|PATIENT ?PMT|INSTAMED|PAYMENTUS ?MED|MYCHART|ONE MEDICAL|FORWARD HEALTH|TELADOC|AMWELL|MDLIVE|NURSE|PRACTITIONER|\bNP\b|\bPA-?C\b|PHYS(ICIANS)? GRP|MED GRP|MEDICAL GROUP|ASSOC(IATES)? PC|HEALTH ?PARTNERS/, "MEDICAL", "LIKELY", "doctor or clinic"],
  // A doctor billing as "DR <initial> <surname>" ("DR K MARLOWE"); a name alone could be a shop, so only a check.
  [/\bDR\.? [A-Z]\.? [A-Z]{3,}/, "MEDICAL", "CHECK", "looks like a doctor billing under their own name"],
  [/\bCVS\b|CVS\/|CVS PHARM|WALGREEN|DUANE READE|RITE ?AID|PHARMAC|FARMACIA|DRUG ?STORE|DRUGSTORE|APOTHECARY|CHEMIST|SHOPPERS DRUG/, "PHARMACY", "CHECK", "drug store: keep the receipt for the medical items"],
];

/** Categories that say nothing either way about a charge being medical. */
const NEUTRAL_CATEGORIES = new Set(["Health & insurance", "Other", "Uncategorized", ""]);

/** How the ledger filed the row: its category, and whether the owner chose it (a merchant rule or a row answer). */
export type FiledAs = { category: string; byOwner: boolean };

export const ownerFiled = (classifiedBy: string | null) => classifiedBy === "USER" || classifiedBy === "user-merchant-rule";

/**
 * A provider's name without the processor prefix and the location tail: its first two words
 * ("AplPay ACME ORTHO NEW YORK NY" and "Card: Acme Ortho, 800-…" both → "ACME ORTHO"), so a
 * charge can be matched to a provider the HSA card has paid or the owner has logged.
 * Null when the name has fewer than two words to go on.
 */
export function providerKey(name: string): string | null {
  const words = name
    .toUpperCase()
    .replace(/^(?:CARD:|APLPAY|SQ ?\*|TST ?\*|SP |PY ?\*|PAYPAL ?\*)\s*/, "")
    .replace(/[^A-Z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return words.length >= 2 ? `${words[0]} ${words[1]}` : null;
}

/**
 * Judge a payee (and any industry line) as an HSA-qualified expense.
 *
 * `filed`: the ledger's category for the row. A charge filed somewhere plainly not medical
 * (Groceries, Dining, Shopping…) needs more than a name to be suggested: if the owner
 * filed it there it's never medical; if the classifier did, a matching name is only worth
 * a check (parking at a hospital), never "likely". A row the owner filed under Health &
 * insurance is worth a look even when the name says nothing (a doctor's practice billing
 * under their own name).
 *
 * `known`: why this provider is already known to be medical (the HSA card paid it, or the
 * owner logged an expense from it). A name the rules don't recognize is then worth a check,
 * unless it's medical-adjacent or filed somewhere plainly not medical.
 */
export function qualifyPayee(payee: string, detail?: string | null, filed?: FiledAs | null, known?: string | null): Qualification | null {
  const text = `${payee} ${detail ?? ""}`.toUpperCase();
  if (NOT_QUALIFIED.test(text)) return null;
  const elsewhere = filed != null && !NEUTRAL_CATEGORIES.has(filed.category);
  if (elsewhere && filed.byOwner) return null;
  for (const [re, kind, tier, reason] of RULES) {
    if (!re.test(text)) continue;
    if (!elsewhere) return { tier, kind, reason };
    // Already only a maybe (a drug store) and filed as something else: not worth asking about.
    return tier === "LIKELY" ? { tier: "CHECK", kind, reason: `${reason}, but filed under ${filed.category}` } : null;
  }
  if (filed?.byOwner && filed.category === "Health & insurance") return { tier: "CHECK", kind: "MEDICAL", reason: "you filed this merchant under Health & insurance" };
  return known && !elsewhere ? { tier: "CHECK", kind: "MEDICAL", reason: known } : null;
}

/** Best guess at the kind of expense from a free-text note ("PT session and knee x-rays"). */
export function guessKind(text: string): ExpenseKind {
  const t = text.toUpperCase();
  if (/X-?RAY|\bER\b|EMERGENCY|SURGERY|SURGEON|HOSPITAL(?!ITY)|ANESTHES|\bMRI\b|\bCT SCAN/.test(t)) return "HOSPITAL";
  if (/\bEYES?\b|GLASSES|CONTACT LENS/.test(t)) return "VISION";
  if (/EPI ?PEN|EPIPEN|SLEEP(ING)? AID|NASAL STRIP|\bOTC\b|MEDICINE|ALLERGY PILL/.test(t)) return "PHARMACY";
  return qualifyPayee(text)?.kind ?? "MEDICAL";
}
