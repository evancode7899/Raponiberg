import { NO_HOUSEHOLD, type HouseholdPatterns } from "../household/patterns.ts";
import type { AccountSubtype } from "../ingest/types.ts";
import { categorizeMerchant, merchantKey, squareSmallTicketGuess } from "./merchants.ts";
import { rollupCategory, type Lane } from "./taxonomy.ts";

/**
 * Transaction classifier: decides each row's lane (how it counts) and category (what it
 * was for), plus who the money went to/came from. The counterparty matters as much as
 * the category — "this left checking for one of our own accounts" is what keeps a
 * dollar from being counted twice, and it's what the transfer matcher pairs on.
 *
 * Precedence, most authoritative first:
 *   1. Structure of the statement (a card's Payments section, a 401(k)'s employer
 *      contribution line, a Fidelity "Exchanges Out" row naming the other account).
 *   2. Rules the owner taught by recategorizing (keyed by merchant).
 *   3. System description rules (payroll, taxes, rent, P2P, untracked cards...).
 *   4. Merchant keywords, then Amex's printed industry line.
 *   5. A sign-based fallback, always flagged for review.
 */

export type CounterpartyKind =
  /** One of the household's tracked accounts. */
  | "OWN_ACCOUNT"
  /** Money the household owns but doesn't track (Venmo/Wise balance, a foreign brokerage). */
  | "UNTRACKED_OWN"
  | "PARTNER"
  | "EMPLOYER"
  | "PERSON"
  | "GOVERNMENT"
  | "UNTRACKED_CARD"
  | "MERCHANT"
  | "UNKNOWN";

export type Counterparty = {
  kind: CounterpartyKind;
  /** For OWN_ACCOUNT: institution the other leg should be at, when known. */
  institution?: string;
  /** For OWN_ACCOUNT: account identifier (or suffix) the statement names. */
  accountHint?: string;
  /** For OWN_ACCOUNT: kinds of account the other leg can be in. */
  subtypes?: AccountSubtype[];
};

export type ClassifyInput = {
  institution: string;
  accountSubtype: AccountSubtype;
  section?: string;
  description: string;
  detail?: string;
  amountCents: number;
  /** YYYY-MM-DD */
  date: string;
};

export type UserRule = { merchantKey: string; category: string; lane: Lane | null };

export type ClassifyContext = {
  /** YYYY-MM-DD the household merged finances; partner transfers before it are contributions. */
  mergeDate: string;
  userRules: UserRule[];
  /** The household's names, partner accounts, funds and local merchants (data/household.json); none when omitted. */
  household?: HouseholdPatterns;
};

export type Confidence = "high" | "medium" | "low";

export type Classification = {
  lane: Lane;
  category: string;
  counterparty: Counterparty;
  confidence: Confidence;
  needsReview: boolean;
  /** Which rule decided — shown on review so a wrong call is traceable. */
  ruleId: string;
  merchantKey: string;
};

const DEPOSIT_ACCOUNTS: AccountSubtype[] = ["CHECKING", "SAVINGS", "BROKERAGE"];
const RETIREMENT: AccountSubtype[] = ["401K", "ROLLOVER_IRA", "TRADITIONAL_IRA", "ROTH_IRA"];
const BANK_AND_BROKERAGE: AccountSubtype[] = ["CHECKING", "SAVINGS", "BROKERAGE"];
/** Investment accounts a bank can fund directly. */
const FUNDABLE: AccountSubtype[] = ["BROKERAGE", "ROTH_IRA", "TRADITIONAL_IRA", "ROLLOVER_IRA"];

type Partial = Omit<Classification, "merchantKey">;

export function classifyTransaction(input: ClassifyInput, ctx: ClassifyContext): Classification {
  const h = ctx.household ?? NO_HOUSEHOLD;
  const key = merchantKey(input.description, h.cardholderPrefix);
  const result =
    structural(input, ctx, h) ??
    userRule(input, key, ctx) ??
    systemRule(input, ctx, h) ??
    merchantRule(input, h) ??
    fallback(input);
  return { ...result, category: rollupCategory(result.category), merchantKey: key };
}

// ---------------------------------------------------------------------------
// 1. Statement structure
// ---------------------------------------------------------------------------

const FIDELITY_ACCOUNT = /\b([A-Z0-9]{3}-\d{6})(?:-\d)?\b/;

function partner(i: ClassifyInput, ctx: ClassifyContext, ruleId: string): Partial {
  return {
    lane: "EXTERNAL_TRANSFER",
    category: i.date < ctx.mergeDate ? "Partner contributions (pre-merge)" : "Partner accounts (untracked)",
    counterparty: { kind: "PARTNER" },
    confidence: "high",
    needsReview: false,
    ruleId,
  };
}

function structural(i: ClassifyInput, ctx: ClassifyContext, h: HouseholdPatterns): Partial | null {
  const d = i.description.toUpperCase();
  const section = i.section ?? "";
  const isCard = i.accountSubtype === "CREDIT_CARD";
  const isBank = i.accountSubtype === "CHECKING" || i.accountSubtype === "SAVINGS";

  // Paying a landlord's bill, like paying a card: the bank's rent payments pair with it.
  if (i.accountSubtype === "BILL" && i.amountCents > 0 && /^PAYMENTS?\b/.test(d)) {
    return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", subtypes: ["CHECKING", "SAVINGS"] }, "bill-payment");
  }

  if (!isCard && !isBank && i.institution === "Vanguard" && !/^Employ(ee|er) contributions$/.test(section)) {
    const v = vanguardFlow(i, d, section);
    if (v) return v;
  }

  if (!isCard && !isBank) {
    // A private fund's capital calls arrive by wire from checking, and its distributions
    // go back there: both legs pair with the bank's wire.
    if (h.funds.some((f) => f.institution === i.institution) && /^(Capital contributions|Distributions)$/.test(section)) {
      return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", subtypes: ["CHECKING", "SAVINGS"] }, "fund-capital-flow");
    }
    // Card spending on medical care straight out of the HSA.
    if (i.institution === "HealthEquity" && section === "Withdrawals") {
      return expense("Health & fitness", "hsa-medical-spend", "high");
    }
    // A Trump Account's government seed (the pilot program) is new money for the child;
    // the household's own deposits come from a bank debit card.
    if (i.institution === "Trump Account" && section === "Pilot Program Contribution") {
      return income("Other income", "trump-account-pilot-program", "high");
    }
    if (i.institution === "Trump Account" && section === "Other Contribution") {
      return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", subtypes: ["CHECKING", "SAVINGS"] }, "trump-account-deposit");
    }
    if (section === "Employee contributions") {
      return own("CONTRIBUTION_EMPLOYEE", "Retirement contributions", { kind: "EMPLOYER" }, "retirement-employee-contribution");
    }
    if (section === "Employer contributions") {
      return own("CONTRIBUTION_EMPLOYER", "Retirement contributions", { kind: "EMPLOYER" }, "retirement-employer-contribution");
    }
    // Cash the broker credits or debits outside trading (opening bonuses, adjustments).
    if (section === "Other Activity In") {
      return { ...income("Other income", "investment-other-activity", "medium"), needsReview: true };
    }
    if (section === "Other Activity Out") {
      return { ...expense("Fees & interest", "investment-other-activity", "medium"), needsReview: true };
    }
    const bank = /(JPMORGAN CHASE|CHASE BANK)[^*]*\*+(\d{4})/.exec(d);
    if (bank) {
      return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "Chase", accountHint: bank[2] }, "investment-bank-eft");
    }
    const acct = FIDELITY_ACCOUNT.exec(i.description);
    if (acct && /Exchanges|Contributions|Distributions|Transfer/i.test(section)) {
      return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "Fidelity", accountHint: acct[1] }, "investment-internal-account");
    }
    if (/ROLOVR|ROLLOVER|DIR ROLL|ROLL TO QUAL|QUAL PLN|DEPOSITORY SERVICES/.test(d) || /Transfers/.test(section)) {
      return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", subtypes: RETIREMENT }, "retirement-rollover");
    }
    if (/Withdrawals|Distributions/i.test(section) && RETIREMENT.includes(i.accountSubtype)) {
      // Plan withdrawals here have been rollovers; an unmatched one surfaces on review.
      return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT" }, "retirement-withdrawal");
    }
    if (/Deposits|Withdrawals|Contributions|Distributions|Exchanges/i.test(section)) {
      return {
        lane: "EXTERNAL_TRANSFER",
        category: "Untracked investment accounts",
        counterparty: { kind: "UNKNOWN" },
        confidence: "low",
        needsReview: true,
        ruleId: "investment-unknown-flow",
      };
    }
  }

  if (isCard) {
    if (section === "Payments") {
      // A payment made by the partner from their own money (the bank side shows no
      // matching debit) is partner money entering the books, not an internal transfer.
      if (h.partnerCard?.test(d)) return partner(i, ctx, "card-payment-partner");
      return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", subtypes: DEPOSIT_ACCOUNTS }, "card-payment");
    }
    if (section === "Fees" || section === "Interest") {
      return expense("Fees & interest", "card-fee-interest", "high");
    }
    if (section === "Credits") {
      if (/BILT (HOUSING|RENT)/.test(d)) return expense("Housing", "card-bilt-housing", "high");
      if (/CREDIT|OFFER|REBATE|POINTS|REWARD|BONUS|CASH ?BACK|UBER PASS|STATEMENT CREDIT|PRIME PMTS/.test(d)) {
        return expense("Card perks & rewards", "card-perk-credit", "high");
      }
      const cat = categorizeMerchant(i.description, i.detail, h.merchantRules);
      return cat
        ? expense(cat, "card-merchant-refund", "medium")
        : { ...expense("Uncategorized", "card-refund-unknown", "low"), needsReview: true };
    }
  }
  return null;
}

/**
 * Money moving in or out of a Vanguard brokerage/IRA (the parser keeps only flows; cash
 * sweeps and reinvested dividends never reach here). Journals between the owner's own
 * Vanguard accounts name the other account ("MMF JRL FR XXXX1111"); everything else is
 * an ACH to or from a bank account, which the matcher pairs with the bank's row.
 */
const VANGUARD_ACCOUNT = /XXXX(\d{4})/;
function vanguardFlow(i: ClassifyInput, d: string, section: string): Partial | null {
  const journal = VANGUARD_ACCOUNT.exec(`${d} ${(i.detail ?? "").toUpperCase()}`);
  if (journal) {
    return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "Vanguard", accountHint: journal[1] }, "vanguard-internal-journal");
  }
  if (/rollover|transfer/i.test(section) || /ROLLOVER|ROLOVR|TRSF/.test(d)) {
    return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT" }, "retirement-rollover");
  }
  if (/funds received|funds sent|withdrawal|distribution|contribution|wire|check|ach/i.test(section)) {
    return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", subtypes: BANK_AND_BROKERAGE }, "vanguard-bank-ach");
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Owner-taught rules
// ---------------------------------------------------------------------------

function userRule(i: ClassifyInput, key: string, ctx: ClassifyContext): Partial | null {
  const rule = ctx.userRules.find((r) => r.merchantKey === key);
  if (!rule) return null;
  const lane: Lane = rule.lane ?? (i.amountCents < 0 || i.accountSubtype === "CREDIT_CARD" || i.accountSubtype === "BILL" ? "EXPENSE" : "INCOME");
  return {
    lane,
    category: rule.category,
    counterparty: { kind: lane === "TRANSFER" ? "OWN_ACCOUNT" : "MERCHANT" },
    confidence: "high",
    needsReview: false,
    ruleId: "user-merchant-rule",
  };
}

// ---------------------------------------------------------------------------
// 3. System description rules (mostly bank-side)
// ---------------------------------------------------------------------------

type SystemRule = {
  id: string;
  /** A household pattern (lib/household) when the rule names the household's own people or accounts; none skips the rule. */
  re: RegExp | ((h: HouseholdPatterns) => RegExp | null);
  /** Only for inflows (+) or outflows (−). */
  sign?: "+" | "-";
  /** Restrict to bank accounts (default) or allow cards too. */
  cards?: boolean;
  /** Only for savings accounts (a high-yield savings account's ACH rows are nearly always own-account transfers). */
  savingsOnly?: boolean;
  decide: (i: ClassifyInput, ctx: ClassifyContext, h: HouseholdPatterns) => Partial;
};

/** The fund a capital-call wire went to: the one its wire pattern names, else the household's only fund. */
function fundCapitalCall(i: ClassifyInput, h: HouseholdPatterns): Partial {
  const d = i.description.toUpperCase();
  const fund = h.funds.find((f) => f.wire?.test(d)) ?? (h.funds.length === 1 ? h.funds[0] : undefined);
  return own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: fund?.institution, subtypes: ["OTHER"] }, "bank-fund-capital-call");
}

const SYSTEM_RULES: SystemRule[] = [
  // Own-account transfers named on the bank side.
  { id: "bank-amex-payment", re: /AMERICAN EXPRESS ACH PMT|AMEX EPAYMENT|AMERICAN EXPRESS PMT/, sign: "-",
    decide: () => own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "American Express", subtypes: ["CREDIT_CARD"] }, "bank-amex-payment") },
  // The Amex High Yield Savings account is tracked; its transfers pair with the other bank's row.
  { id: "bank-amex-savings", re: /AMERICAN ?EXPRESS TRANSFER|AMEX (HYSA|SAVINGS)|AMERICAN EXPRESS NATIONAL BANK/,
    decide: () => own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "American Express", subtypes: ["SAVINGS"] }, "bank-amex-savings") },
  // Wires to/from a tracked private fund (capital calls and distributions): the fund's
  // name as the bank prints it (household file), or any capital call.
  { id: "bank-fund-wire", re: (h) => h.fundWire,
    decide: (i, _ctx, h) => fundCapitalCall(i, h) },
  { id: "bank-fund-capital-call", re: /CAPITAL ?CALL/,
    decide: (i, _ctx, h) => fundCapitalCall(i, h) },
  // Vanguard is tracked: micro-deposit verifications net to zero, everything else moves our own money.
  { id: "bank-vanguard-verify", re: /VANGUARD.*(ACCTVERIFY|VERIFY)/,
    decide: (i) => (i.amountCents > 0 ? income("Other income", "bank-vanguard-verify", "high") : expense("Fees & interest", "bank-vanguard-verify", "high")) },
  { id: "bank-vanguard", re: /VANGUARD.*(WEB ID|PPD ID)|VANGUARD (MARKETI|BUY INVESTMENT|SELL|ACH)/,
    decide: () => own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "Vanguard", subtypes: FUNDABLE }, "bank-vanguard") },
  // The partner's own untracked bank accounts, by the ending the bank prints (household file).
  { id: "bank-partner-account", re: (h) => h.partnerAccount,
    decide: (i, ctx) => partner(i, ctx, "bank-partner-account") },
  // ACH in/out of a savings account is the owner's own money moving (paired on both sides).
  // Amex names the other bank account: "External ACH Deposit Internet transfer from
  // JPMORGAN CHASE BANK, NA DDA account XXXXX1234".
  { id: "savings-ach", re: /^(EXTERNAL )?ACH (DEPOSIT|WITHDRAWAL)|^(ONLINE|INCOMING|OUTGOING) TRANSFER|^TRANSFER/, savingsOnly: true,
    decide: (i) =>
      own("TRANSFER", "Own-account transfers", {
        kind: "OWN_ACCOUNT",
        subtypes: i.amountCents < 0 ? ["CHECKING", ...FUNDABLE] : ["CHECKING"],
        accountHint: /\bACCOUNT X+(\d{4})\b/.exec(i.description.toUpperCase())?.[1],
      }, "savings-ach") },
  { id: "bank-fidelity-moneyline", re: /FID BKG SVC|FIDELITY|MONEYLINE/,
    decide: () => own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "Fidelity" }, "bank-fidelity-moneyline") },

  // The Bilt card is tracked: payments to it pair with the card's own "PAYMENT" rows.
  // (Payments before its first statement end up as untracked card payments, see runMatching.)
  { id: "bank-bilt-card-payment", re: /BILT CARD PMT/, sign: "-",
    decide: () => own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "Bilt", subtypes: ["CREDIT_CARD"] }, "bank-bilt-card-payment") },
  // Capital One cards are tracked the same way. Every Capital One card is paid under the
  // same description, so a payment to a card without statements goes unmatched and
  // runMatching relabels it an untracked card payment.
  { id: "bank-capital-one-card-payment", re: /CAPITAL ONE.*(PMT|PYMT|PAYMENT)/, sign: "-",
    decide: () => own("TRANSFER", "Own-account transfers", { kind: "OWN_ACCOUNT", institution: "Capital One", subtypes: ["CREDIT_CARD"] }, "bank-capital-one-card-payment") },

  // Chase cards too (Freedom Unlimited ••1234): "Payment To Chase Card Ending IN 1234",
  // "Chase Credit Crd Autopay". runMatching relabels a payment no tracked card received.
  { id: "bank-chase-card-payment", re: /PAYMENT TO CHASE CARD|CHASE CREDIT CRD/, sign: "-",
    decide: (i) =>
      own("TRANSFER", "Own-account transfers", {
        kind: "OWN_ACCOUNT",
        institution: "Chase",
        subtypes: ["CREDIT_CARD"],
        accountHint: /\bENDING IN (\d{4})\b/.exec(i.description.toUpperCase())?.[1],
      }, "bank-chase-card-payment") },

  // Untracked credit cards: counted as spending, by the owner's rule.
  { id: "bank-untracked-card", re: /CAPITAL ONE|DISCOVER|CITI CARD|BARCLAYCARD|SYNCHRONY/, sign: "-",
    decide: () => ({ ...expense("Untracked card payments", "bank-untracked-card", "high"), counterparty: { kind: "UNTRACKED_CARD" } }) },
  { id: "bank-bilt-rent", re: /BILT CARD HOUSING|BILT RENT/, sign: "-",
    decide: () => expense("Housing", "bank-bilt-rent", "high") },

  // Partner money (Zelle with the partner by name, household file): the partner's own
  // accounts until the merge, untracked household money after.
  { id: "bank-partner", re: (h) => h.partnerTransfer,
    decide: (i, ctx) => partner(i, ctx, "bank-partner") },

  // Payroll and benefits.
  { id: "bank-payroll", re: /PAYROLL|DIRECT DEP|DIR DEP|SALARY/, sign: "+",
    decide: () => ({ ...income("Paycheck", "bank-payroll", "high"), counterparty: { kind: "EMPLOYER" } }) },
  { id: "bank-paid-leave", re: /PFML|PAID LEAVE|UNEMPLOYMENT|DISABILITY/, sign: "+",
    decide: () => ({ ...income("Paid leave & benefits", "bank-paid-leave", "high"), counterparty: { kind: "GOVERNMENT" } }) },
  { id: "bank-interest", re: /INTEREST PAYMENT|INTEREST EARNED|INTEREST CREDIT/, sign: "+",
    decide: () => income("Interest", "bank-interest", "high") },

  // Taxes (refunds offset the same category).
  { id: "bank-taxes", re: /\bIRS\b|USATAXPYMT|TREAS 310|NYSTTAXRFD|NY STATE|STATE OF CT DRS|CT DRS|DEPT OF REVENUE|TAX REF|TAX PAYMENT/,
    decide: () => ({ ...expense("Taxes", "bank-taxes", "high"), counterparty: { kind: "GOVERNMENT" } }) },

  // Untracked money the household owns elsewhere.
  { id: "bank-wise", re: /\bWISE\b|TRNWISE|TRANSFERWISE/,
    decide: () => externalOwn("International transfers", "bank-wise", true) },
  { id: "bank-untracked-brokerage", re: /QUESTRADE|WEALTHSIMPLE|ROBINHOOD|SCHWAB|E\*?TRADE|COINBASE/,
    decide: () => externalOwn("Untracked investment accounts", "bank-untracked-brokerage", false) },

  // Person-to-person.
  { id: "bank-p2p-in", re: /ZELLE PAYMENT FROM|VENMO CASHOUT|FROM: VENMO|REAL TIME TRANSFER RECD.*VENMO|PAYPAL TRANSFER|CASH APP/, sign: "+",
    decide: () => ({ ...income("P2P & reimbursements", "bank-p2p-in", "medium"), counterparty: { kind: "PERSON" } }) },
  { id: "bank-p2p-out", re: /ZELLE PAYMENT TO|VENMO PAYMENT|VENMO\b|PAYPAL|CASH APP/, sign: "-",
    decide: () => ({ ...expense("P2P payments", "bank-p2p-out", "medium"), counterparty: { kind: "PERSON" } }) },

  // Bank fees and cash.
  { id: "bank-fees", re: /\bFEE\b|SERVICE CHARGE|OFFICIAL CHECKS CHARGE|FOREIGN EXCH RT ADJ/, sign: "-",
    decide: () => expense("Fees & interest", "bank-fees", "high") },
  // A large unlabeled branch withdrawal is usually an official (cashier's) check.
  { id: "bank-branch-withdrawal", re: /^WITHDRAWAL$|^$/, sign: "-",
    decide: (i) =>
      i.amountCents <= -200_000
        ? { ...expense("Checks", "bank-branch-withdrawal", "low"), needsReview: true }
        : expense("Cash & ATM", "bank-branch-withdrawal", "medium") },
  { id: "bank-atm-out", re: /ATM WITHDRAW|CASH WITHDRAWAL/, sign: "-",
    decide: () => expense("Cash & ATM", "bank-atm-out", "high") },
  { id: "bank-insurance-reimbursement", re: /UNITED HEALTHCAR|AETNA|CIGNA|BLUE ?CROSS|INS PAYMNT/, sign: "+",
    decide: () => expense("Health & fitness", "bank-insurance-reimbursement", "high") },
  { id: "bank-reversal", re: /^REVERSAL:|REFUND|RETURN/,
    decide: (i, _ctx, h) => expense(categorizeMerchant(i.description.replace(/^Reversal:\s*/i, ""), i.detail, h.merchantRules) ?? "Shopping", "bank-reversal", "medium") },
  { id: "bank-micro-deposit", re: /ACCTVERIFY|BANK VERIFY|SIGONFILE|VERIFY/, sign: "+",
    decide: () => income("Other income", "bank-micro-deposit", "medium") },
  { id: "bank-check", re: /^CHECK #|^CHECK \d+|CHECK OR SUPPLY ORDER/, sign: "-",
    decide: () => ({ ...expense("Checks", "bank-check", "low"), needsReview: true }) },
  { id: "bank-wire-out", re: /WIRE TRANSFER|ONLINE DOMESTIC WIRE|INTERNATIONAL WIRE|CONSUMER ONLINE .*WIRE/, sign: "-",
    decide: (i, _ctx, h) => {
      const cat = categorizeMerchant(i.description, undefined, h.merchantRules);
      return cat ? expense(cat, "bank-wire-out", "medium") : { ...expense("Uncategorized", "bank-wire-out", "low"), needsReview: true };
    } },
  { id: "bank-deposit", re: /DEPOSIT|BOOK TRANSFER CREDIT|INCOMING WIRE|REAL TIME TRANSFER RECD/, sign: "+",
    decide: () => ({ ...income("Other income", "bank-deposit", "low"), needsReview: true }) },

  // Rent paid through Bilt: the checking account's ACH is the real rent. On the card the
  // housing charge is cancelled by a "rent charge adjustment" credit, so both lines are
  // Housing and net to zero instead of counting the rent twice.
  { id: "card-bilt-housing", re: /BILT HOUSING|BILT RENT/, cards: true,
    decide: () => expense("Housing", "card-bilt-housing", "high") },

  // Card-side specials.
  { id: "card-cash-advance", re: /CASINO|\bBET\b|HARD ROCK BET|DRAFTKINGS|FANDUEL/, cards: true,
    decide: () => expense("Entertainment", "card-cash-advance", "medium") },
];

function systemRule(i: ClassifyInput, ctx: ClassifyContext, h: HouseholdPatterns): Partial | null {
  const d = i.description.toUpperCase();
  const isCard = i.accountSubtype === "CREDIT_CARD";
  const isBank = i.accountSubtype === "CHECKING" || i.accountSubtype === "SAVINGS";
  // A landlord's bill: every charge (or credit) on it is housing, except the parking.
  if (i.accountSubtype === "BILL") return expense(/PARKING/.test(d) ? "Transportation" : "Housing", "bill-charge", "high");
  if (!isCard && !isBank) return null;
  for (const r of SYSTEM_RULES) {
    if (isCard && !r.cards) continue;
    if (r.savingsOnly && i.accountSubtype !== "SAVINGS") continue;
    if (r.sign === "+" && i.amountCents <= 0) continue;
    if (r.sign === "-" && i.amountCents >= 0) continue;
    const re = typeof r.re === "function" ? r.re(h) : r.re;
    if (re?.test(d)) return r.decide(i, ctx, h);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4–5. Merchants, then fallback
// ---------------------------------------------------------------------------

function merchantRule(i: ClassifyInput, h: HouseholdPatterns): Partial | null {
  const cat = categorizeMerchant(i.description.replace(/^(Card Purchase( With Pin)?|Recurring Card Purchase)\s+(\d{2}\/\d{2}\s+)?/i, ""), i.detail, h.merchantRules);
  // Card charges and bank debits are spending; a positive card/bank row here is a refund.
  if (cat) return expense(cat, "merchant-keyword", "medium");
  const guess = squareSmallTicketGuess(i.detail, i.amountCents);
  return guess ? expense(guess, "square-small-ticket", "low") : null;
}

function fallback(i: ClassifyInput): Partial {
  const spending = i.accountSubtype === "CREDIT_CARD" || i.amountCents < 0;
  return spending
    ? { ...expense("Uncategorized", "fallback", "low"), needsReview: true }
    : { ...income("Other income", "fallback", "low"), needsReview: true };
}

// ---------------------------------------------------------------------------

function own(lane: Lane, category: string, counterparty: Counterparty, ruleId: string): Partial {
  return { lane, category, counterparty, confidence: "high", needsReview: false, ruleId };
}

function expense(category: string, ruleId: string, confidence: Confidence): Partial {
  return { lane: "EXPENSE", category, counterparty: { kind: "MERCHANT" }, confidence, needsReview: false, ruleId };
}

function income(category: string, ruleId: string, confidence: Confidence): Partial {
  return { lane: "INCOME", category, counterparty: { kind: "UNKNOWN" }, confidence, needsReview: false, ruleId };
}

function externalOwn(category: string, ruleId: string, needsReview: boolean): Partial {
  return {
    lane: "EXTERNAL_TRANSFER",
    category,
    counterparty: { kind: "UNTRACKED_OWN" },
    confidence: needsReview ? "medium" : "high",
    needsReview,
    ruleId,
  };
}

/**
 * Paper checks that repeat monthly are almost always rent. Run over an account's checks
 * after classification: a check of $1,000+ joins a rent series when it is within ~two
 * months of the series' last check and is either the same amount or a step up of at most
 * 10% (rent rises a few percent now and then and stays there). A series spanning ≥3
 * different months becomes Housing & utilities (still reviewable); one-off checks and
 * odd amounts stay "Other" for the owner to label.
 */
export function recurringCheckCategory<T extends { description: string; amountCents: number; date: string }>(
  rows: T[],
): Map<T, string> {
  const checks = rows
    .filter((r) => /^CHECK #|^CHECK \d+/i.test(r.description) && r.amountCents <= -100_000)
    .sort((a, b) => a.date.localeCompare(b.date));
  type Series = { last: T; months: Set<string>; members: T[] };
  const all: Series[] = [];
  for (const c of checks) {
    const amount = -c.amountCents;
    const month = c.date.slice(0, 7);
    const series = all.find((s) => {
      const prev = -s.last.amountCents;
      const stepOk = amount >= prev && amount <= prev * 1.1;
      const gapDays = (Date.parse(c.date) - Date.parse(s.last.date)) / 86_400_000;
      // One rent check per month: a second check the same month starts its own series.
      return stepOk && gapDays <= 62 && !s.months.has(month);
    });
    if (series) {
      series.members.push(c);
      series.months.add(month);
      series.last = c;
    } else {
      all.push({ last: c, months: new Set([month]), members: [c] });
    }
  }
  const out = new Map<T, string>();
  for (const s of all) {
    if (s.months.size < 3) continue;
    for (const m of s.members) out.set(m, "Housing & utilities");
  }
  return out;
}
