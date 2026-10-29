/**
 * What a private fund's own paperwork says about the household's stake: capital call
 * notices (plain calls, equalisation calls, the ILPA template version of either) and the
 * quarterly capital statement. Amounts in cents, as the manager prints them (whole dollars
 * on most notices).
 */

/** Where a figure was read from: the stored document. */
export type FundSource = { documentId: string; title: string };

/** The manager's own commitment summary printed under a call ("After this Contribution…"). */
export type PrintedCommitment = {
  commitmentCents: number | null;
  priorContributionsCents: number | null;
  /** As the manager prints it (≥ 0): its "Distributions – Inception to Date". */
  priorDistributionsCents: number | null;
  /** Net of any returned contribution: what this notice adds to contributions to date. */
  currentContributionCents: number | null;
  unfundedCents: number | null;
};

export type FundCall = {
  kind: "CALL";
  /** "letter": the manager's notice; "ilpa": the ILPA Capital Call & Distribution Template. */
  format: "letter" | "ilpa";
  fund: string;
  /** The investor number the administrator prints (also the capital account's number). */
  investorId: string | null;
  issued: string;
  due: string | null;
  /** An equalisation call: a later close returned part of earlier contributions. */
  equalisation: boolean;
  /** Called under the drawdown clause, before anything is returned. */
  contributionCents: number;
  /** Contribution handed back at a later close: a distribution that is added back to unfunded (recallable). */
  returnedCents: number;
  /** Interest paid on the returned contribution by the later investors: income. */
  interestCents: number;
  /** What had to be wired (contribution − returned − interest); never below 0. */
  netDueCents: number;
  printed: PrintedCommitment | null;
};

export type FundStatement = {
  kind: "STATEMENT";
  fund: string;
  investorId: string | null;
  asOf: string;
  /** Capital account at the date (net asset value of the stake). */
  endingCapitalCents: number;
  /** Inception-to-date column. */
  itd: { contributionsCents: number; distributionsCents: number; incomeCents: number; managementFeeCents: number; carryCents: number };
  commitmentCents: number | null;
  remainingCommitmentCents: number | null;
};

export type FundDoc = FundCall | FundStatement;

export type FundFileEntry = {
  /** The stored file's hash: a replaced file is read again. */
  sha: string;
  version: number;
  /** null: a fund document this reader doesn't use (letters, audited accounts). */
  doc: FundDoc | null;
  error?: string;
};

/** data/fund-documents.json: each fund document read once, by document id. */
export type FundDocsFile = { version: 1; files: Record<string, FundFileEntry> };
