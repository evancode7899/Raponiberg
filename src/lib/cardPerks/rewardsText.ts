/**
 * The rewards summary a credit card statement prints, read from its text: the balance of
 * the card's rewards program and the date it's as of, plus whatever else the issuer
 * discloses (points earned this period by category, rewards redeemed). The Card perks
 * page reconciles these balances against the rewards the card's spending should have
 * earned (lib/cardPerks/rewards.ts), so the statement, not an estimate, says what posted.
 *
 * What each issuer prints:
 * - American Express points cards: the Membership Rewards balance, available and pending
 *   as of the last month end (older statements print the balance alone, as of the close).
 *   The balance is the whole Membership Rewards account, shared by every card on it.
 * - American Express cash back cards: the Reward Dollars balance, as of a date near the
 *   previous close.
 * - Chase: previous points balance, points earned this period line by line (base rate and
 *   each bonus category), and the total available.
 * - Capital One: the rewards balance (dollars of cash back, or miles), with the previous
 *   balance, earned and redeemed this period.
 * Statements that print none of these (Bilt, cards without rewards) read as null.
 */

export const REWARDS_READER_VERSION = 1;

/** POINTS: whole points or miles. CASH: cents of cash back. */
export type RewardsUnit = "POINTS" | "CASH";

export type RewardsSnapshot = {
  /** Which balance this is: "amex-mr" is shared by every Membership Rewards card. */
  program: "amex-mr" | "amex-cash" | "chase-ur" | "capital-one-cash" | "capital-one-miles";
  unit: RewardsUnit;
  balance: number;
  /** YYYY-MM-DD the balance is as of; null when the statement doesn't say (its close is meant). */
  asOf: string | null;
  previous?: number;
  /** Earned this period, as printed (Chase, Capital One). */
  earned?: number;
  /** Redeemed this period, as printed (Capital One, Chase redemption lines). */
  redeemed?: number;
  /** The earned lines as printed (Chase), largest first. */
  lines?: { label: string; amount: number }[];
};

const num = (s: string) => Number(s.replace(/[,$\s]/g, ""));
const cents = (s: string) => Math.round(num(s) * 100);
const mdy = (m: string, d: string, y: string) => `${y.length === 2 ? `20${y}` : y}-${m}-${d}`;

function amexPoints(text: string): RewardsSnapshot | null {
  const m = /Membership Rewards® Points\s*\n(?:Available and Pending as of (\d{2})\/(\d{2})\/(\d{2,4})\s*\n)?([\d,]+)\s*\n/.exec(text);
  if (!m) return null;
  return { program: "amex-mr", unit: "POINTS", balance: num(m[4]!), asOf: m[1] ? mdy(m[1], m[2]!, m[3]!) : null };
}

function amexCash(text: string): RewardsSnapshot | null {
  const m = /Reward Dollars\s*\n(?:as of (\d{2})\/(\d{2})\/(\d{2,4})\s*\n)?([\d,]+\.\d{2})\s*\n/.exec(text);
  if (!m) return null;
  return { program: "amex-cash", unit: "CASH", balance: cents(m[4]!), asOf: m[1] ? mdy(m[1], m[2]!, m[3]!) : null };
}

/** "+ 1.5%(1.5 Pts)/$1 addl on Dining purchases 32" → a line of the Chase rewards summary. */
const CHASE_LINE = /^([+-]?)\s*(.*?(?:Pts|pts|points|Points|bonus|Bonus|redeem|Redeem|adjust|Adjust).*?)\s+(-?[\d,]+)$/;

function chase(text: string): RewardsSnapshot | null {
  const ls = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const start = ls.findIndex((l) => /^Previous points balance [\d,]+$/.test(l));
  if (start < 0) return null;
  const previous = num(/([\d,]+)$/.exec(ls[start]!)![1]!);
  const lines: { label: string; amount: number }[] = [];
  let redeemed = 0;
  for (const l of ls.slice(start + 1)) {
    const m = CHASE_LINE.exec(l);
    if (!m) break;
    const amount = num(m[3]!);
    if (m[1] === "-" || amount < 0 || /redeem/i.test(m[2]!)) redeemed += Math.abs(amount);
    else lines.push({ label: m[2]!.replace(/^\+\s*/, ""), amount });
  }
  const earned = lines.reduce((t, x) => t + x.amount, 0);
  // The total can run into the next item on the page ("redemption 61804/07/23"): what's
  // printed before a trailing date, else what the lines add up to.
  const total = /Total points available for\s*\nredemption ([\d,]+?)(?=\d{2}\/\d{2}\/\d{2}|\s*$|\s*\n)/m.exec(text);
  // The printed total wins; a line the reader skipped shows as the reconciliation's gap.
  const balance = total ? num(total[1]!) : previous + earned - redeemed;
  return { program: "chase-ur", unit: "POINTS", balance, asOf: null, previous, earned, redeemed, lines: lines.sort((a, b) => b.amount - a.amount) };
}

function capitalOne(text: string): RewardsSnapshot | null {
  const head = /Rewards Summary\s+Rewards as of: (\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (!head) return null;
  const after = text.slice(head.index);
  const bal = /(?:Rewards|Miles) Balance\s*\n\s*(\$?)([\d,]+(?:\.\d{2})?)/.exec(after);
  if (!bal) return null;
  const cash = bal[1] === "$";
  const read = (s: string) => (cash ? cents(s) : num(s));
  const flows = /Previous Balance\s+Earned This Period\s+Redeemed this period\s*\n\s*\$?([\d,.]+)\s+\$?([\d,.]+)\s+\$?([\d,.]+)/i.exec(after);
  return {
    program: cash ? "capital-one-cash" : "capital-one-miles",
    unit: cash ? "CASH" : "POINTS",
    balance: read(bal[2]!),
    asOf: mdy(head[1]!, head[2]!, head[3]!),
    ...(flows ? { previous: read(flows[1]!), earned: read(flows[2]!), redeemed: read(flows[3]!) } : {}),
  };
}

/** The rewards summary on a card statement's text, or null when it prints none. */
export function readRewards(text: string): RewardsSnapshot | null {
  if (/americanexpress\.com|American Express/i.test(text)) return amexPoints(text) ?? amexCash(text);
  if (/chase\.com|Ultimate Rewards/i.test(text)) return chase(text);
  if (/capitalone\.com/i.test(text)) return capitalOne(text);
  return null;
}
