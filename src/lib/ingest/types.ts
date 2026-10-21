import type { AccountTaxSnapshot } from "../tax/facts/investments.ts";
import type { HoldingsFacts } from "./holdings/types.ts";
import type { PayStubFacts } from "./payroll/types.ts";

/**
 * Canonical shape every statement parser (deterministic or hand-parsed JSON) produces.
 * One source file → one ParsedDocument → zero or more account sections. Everything
 * downstream (dedupe, account resolution, classification, transfer matching, the
 * timeline engine) only ever sees this shape, never institution-specific text.
 *
 * Sign conventions (all amounts are integer cents):
 * - Balances are signed from the household's point of view: assets positive, debts
 *   negative. A credit card owing $500 has balance -50000; a card in credit is positive.
 * - Transaction amounts are the change they cause to that balance: deposits/payments
 *   received are positive, purchases/withdrawals negative.
 */

export type DocumentKind =
  /** Periodic statement with balances (bank, card, brokerage, retirement). */
  | "STATEMENT"
  /** Multi-month recap (Fidelity year-end report). Only fills gaps; never double-counts. */
  | "PERIOD_SUMMARY"
  /** Payroll stub — enrichment for an income deposit, never its own cash flow. */
  | "PAYSTUB"
  /** Letters, confirmations, tax forms, year-end spend summaries: kept, never counted. */
  | "SUPPORTING";

export type AccountKind = "CHECKING" | "SAVINGS" | "CREDIT_CARD" | "INVESTMENT" | "OTHER";

/** Finer account flavor; drives display grouping and some classification defaults. */
export type AccountSubtype =
  | "CHECKING"
  | "SAVINGS"
  | "CREDIT_CARD"
  | "BROKERAGE"
  | "ROTH_IRA"
  | "TRADITIONAL_IRA"
  | "ROLLOVER_IRA"
  | "401K"
  | "529"
  | "HSA"
  /** A landlord's bill account (Yardi): its charges are spending and paying it is a transfer, like a card. */
  | "BILL"
  | "OTHER";

/**
 * EXACT: the transaction happened on `date`.
 * PERIOD: the statement only reports a total for its whole period (e.g. quarterly 401k
 * "Payroll Contributions"); `date` is the period end and the amount is spread evenly
 * across the period wherever a sub-period view needs it.
 */
export type DatePrecision = "EXACT" | "PERIOD";

export type ParsedTransaction = {
  /** YYYY-MM-DD */
  date: string;
  datePrecision: DatePrecision;
  description: string;
  amountCents: number;
  /**
   * Which part of the statement the row came from ("Payments", "Credits", "Deposits",
   * "Exchanges Out", "Employer contributions", ...). Strong classification signal.
   */
  section?: string;
  /** Extra free-text from the statement (Amex merchant category line, check number...). */
  detail?: string;
  /** Cardmember / sub-card label when a statement splits activity by person. */
  cardMember?: string;
};

export type ParsedAccountSection = {
  institution: string;
  /** Institution's identifier for the account, normalized (e.g. "X00-000001", "1234"). */
  accountNumber: string;
  /** Human label from the statement, e.g. "FIDELITY ROTH IRA". */
  accountName: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  /** YYYY-MM-DD, inclusive. */
  periodStart: string;
  periodEnd: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  /**
   * Market change for valuation accounts (price moves, dividends, interest), excluding
   * fees. Zero for bank/card accounts, whose interest/fees are ordinary transactions.
   */
  growthCents: number;
  /** Advisory/fund/admin fees deducted inside a valuation account (≤ 0). */
  feesCents: number;
  transactions: ParsedTransaction[];
  /**
   * True when this section is a multi-period recap (e.g. a 401(k) statement's year-to-date
   * column) rather than a statement of its own. Recaps only fill gaps in the timeline.
   * Defaults to whether the whole document is a PERIOD_SUMMARY.
   */
  isSummary?: boolean;
  /**
   * The statement doesn't print the opening value of holdings it reports at close (an HSA
   * that invests in a fund). At commit the opening is taken from the account's previous
   * statement and growth is re-derived from the balances; with no adjacent previous
   * statement the section is held for review instead of guessing.
   */
  openingFromPrior?: boolean;
  /**
   * The printed period may start before activity the statement actually lists (Vanguard's
   * quarter-end statement opens at the quarter's start value but only lists activity since
   * the account's last monthly statement). At commit, if an imported statement for the
   * account ends inside this period, the section starts the day after it and opens at its
   * closing value; growth is re-derived from the balances.
   */
  startsAfterPrior?: boolean;
  /**
   * A bill that lists what's owed but not what was paid (Yardi's rent bill prints only
   * open charges). At commit, against the account's previous bill: the period starts the
   * day after it, the opening is its closing, charges it already listed are dropped, and
   * one PERIOD row ("Payments and credits") explains the rest of the change. An account's
   * first bill covers only its own last day, owing nothing before it.
   */
  paymentsFromPrior?: boolean;
  /**
   * The statement doesn't print its market change: growth is what the balances leave
   * after the listed flows, so a flow the parser missed would hide in it. Stored with the
   * statement (a derived entry in its checks) and listed as an inference on every figure
   * that uses the account (book/checks/statements.ts). Set at commit too, wherever the
   * opening or the period is re-derived from the previous statement.
   */
  growthFromBalances?: boolean;
  /**
   * Statement-printed subtotals the parser could cross-check its rows against. Each is
   * shown on review and any mismatch blocks auto-commit.
   */
  checks: ParsedCheck[];
};

export type ParsedCheck = {
  label: string;
  expectedCents: number;
  actualCents: number;
  /**
   * Allowed |expected − actual|. Zero except where a provider's own printed figures
   * don't add up (rounding in their summary); balances stay exact regardless.
   */
  toleranceCents?: number;
  /** Not a printed total: a marker that the figure was derived (growthFromBalances). Always "passes". */
  derived?: boolean;
};

export type { PayStubFacts } from "./payroll/types.ts";
export type { HoldingsFacts } from "./holdings/types.ts";

/** A brokerage statement's tax figures for one account (see tax/facts/investments.ts). */
export type BrokerageFacts = AccountTaxSnapshot & { isChet: boolean };

export type ParsedDocument = {
  parserId: string;
  parserVersion: number;
  institution: string;
  kind: DocumentKind;
  /** Short human label ("Chase checking statement", "Fidelity year-end report"). */
  title: string;
  /** YYYY-MM-DD; null for undated supporting docs. */
  periodStart: string | null;
  periodEnd: string | null;
  sections: ParsedAccountSection[];
  /** A payroll PDF can hold several stubs, and the same stub can recur across files. */
  payStubs?: PayStubFacts[];
  /** Tax figures per account, for brokerage statements that print them. */
  brokerageFacts?: BrokerageFacts[];
  /** Positions held at the period end, per account, for statements that list them. */
  holdings?: HoldingsFacts[];
  /** Parser notes surfaced during review (format oddities, recovered values). */
  warnings: string[];
};
