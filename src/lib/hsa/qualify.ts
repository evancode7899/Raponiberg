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
  /\bGYM\b|FITNESS|EQUINOX|YOGA|PILATES|SOULCYCLE|PELOTON|CLASSPASS|ORANGETHEORY|\bYMCA\b|SUPPLEMENT|VITAMIN SHOPPE|GNC\b|\bSPA\b|MASSAGE ENVY|SALON|BARBER|\bNAILS?\b|COSMETIC|BOTOX|MEDSPA|MED SPA|AESTHETIC|LASER HAIR|INSURANCE|PREMIUM|AETNA|CIGNA|UNITED ?HEALTH|UHC\b|BLUE ?CROSS|BCBS|ANTHEM|HUMANA|OSCAR HEALTH|OXFORD HEALTH|EMBLEM|HARVARD PILGRIM|KAISER PERM|METLIFE|GEICO|STATE FARM|ALLSTATE|LEMONADE|PROGRESSIVE|VETERIN|ANIMAL HOSPITAL|PET HOSPITAL|\bVCA\b|BANFIELD|HOSPITALITY|HEALTHEQUITY|HSA BANK|FURTHER HSA|OPTUM BANK|ZOCDOC|ONE MEDICAL MEMBERSHIP/;

const RULES: [RegExp, ExpenseKind, Tier, string][] = [
  [/FERTILIT|\bIVF\b|REPRODUCTIVE|\bRMA\b|SHADY GROVE|KINDBODY|CCRM|MIDWIFE|\bOB ?GYN|OBSTETRIC|LACTATION/, "FERTILITY", "LIKELY", "fertility or obstetric care"],
  [/HOSPITAL(?!ITY)|EMERGENCY|\bER\b|URGENT ?CARE|CITYMD|SURGERY|SURGICAL|SURGEON|ANESTHES|AMBULANCE|\bEMS\b|RADIOLOG|IMAGING|\bMRI\b|PATHOLOG|MEDICAL CENTER|MED CTR|HEALTH SYSTEM|HLTH SYS|PRESBYTERIAN|NORTHWELL|YALE NEW HAVEN|HACKENSACK|MAYO CLINIC|CLEVELAND CLINIC/, "HOSPITAL", "LIKELY", "hospital, ER, imaging or surgery"],
  [/DENTAL|DENTIST|\bDDS\b|\bDMD\b|ORTHODONT|PERIODONT|ENDODONT|ORAL SURG|SMILE DIRECT|INVISALIGN/, "DENTAL", "LIKELY", "dental care"],
  [/OPHTHALM|OPTOMET|OPTICIAN|EYE ?CARE|EYE (DOCTOR|ASSOC|CENTER|INSTITUTE|PHYSICIAN|SURG)|\bEYE\b.*\b(EXAM|MD|DR)\b|LENSCRAFTERS|WARBY PARKER|1-?800 ?CONTACTS|CONTACTS ?DIRECT|COSTCO OPTICAL|VISIONWORKS|PEARLE VISION|AMERICA'?S BEST|LASIK|ZENNI/, "VISION", "LIKELY", "eye care, glasses or contacts"],
  [/PHYSICAL THERAP|\bPHYSIO|\bPT\b|CHIROPRACT|ACUPUNCT|OCCUPATIONAL THERAP|SPEECH THERAP|ORTHOPED|SPORTS MED|PODIATR/, "THERAPY", "LIKELY", "therapy, chiropractic or orthopedics"],
  [/PSYCHIATR|PSYCHOLOG|COUNSEL|THERAPIST|BEHAVIORAL HEALTH|MENTAL HEALTH|TALKSPACE|BETTERHELP|HEADWAY|ALMA ?HEALTH|SONDERMIND|\bLCSW\b|\bLMFT\b/, "MENTAL_HEALTH", "LIKELY", "mental health care"],
  [/LABCORP|QUEST DIAG|\bLAB(S|ORATOR)|DIAGNOSTIC/, "MEDICAL", "LIKELY", "lab work"],
  [/HEARING|AUDIOLOG|CPAP|DME\b|DURABLE MEDICAL|MEDICAL SUPPL|\bBRACE\b|CRUTCH|GLUCOSE|DEXCOM|OMNIPOD|BLOOD PRESSURE/, "EQUIPMENT", "LIKELY", "medical equipment or supplies"],
  [/PRESCRIPTION|\bRX\b|PHARMACY ?RX|EXPRESS SCRIPTS|CAREMARK|OPTUM ?RX|ALTO PHARM|CAPSULE|PILLPACK|AMAZON PHARM|COST PLUS DRUG|GOODRX|HONEYBEE|BLINK HEALTH/, "PHARMACY", "LIKELY", "prescriptions"],
  [/PHYSICIAN|DOCTOR|^DR\.? [A-Z]|\bDR\. ?[A-Z]|\bM\.?D\.?\b|\bMD ?PC\b|MEDICAL|CLINIC|PEDIATRIC|DERMATOLOG|ALLERG|CARDIOLOG|GASTRO|NEUROLOG|ONCOLOG|UROLOG|ENDOCRIN|RHEUMATOL|PULMON|NEPHROL|\bENT\b|EAR NOSE|OTOLARYNG|INTERNAL MED|FAMILY MED|PRIMARY CARE|HEALTHCARE|HEALTH CARE|PATIENT ?PAY|PATIENT ?PMT|INSTAMED|PAYMENTUS ?MED|MYCHART|ONE MEDICAL|FORWARD HEALTH|TELADOC|AMWELL|MDLIVE|NURSE|PRACTITIONER|\bNP\b|\bPA-?C\b|PHYS(ICIANS)? GRP|MED GRP|MEDICAL GROUP|ASSOC(IATES)? PC|HEALTH ?PARTNERS/, "MEDICAL", "LIKELY", "doctor or clinic"],
  [/\bCVS\b|CVS\/|CVS PHARM|WALGREEN|DUANE READE|RITE ?AID|PHARMAC|FARMACIA|DRUG ?STORE|DRUGSTORE|APOTHECARY|CHEMIST|SHOPPERS DRUG/, "PHARMACY", "CHECK", "drug store: keep the receipt for the medical items"],
];

/**
 * Judge a payee (and any industry line) as an HSA-qualified expense. `ownerHealth`: the
 * owner filed this merchant under Health & insurance by hand, which is worth a look even
 * when the name says nothing (a doctor's practice billing under their own name).
 */
export function qualifyPayee(payee: string, detail?: string | null, ownerHealth = false): Qualification | null {
  const text = `${payee} ${detail ?? ""}`.toUpperCase();
  if (NOT_QUALIFIED.test(text)) return null;
  for (const [re, kind, tier, reason] of RULES) if (re.test(text)) return { tier, kind, reason };
  return ownerHealth ? { tier: "CHECK", kind: "MEDICAL", reason: "you filed this merchant under Health & insurance" } : null;
}

/** Best guess at the kind of expense from a free-text note ("PT session and knee x-rays"). */
export function guessKind(text: string): ExpenseKind {
  const t = text.toUpperCase();
  if (/X-?RAY|\bER\b|EMERGENCY|SURGERY|SURGEON|HOSPITAL(?!ITY)|ANESTHES|\bMRI\b|\bCT SCAN/.test(t)) return "HOSPITAL";
  if (/\bEYES?\b|GLASSES|CONTACT LENS/.test(t)) return "VISION";
  if (/EPI ?PEN|EPIPEN|SLEEP(ING)? AID|NASAL STRIP|\bOTC\b|MEDICINE|ALLERGY PILL/.test(t)) return "PHARMACY";
  return qualifyPayee(text)?.kind ?? "MEDICAL";
}
