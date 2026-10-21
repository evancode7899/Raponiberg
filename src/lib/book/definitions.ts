import type { AccountGroup } from "../ledger/loadLedger.ts";

/**
 * The household's shared definitions: one place for what a word means wherever a figure
 * uses it, so two pages can't mean different things by "savings rate" or "liquid". Pure;
 * runs on the server and in the browser alike. A page needing a variant (Home budget's
 * spending outside housing) starts from these and says what it leaves out.
 */

/** Savings rate: what's left of income after spending, as a share of income (null without income). */
export function savingsRate(incomeCents: number, netCents: number): number | null {
  return incomeCents > 0 ? netCents / incomeCents : null;
}

/**
 * Liquid money: bank cash and taxable investments, less what the cards owe (paid from that
 * cash). Retirement, 529 and HSA money is never liquid. Card balances are negative, so
 * adding every liquid group's balance nets them out.
 */
export const LIQUID_GROUPS: readonly AccountGroup[] = ["Cash", "Taxable investments", "Credit cards"];

/** The liquid groups that hold money (not debt): what a goal or a home can be funded from. */
export const SPENDABLE_GROUPS: readonly AccountGroup[] = ["Cash", "Taxable investments"];

export const isLiquid = (group: string) => (LIQUID_GROUPS as readonly string[]).includes(group);
export const isSpendable = (group: string) => (SPENDABLE_GROUPS as readonly string[]).includes(group);

/** Liquid money over accounts: the sum of every liquid group's balance (cards owed come off). */
export function liquidCents(accounts: { group: string; cents: number }[]): number {
  return accounts.filter((a) => isLiquid(a.group)).reduce((s, a) => s + a.cents, 0);
}

/** A single expense this size or more, not a recurring bill, is a one-off candidate. */
export const ONE_OFF_MIN_CENTS = 150_000;
