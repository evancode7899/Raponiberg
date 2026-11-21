/**
 * Health coverage documents: the insurer's Explanation of Benefits (EOB) statements, read
 * from the statements folder, and the plan's own terms (data/medical-plans.json, written in
 * chat from the plan documents: lib/medical/plans.ts).
 *
 * Medical is read today. Dental and vision are the same shape (an EOB lists claims, each
 * claim its service lines, and the statement the year's deductible and out-of-pocket
 * balances), so their readers only add a parser: until one exists a dental or vision EOB
 * found in the folder is remembered as waiting for its reader, and the page says so.
 *
 * Money is integer cents throughout. Each PDF is read once into one of these and kept in
 * data/medical-documents.json (gitignored, backed up with data/).
 */

export const COVERAGES = ["MEDICAL", "DENTAL", "VISION"] as const;
export type Coverage = (typeof COVERAGES)[number];

/** One service line of a claim, its columns as the EOB prints them (blank = 0). */
export type EobLine = {
  /** What was done, as printed ("MANUAL THERAPY"). */
  service: string;
  /** The procedure code (CPT/HCPCS) when printed. */
  code: string | null;
  /** Date of service (a hospital stay's first day). */
  date: string;
  /** A hospital stay's last day, when the line covers several. */
  dateTo: string | null;
  billedCents: number;
  /** The plan's negotiated rate ("member rate"), when the line prints one: blank for a service bundled into another's. */
  memberRateCents: number;
  /** Pending or not payable (the remark says whether you owe it). */
  pendingCents: number;
  deductibleCents: number;
  copayCents: number;
  /** What's left after deductible and copay, which the plan and coinsurance split. */
  remainingCents: number;
  planCents: number;
  coinsuranceCents: number;
  yourShareCents: number;
  /** The remark numbers printed beside the line ("(1)"). */
  remarks: number[];
  /** What the insurer wrote beside the line, when it's words ("Fluorides not covered…", "Denied"). */
  note?: string;
};

/** The totals row of a claim, as printed. */
export type EobTotals = Omit<EobLine, "service" | "code" | "date" | "dateTo" | "remarks" | "note">;

/** Coordination of benefits: another plan paid first, and this is what's really owed. */
export type EobCob = { yourShareCents: number; otherPlanCents: number; planAfterCobCents: number };

export type EobClaim = {
  /** As printed ("EXA12B3CD00"). The last two digits number the claim's versions: 00 first, 01 its first adjustment. */
  id: string;
  /** The claim without its version: an adjustment replaces the earlier version. */
  baseId: string;
  version: number;
  /** First name as printed, and the relationship ("self", "spouse", "daughter"). */
  patient: string;
  relationship: string | null;
  provider: string;
  inNetwork: boolean | null;
  received: string | null;
  lines: EobLine[];
  totals: EobTotals;
  /** On an adjustment: what the plan paid on the earlier version. */
  alreadyPaidCents: number;
  /** Late-payment interest the plan added to the provider's payment. */
  interestCents: number;
  cob: EobCob | null;
  /** The remark texts the claim's lines and footer point to, by number. */
  remarks: Record<number, string>;
};

/** A row of the statement's payment summary: what the plan sent a provider, and what you owe them. */
export type EobPayment = { patient: string; relationship: string | null; provider: string; planCents: number; sentTo: string | null; sentOn: string | null; yourShareCents: number };

/** A deductible, an out-of-pocket limit, or (dental) the most the plan pays in a year. */
export type BalanceKind = "DEDUCTIBLE" | "OUT_OF_POCKET" | "ANNUAL_MAXIMUM";

/** One line of "Your benefit balances to date": a limit, what's used and what's left. */
export type EobBalance = {
  /** A person's first name, or null for the family's balance. */
  person: string | null;
  /** "Medical", "Dental"… as the line names it. */
  benefit: string;
  inNetwork: boolean;
  kind: BalanceKind;
  limitCents: number;
  usedCents: number;
  remainingCents: number;
  /** "*Limit includes both Medical and Pharmacy". */
  includesPharmacy: boolean;
};

export type EobStatement = {
  kind: "EOB";
  coverage: Coverage;
  insurer: string;
  /** The plan's name as the statement prints it. */
  plan: string | null;
  /** The employer the group plan is through. */
  sponsor: string | null;
  group: string | null;
  statementDate: string;
  claims: EobClaim[];
  payments: EobPayment[];
  /** The period the balances run over (the accumulator year). */
  balancesFrom: string | null;
  balancesTo: string | null;
  balances: EobBalance[];
};

/** A dental or vision EOB found before its reader exists: remembered, shown as waiting. */
export type PendingEob = { kind: "PENDING"; coverage: Coverage; insurer: string | null; statementDate: string | null };

/** A plan's own document (summary of benefits, certificate…): noted by the scan, its terms read in chat into data/medical-plans.json. */
export type PlanDocument = { kind: "PLAN_DOC"; coverage: Coverage; title: string; insurer: string | null; periodFrom: string | null; periodTo: string | null };

export type MedicalDoc = EobStatement | PendingEob | PlanDocument;

/** A PDF in the statements folder, as last seen. `doc` is set for health coverage documents; anything else is remembered so it isn't read again. */
export type MedicalFileEntry = {
  /** mtime:size when read, so an unchanged file is skipped without opening it. */
  stamp: string;
  sha: string;
  /** Reader version that read it: a newer reader reads it again. */
  version: number;
  doc?: MedicalDoc;
  /** A health coverage document the reader couldn't make sense of. */
  error?: string;
};

export type MedicalDocsFile = {
  version: 1;
  scannedAt: string;
  /** By path relative to the statements folder ("Insurer/EOBs/statement.pdf"). */
  files: Record<string, MedicalFileEntry>;
};
