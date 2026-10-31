/**
 * The Book: the household's single source of truth. One loader (loadBook) reads every
 * stored fact — committed statements and their rows, pay stubs with every line item,
 * brokerage tax figures, transfer pairings — runs every integrity check over them, and
 * hands the result to every module (dashboard, cash flow, net worth, profile, outlook,
 * taxes). No module reads ledger tables on its own, so no two pages can disagree.
 *
 * A check either passes, fails (the data contradicts itself: a parser bug, a misread
 * statement, a transfer that doesn't pair), or reports missing data (a statement or
 * stub that isn't on file). A number that depends on a failing or missing fact is never
 * shown; the module shows the finding instead, with what to fetch or fix.
 */

export type CheckId =
  | "data.readable"
  | "ledger.consistency"
  | "ledger.freshness"
  | "statement.held"
  | "statement.chain"
  | "statement.gap"
  | "statement.overdue"
  | "statement.history"
  | "transfer.unmatched"
  | "transfer.decisions"
  | "paystub.arithmetic"
  | "paystub.person"
  | "paystub.deposit"
  | "pay.continuity"
  | "pay.after-last-stub"
  | "pay.deposits-tie"
  | "pay.unexplained-deposits"
  | "pay.year-gap"
  | "retirement.contributions"
  | "contributions.hsa"
  | "contributions.custodian"
  | "holdings.ties"
  | "bonus.letters"
  | "tax.brokerage-coverage"
  | "tax.params"
  | "tax.documents-tie"
  | "networth.reconciles";

export type CheckDef = { id: CheckId; title: string; description: string };

export type FindingStatus = "FAIL" | "MISSING";

/** Which data a finding makes unprovable: blockers are looked up by these. */
export type FindingScope = {
  /** Account whose figures are affected (null: household-wide). */
  accountId?: string;
  personId?: string;
  employerKey?: string;
  /** Inclusive YYYY-MM-DD range the finding affects. */
  from: string;
  to: string;
  /**
   * Which kinds of figures it blocks. HOLDINGS: an investment account's positions (not its
   * balance); BONUS: what a bonus letter says (not the pay the stubs show).
   */
  affects: ("CASH_FLOW" | "NET_WORTH" | "PAY" | "TAX" | "HOLDINGS" | "BONUS")[];
};

export type Finding = {
  /**
   * Stable across runs and across database rebuilds (same problem → same id): built from
   * what the problem is about in the real world (an account's number, a statement period,
   * an employer's pay date and net pay), never from database row ids. See findingKeys.ts.
   */
  id: string;
  /**
   * Every identifier of the account the finding is about (INSTITUTION#identifier), so an
   * exception still matches after the account is reissued under a new number.
   */
  accounts?: string[];
  check: CheckId;
  status: FindingStatus;
  title: string;
  detail: string;
  /** What to do about it, in plain words. */
  fix: string;
  scope: FindingScope;
  /** Further windows it blocks, for kinds of figures whose window differs (see statement.history). */
  extraScopes?: FindingScope[];
  /** The day the problem is about, when narrower than its window (a transfer's date). Defaults to the window's start. */
  date?: string;
  /**
   * The statement that would settle it: one covering [from, to] for any of these
   * accounts (a transfer's other leg could be on any of them). Absent when no statement
   * would (a contradiction, a pay stub). Drives the statement plan (reports/statementPlan.ts).
   */
  needs?: { accountIds: string[]; from: string; to: string };
  /**
   * Past the data edge: the problem starts after the last day every open account has a
   * statement for (Book.horizon.netWorth), so it's most likely a statement that hasn't
   * arrived yet. Pages stop at the edge, so these never withhold a figure that's shown;
   * Statements → Issues lists them apart, as what's awaited.
   */
  atEdge?: boolean;
};

/**
 * What one passing check covered, so a figure can show the checks behind it (book/proof)
 * rather than only that nothing failed. `subject` names the thing in plain words (a
 * statement period, a pay stub, a month), never by database id; `scope` is what its
 * failure would have blocked, so passes are looked up exactly like blockers.
 */
export type CheckPass = { check: CheckId; n: number; subject: string; scope: FindingScope };

/** The evidence a check passes with: what it covered and the scope it vouches for. */
export type PassEvidence = FindingScope & { subject: string };

/** A figure that was inferred rather than read directly, and from what. */
export type Inference = {
  /** Stable across runs and database rebuilds, like a finding's id (see findingKeys.ts). */
  id: string;
  check: CheckId;
  /** Ledger rows it concerns, for other checks in the same run (database ids: never part of `id`). */
  rowIds?: string[];
  title: string;
  detail: string;
  /**
   * Partial: the figure stands on one source only (e.g. pay before the first available
   * stub, from its year-to-date totals). Shown, but labelled partial wherever it appears.
   */
  partial?: boolean;
  scope?: Pick<FindingScope, "personId" | "employerKey" | "from" | "to"> & { accountId?: string };
};

/** `failed` and `missing` count findings inside the data edge; `awaiting`, those past it (statements still on their way). */
export type CheckResult = CheckDef & { passed: number; failed: number; missing: number; awaiting: number; inferred: number; accepted: number };

/** An open finding an exception covers; `exceptionId` is the exception's own id (they differ after an account is reissued). */
export type AcceptedFinding = Finding & { exceptionId: string; note: string; acceptedAt: string };

/**
 * A finding the owner explained by hand, kept in the permanent exceptions file (outside
 * the database, so it survives a wipe or rebuild). Holds a copy of the finding as it was
 * when accepted, so it still reads correctly when the finding no longer arises.
 */
export type StandingException = {
  id: string;
  check: CheckId;
  accounts?: string[];
  note: string;
  acceptedAt: string;
  finding: Pick<Finding, "status" | "title" | "detail" | "scope">;
};

/** An exception the owner retired, with why. Kept forever; it no longer applies. */
export type RetiredException = StandingException & { retiredAt: string; reason: string };

/**
 * An exception whose finding no longer arises. It isn't removed: the owner reviews the
 * evidence (what changed since it was accepted) and approves retiring it, or keeps it.
 */
export type StaleException = StandingException & { evidence: string[] };

export type IntegrityReport = {
  checks: CheckResult[];
  /** Open findings: each blocks the figures in its scope. */
  findings: Finding[];
  inferences: Inference[];
  /** Findings the owner explained by hand: listed, never blocking. */
  accepted: AcceptedFinding[];
  /** Exceptions whose finding no longer arises, awaiting the owner's review. */
  stale: StaleException[];
  /** Exceptions the owner retired, with the reason. */
  retired: RetiredException[];
};

export const CHECKS: CheckDef[] = [
  {
    id: "data.readable",
    title: "Your saved settings and files can be read",
    description:
      "The tax profile, profile settings, tax documents scan and reimbursement links are read as saved. A damaged one is never replaced by defaults or left out quietly: it withholds every figure it could change until it's restored.",
  },
  {
    id: "ledger.consistency",
    title: "The ledger agrees with itself",
    description:
      "Every statement segment ties, no day of an account is counted twice, each account's rows book the same amounts month by month as its statement timeline (so cash flow and net worth can't disagree), and every transfer pairing and pay-stub link points at the right rows. A failure is a bug in the app, not in your documents.",
  },
  {
    id: "ledger.freshness",
    title: "Everything was read by the current code",
    description:
      "Every document was read by the current version of its parser, pay stub and tax figures by the current extractor, the tax documents folder (W-2s, 1099s, K-1s, filed returns) by the current tax documents reader, and every transaction filed by the current classification rules — so no figure comes from code the app has since corrected.",
  },
  {
    id: "statement.held",
    title: "Every statement reconciles",
    description: "Opening balance + every row + market change + fees = closing balance, to the cent. Statements that don't are held out of the ledger.",
  },
  {
    id: "statement.chain",
    title: "Statements chain",
    description: "Each statement's opening balance equals the previous statement's closing balance.",
  },
  {
    id: "statement.gap",
    title: "No gaps between statements",
    description: "Every day between an account's first and last statement is covered — or provably empty (zero balance on both sides and no money moved to the account in between).",
  },
  {
    id: "statement.overdue",
    title: "Statements are current",
    description: "Every open account has its latest statement on file.",
  },
  {
    id: "statement.history",
    title: "Account history is complete",
    description: "An account whose first statement already holds money has earlier history that isn't on file.",
  },
  {
    id: "transfer.unmatched",
    title: "Every transfer pairs",
    description: "Money moved between the household's own accounts appears on both accounts' statements and pairs up.",
  },
  {
    id: "transfer.decisions",
    title: "Your transfer decisions are in force",
    description: "Every pairing you confirmed by hand is paired in the ledger, and none you rejected is — even after statements are re-imported or the database is rebuilt.",
  },
  {
    id: "paystub.arithmetic",
    title: "Pay stubs add up",
    description: "Each stub's line items equal its printed totals, and gross pay − everything withheld = net pay, this period and year to date.",
  },
  {
    id: "paystub.person",
    title: "Pay stubs belong to the household",
    description: "Each stub's employee matches a household member.",
  },
  {
    id: "paystub.deposit",
    title: "Every paycheck reached the bank",
    description: "Each stub's net pay is a deposit on a bank statement.",
  },
  {
    id: "pay.continuity",
    title: "No pay stubs missing mid-year",
    description: "Year-to-date totals carry from stub to stub; a jump must be explained by paychecks deposited in between (then their totals are inferred from the year-to-date figures and the deposits).",
  },
  {
    id: "pay.after-last-stub",
    title: "Each year's last stub is on file",
    description: "No paycheck from the employer was deposited after the latest stub of the year.",
  },
  {
    id: "pay.deposits-tie",
    title: "Year-to-date net pay ties to deposits",
    description: "The latest stub's year-to-date net pay equals every paycheck the bank received from that employer that year.",
  },
  {
    id: "pay.unexplained-deposits",
    title: "Every paycheck has a stub",
    description: "Every deposit categorized as a paycheck is explained by a pay stub (or inferred from the stubs around it and the deposits).",
  },
  {
    id: "pay.year-gap",
    title: "No missing years of pay",
    description: "Between the first and last year an employer paid someone, every year has stubs on file (a year without them is unknown pay, not zero).",
  },
  {
    id: "retirement.contributions",
    title: "401(k) contributions tie to pay stubs",
    description: "Employee deferrals and employer money on the stubs equal the contributions on the 401(k) statements.",
  },
  {
    id: "contributions.hsa",
    title: "HSA contributions tie to pay stubs",
    description: "Payroll HSA money on the stubs (yours and your employer's) equals what the HSA statements show arriving from payroll, statement period by statement period.",
  },
  {
    id: "contributions.custodian",
    title: "Contributions the custodian reports tie to the ledger",
    description: "Each IRA and 529 statement's contributions-this-year line equals the deposits the ledger shows going into the account that year.",
  },
  {
    id: "holdings.ties",
    title: "Positions add up to the balance",
    description: "Every statement's list of positions adds up to the account's balance on that day (and to the total the statement prints), to the cent. A list that doesn't is a misread statement: its positions aren't used.",
  },
  {
    id: "bonus.letters",
    title: "Bonus letters agree with themselves and the pay stubs",
    description:
      "Each letter's parts add up to the bonus and total pay it states, its base salary matches the stubs, and every payment it scheduled is on the stubs at the amount it states. The stubs are what counts as pay, so a disagreement withholds nothing: the Bonuses page shows the letter and the stubs side by side with the warning, until the letter is corrected or the gap accepted with a note.",
  },
  {
    id: "networth.reconciles",
    title: "Each month's net worth reconciles",
    description:
      "For every month with nothing missing: opening net worth + income − spending + outside money + retirement contributions + market change = closing net worth, with nothing left unexplained and transfers netting to zero (except money in flight across the month's edges). A month whose edge falls inside a quarterly statement passes for the money moved; its month-end value stays an estimate (the quarter's market change spread across its months).",
  },
  {
    id: "tax.brokerage-coverage",
    title: "Investment income is on file",
    description: "Every taxable investment account has its year's tax figures (dividends, interest, gains) on file.",
  },
  {
    id: "tax.documents-tie",
    title: "Tax documents agree with the ledger",
    description:
      "Every finished year's W-2 boxes equal what its pay stubs add up to, each 1099's dividends, interest and gains equal the statements' figures, each 1099-INT equals the bank's interest rows, and the filed return's estimated payments, balance and refund equal what the bank paid or received — to the dollar. A document the ledger can't corroborate (no stubs or statements for it) is missing data.",
  },
  {
    id: "tax.params",
    title: "This year's tax law is in the app",
    description: "The federal and Connecticut brackets, deductions, credits and limits for this year and last year are in the app, so neither is estimated with another year's law.",
  },
];
