/** How many years of living cost the Insurance Overview's coverage gap counts, unless the owner says otherwise. */
export const DEFAULT_NEED_YEARS = 10;
export const MAX_NEED_YEARS = 40;

/**
 * What the household would need if an earner died, against what it already has: the
 * Insurance Overview's coverage gap. Every input is a figure another page proves: the
 * typical month's living cost (Cash flow's window), what the accounts hold and owe on the
 * proven-through date (Net worth). The only typed number is how many years of living cost
 * to cover (InsuranceNotes.needYears). Descriptive, not advice: it says how far the cover in
 * force and the money on hand would carry today's way of living.
 */
export type CoverNeed = {
  years: number;
  /** The typical month's living cost, or null with no proven month. */
  living: { monthlyCents: number; months: number; from: string; to: string } | null;
  /** Net worth's proven-through date, and its assets and debts then (debts as a positive amount); null while a finding withholds it. */
  balances: { asOf: string; assetsCents: number; debtsCents: number } | null;
};

/** The gap, worked out from the need's parts and the life cover in force: positive is short. Null when a part is missing. */
export function coverGap(need: CoverNeed, lifeCoverCents: number) {
  if (!need.living || !need.balances) return null;
  const livingCents = need.living.monthlyCents * 12 * need.years;
  const neededCents = Math.max(0, livingCents + need.balances.debtsCents - need.balances.assetsCents);
  return { livingCents, neededCents, gapCents: neededCents - lifeCoverCents };
}
