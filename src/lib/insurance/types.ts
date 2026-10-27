/**
 * Life insurance documents found in the statements folder: the policy packet (the
 * contract, its schedule and its table of premiums) and the insurer's billing notices,
 * payment receipts and policy summaries.
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

export type InsuranceDoc = TermPolicy | BillingNotice | PaymentReceipt | PolicyStatus;

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
