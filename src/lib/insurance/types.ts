/**
 * Insurance documents found in the statements folder. Life: the policy packet (the
 * contract, its schedule and its table of premiums) and the insurer's billing notices,
 * payment receipts and policy summaries. Home and auto: each term's declarations page, a
 * renewal letter, and the packet's other pages (the contract, notices) kept for reference.
 * Each PDF is read once into one of these and kept in data/insurance-documents.json
 * (gitignored, backed up with data/), so the Insurance page never touches the PDFs. Money
 * is integer cents throughout.
 */

/** One row of the policy's table of premiums and face amounts. */
export type PremiumYear = {
  /** Policy year, 1 = the year starting on the date of issue. */
  year: number;
  /** The most the insurer can charge for the year (the guaranteed maximum, not a quote). */
  maxPremiumCents: number;
  faceCents: number;
};

export type TermPolicy = {
  kind: "TERM_LIFE";
  /** The issuing company, as the contract names it. */
  insurer: string;
  /** The group it belongs to, when the packet names one. */
  brand: string | null;
  product: string | null;
  policyNumber: string;
  insured: string;
  owner: string | null;
  /** The state whose law governs the contract ("This Is A … Policy"). */
  state: string | null;
  /** Date of issue: policy years and anniversaries count from it. */
  issueDate: string;
  /** Age nearest birthday on the date of issue. */
  issueAge: number | null;
  premiumClass: string | null;
  faceCents: number;
  /** The first annual premium, policy fee included. */
  annualPremiumCents: number;
  policyFeeCents: number | null;
  levelYears: number | null;
  /** Last day premiums are guaranteed level. */
  levelEndDate: string | null;
  /** The day coverage ends for good, renewing every year after the level period. */
  finalEndDate: string | null;
  conversionExpiryDate: string | null;
  /** The contract allows converting on the expiry date itself ("on or before"), not only before it. */
  conversionThroughExpiry: boolean;
  conversionMinFaceCents: number | null;
  /** Renewable, convertible, re-entry, dividends: what the cover page says the policy is. */
  features: { renewable: boolean; convertible: boolean; reEntry: boolean; participating: boolean };
  /** Paying other than yearly, as a share of the annual premium (0.0845 = 8.45% a month). */
  modal: { semiannual: number | null; quarterly: number | null; monthly: number | null };
  schedule: PremiumYear[];
  riders: { name: string; terms: { label: string; value: string }[] }[];
  /** Days after a missed due date before the policy lapses. */
  graceDays: number | null;
  /** Days after delivery to return it for a full refund. */
  freeLookDays: number | null;
  /** Years from issue the insurer may contest a claim over the application. */
  contestableYears: number | null;
  /** Years from issue a suicide pays back only the premiums. */
  suicideYears: number | null;
  /** Rate the insurer guarantees on proceeds left with it (0.0015 = 0.15%). */
  paymentOptionsRate: number | null;
  billing: { frequency: string | null; type: string | null };
  /** Delivery requirements the packet lists (signatures to return), and the date to return them by. */
  requirements: { items: string[]; respondBy: string | null };
  agent: string | null;
  servicePhone: string | null;
  /** The cover letter's date. */
  packetDate: string | null;
};

export type BillingNotice = {
  kind: "BILL";
  insurer: string | null;
  policyNumber: string;
  preparedDate: string | null;
  dueDate: string;
  premiumCents: number;
  /** "Annual", "Monthly"… as printed. */
  mode: string | null;
};

/** The insurer's confirmation of a premium paid (an emailed receipt). */
export type PaymentReceipt = {
  kind: "RECEIPT";
  insurer: string | null;
  policyNumber: string;
  date: string;
  amountCents: number;
  confirmation: string | null;
  /** How it was paid, as printed ("Debit / Credit Card"). */
  method: string | null;
};

/** The insurer's summary of where a policy stands on a day: what's paid and to when. */
export type PolicyStatus = {
  kind: "STATUS";
  insurer: string | null;
  policyNumber: string;
  asOf: string;
  /** Premiums are paid up to (not including) this date. */
  paidToDate: string | null;
  premiumCents: number | null;
  mode: string | null;
};

/**
 * One coverage on a declarations page: its limit (or deductible) as printed, and the amounts
 * read from it. "$25,000/$50,000" → [2_500_000, 5_000_000]; "Additional 5% available" → [].
 */
export type Coverage = {
  /** The coverage's letter on a home policy ("B" for personal property); null when it has none. */
  code: string | null;
  name: string;
  /** What the limit applies to, when printed beside it ("Each Person/Each Occurrence"). */
  per: string | null;
  limit: string;
  limitCents: number[];
  /** "$500 Ded" → 50_000. */
  deductibleCents: number | null;
  /** An additional coverage, included within the policy's limits rather than one of its main coverages. */
  additional: boolean;
};

/**
 * A home policy's declarations (renters, homeowners, condo unit owners): who and where is
 * covered, for which term, the coverages and their limits, the deductible and the premium.
 */
export type PropertyPolicy = {
  kind: "PROPERTY";
  line: "RENTERS" | "HOMEOWNERS" | "CONDO" | "OTHER";
  /** The policy form as printed ("Renters Policy"). */
  form: string;
  insurer: string;
  policyNumber: string;
  namedInsured: string[];
  /** The residence premises, one line each. */
  premises: string[];
  periodStart: string;
  /** Coverage ends at the start of this day (12:01 a.m.). */
  periodEnd: string;
  termMonths: number | null;
  renewal: boolean;
  /** The term renews by itself unless either side ends it. */
  autoRenews: boolean;
  annualPremiumCents: number;
  totalPremiumCents: number;
  discounts: string[];
  /** Section I (property) and Section II (liability) coverages. */
  property: Coverage[];
  liability: Coverage[];
  deductibles: { name: string; cents: number | null; text: string }[];
  lossSettlement: string[];
  forms: { code: string; name: string; isNew: boolean }[];
  inflationIndex: string | null;
  /** How the premium is paid ("Billed through SFPP"), and what the declarations say is due now. */
  billing: string | null;
  amountDue: string | null;
  agent: { name: string | null; phone: string | null };
  preparedDate: string | null;
};

/** One vehicle on an auto policy. */
export type InsuredVehicle = { n: number; year: number | null; make: string; vin: string | null; garaged: string | null; lienholder: string | null };

/** An auto coverage, with its premium for each vehicle (null where the vehicle has none). */
export type AutoCoverage = Coverage & { premiumCents: (number | null)[] };

/** An auto policy's declarations page for one term. */
export type AutoPolicy = {
  kind: "AUTO";
  insurer: string;
  policyNumber: string;
  namedInsured: string[];
  drivers: string[];
  issuedDate: string | null;
  periodStart: string;
  periodEnd: string;
  termMonths: number;
  /** A renewal packet's page, not a new policy's. */
  renewal: boolean;
  termPremiumCents: number;
  vehicles: InsuredVehicle[];
  coverages: AutoCoverage[];
  discounts: { name: string; cents: number | null }[];
  discountTotalCents: number | null;
  contractType: string | null;
  amendments: string | null;
  unitEndorsements: string | null;
  servicePhone: string | null;
};

/** An auto insurer's renewal letter: the new term and premium, and the one it replaces. */
export type AutoRenewal = {
  kind: "AUTO_RENEWAL";
  insurer: string;
  policyNumber: string;
  date: string | null;
  periodStart: string;
  periodEnd: string;
  newPremiumCents: number;
  priorPremiumCents: number | null;
};

/** A page of a policy packet kept for reference: the contract, a notice, an endorsement. */
export type PolicyForm = {
  kind: "FORM";
  insurer: string;
  line: "HOME" | "AUTO";
  policyNumber: string | null;
  /** The form's code as printed in its corner ("A30CT", "M-308"). */
  code: string | null;
  title: string;
};

export type InsuranceDoc = TermPolicy | BillingNotice | PaymentReceipt | PolicyStatus | PropertyPolicy | AutoPolicy | AutoRenewal | PolicyForm;

/** A PDF in the statements folder, as last seen. `doc` is set for insurance documents; anything else is remembered so it isn't read again. */
export type InsuranceFileEntry = {
  /** mtime:size when read, so an unchanged file is skipped without opening it. */
  stamp: string;
  sha: string;
  /** Reader version that read it: a newer reader reads it again. */
  version: number;
  doc?: InsuranceDoc;
  /** An insurance document the reader couldn't make sense of. */
  error?: string;
};

export type InsuranceDocsFile = {
  version: 1;
  scannedAt: string;
  /** By path relative to the statements folder ("Insurer/policy.pdf"). */
  files: Record<string, InsuranceFileEntry>;
};
