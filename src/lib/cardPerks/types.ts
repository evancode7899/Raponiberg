import type { Cadence, CardProduct, Program, RewardKind } from "./catalog.ts";
import type { RewardsSnapshot } from "./rewardsText.ts";

/** The ledger row fields the Card perks page reads. */
export type PerkRow = {
  id: string;
  date: string;
  amountCents: number;
  lane: string | null;
  accountId: string;
  payee: string;
  detail?: string | null;
  section?: string | null;
  category: string;
  classifiedBy: string | null;
  /** The statement the row was read from. */
  statementId: string;
};

export type CardStatement = { id: string; start: string; end: string };

export type CardAccount = {
  id: string;
  name: string;
  institution: string | null;
  /** The owner says it's closed (or it's archived): no periods after its last statement. */
  closed?: boolean;
  /** The issuer sends no statement for a cycle without activity: a quiet stretch isn't a closed card. */
  skipsIdle?: boolean;
  /** Committed statements, oldest first. */
  statements: CardStatement[];
};

/** A statement's printed rewards summary, with the card and statement it came from. */
export type StatementRewards = RewardsSnapshot & { accountId: string; statementId: string; statementEnd: string };

export type PeriodStatus =
  /** Fully used. */
  | "USED"
  /** Over, and only part of it was used. */
  | "PARTIAL"
  /** Over, statements in, nothing used. */
  | "MISSED"
  /** Under way: still can be used. */
  | "OPEN"
  /** Over, but the statement that would show it isn't in yet. */
  | "AWAITING"
  | "FUTURE"
  /** Before the card's first statement or after it was closed. */
  | "NOT_HELD"
  /** The card didn't offer it then (added or dropped by the issuer). */
  | "NOT_OFFERED";

/** How a period's use was found. */
export type Evidence = {
  rowId: string;
  date: string;
  payee: string;
  amountCents: number;
  /** CREDIT: the perk's statement credit. MERCHANT: a credit from a merchant it pays for. SPEND: a charge that uses an in-app perk. */
  kind: "CREDIT" | "MERCHANT" | "SPEND";
  /** The card the row is on (an in-app perk's charge can be on another card). */
  accountId: string;
};

export type PerkPeriod = {
  key: string;
  label: string;
  start: string;
  end: string;
  allowanceCents: number;
  usedCents: number;
  status: PeriodStatus;
  evidence: Evidence[];
  /** Charges at the perk's merchants on this card with no credit: maybe not enrolled. */
  unmatchedSpend: number;
};

export type PerkLine = {
  id: string;
  name: string;
  cadence: Cadence;
  amountCents: number;
  how: string;
  detection: "CREDIT" | "IN_APP";
  periods: PerkPeriod[];
  /** Over the periods the card held and offered it. */
  allowanceCents: number;
  usedCents: number;
  missedCents: number;
  remainingCents: number;
  /** Unused in every period decided so far this year: a perk the household doesn't use, not one it forgot. */
  neverUsed: boolean;
};

export type CreditKind = "PERK" | "OFFER" | "REDEMPTION" | "FEE_REVERSAL";
export type CreditRow = { id: string; date: string; payee: string; amountCents: number; kind: CreditKind; perkId: string | null };

export type EarnLine = { id: string; label: string; rate: number; spendCents: number; units: number; capped: boolean };

/** One stretch between two printed rewards balances. */
export type Reconciliation = {
  from: string;
  to: string;
  opening: number;
  closing: number;
  /** What the pool's spending in the stretch should have earned. */
  expected: number;
  /** What posted: printed (Chase, Capital One), else the balances' rise plus known redemptions, else the estimate. */
  posted: number;
  redeemed: number;
  /** posted − expected: welcome offers and bonuses when positive. */
  difference: number;
  /** printed: the statement says. balances: from the balances. inferred: the balance fell, so the redemption is what's left over. */
  basis: "PRINTED" | "BALANCES" | "INFERRED";
  /** The statements whose cycles posted in the stretch, and the one that printed the closing balance. */
  statementIds: string[];
  closingStatementId: string;
  /** Redemption credits on the statements in the stretch. */
  redemptionRowIds: string[];
};

export type RewardsPool = {
  key: string;
  program: Program;
  centsPerPoint: number;
  accountIds: string[];
  /** Printed balances, oldest first (one per date). */
  balances: { date: string; balance: number; statementId: string; accountId: string }[];
  stretches: Reconciliation[];
  /** The report year's stretches added up. */
  year: { posted: number; expected: number; redeemed: number };
};

export type CardRewards = {
  kind: RewardKind;
  /** Expected from this year's spending (points, or cents of cash back). */
  expected: number;
  /** Best figure for the year: posted where the statements show it, the estimate elsewhere. */
  earned: number;
  /** Of `earned`, the part the statements printed or proved. */
  fromStatements: number;
  source: "STATEMENTS" | "MIXED" | "ESTIMATE" | "NONE";
  valueCents: number;
  /** Rewards cashed in as statement credits this year (already counted when earned). */
  redeemedCents: number;
  /** The latest printed balance. */
  balance: { value: number; date: string; statementId: string } | null;
};

export type CardScore = {
  accountId: string;
  accountName: string;
  last4: string | null;
  product: CardProduct | null;
  /** AUTO: the account name says. CHOSEN: picked on Setup. UNKNOWN: no catalog entry. */
  productSource: "AUTO" | "CHOSEN" | "UNKNOWN";
  program: Program;
  centsPerPoint: number;
  held: { from: string; through: string; open: boolean };
  /** Statements on file closing in the year (0: an idle year). */
  statementsInYear: number;
  spend: { chargesCents: number; refundsCents: number; netCents: number };
  earn: EarnLine[];
  /** Earn rules the statements can't show (portal bookings), for the page to name. */
  hiddenEarn: string[];
  rewards: CardRewards;
  perks: PerkLine[];
  credits: CreditRow[];
  fee: { cents: number; rows: { id: string; date: string; amountCents: number }[]; termsCents: number; nextDue: string | null };
  perksValueCents: number;
  /** What the perks offered over the periods the card held them. */
  perksAllowanceCents: number;
  offersCents: number;
  /** Rewards value + perks + offers − fee. */
  netCents: number;
  remainingCents: number;
  missedCents: number;
  /** Perk value used over what the held periods offered (null: no perks). */
  captureRate: number | null;
  /** The last twelve months to the latest statement: what the card gave against the fee it charged, for keep-or-cancel. */
  trailing: { from: string; to: string; valueCents: number; feeCents: number } | null;
};

export type ActItem = { accountId: string; perkId: string; name: string; card: string; leftCents: number; ends: string; daysLeft: number; how: string; neverUsed: boolean };

export type SpendType = { key: string; label: string };

export type OptimizerLine = {
  key: string;
  label: string;
  spendCents: number;
  actualCents: number;
  bestCents: number;
  /** The held card that would have earned the most on it (null: none earns more than another). */
  best: { accountId: string } | null;
  byCard: { accountId: string; spendCents: number; valueCents: number }[];
};

export type WalletTip = { key: string; label: string; accountId: string; rate: number; centsPerDollar: number; runnerUp: { accountId: string; centsPerDollar: number } | null };

export type CardPerksReport = {
  year: number;
  years: number[];
  today: string;
  cards: CardScore[];
  hidden: { accountId: string; accountName: string }[];
  pools: RewardsPool[];
  act: ActItem[];
  optimizer: { lines: OptimizerLine[]; missedCents: number; spendCents: number; actualCents: number; tips: WalletTip[] };
  /** Expected rewards by what the spending was, in cents of value, largest first. */
  rewardsMix: { label: string; valueCents: number }[];
  totals: {
    feesCents: number;
    rewardsValueCents: number;
    perksValueCents: number;
    offersCents: number;
    netCents: number;
    remainingCents: number;
    missedCents: number;
    spendCents: number;
    captureRate: number | null;
    openPerks: number;
  };
};

