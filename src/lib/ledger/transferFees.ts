/**
 * A confirmed transfer whose legs don't net to zero lost (or gained) money in transit —
 * typically a rollover or wire fee. The shortfall is booked on the sending leg's account
 * as a fee (or, if money was gained, as growth), so the transfer itself nets to zero
 * across accounts and the cost shows up in "growth net of fees" instead of lingering as
 * money in transit.
 *
 * Paying a landlord's bill is different: when what the bank paid differs from what the
 * bill says was paid, the landlord changed the bill without itemizing it (dropped a charge
 * billed twice, waived a fee). That difference is housing, so it stays on the bill's leg
 * and the ledger books it there as spending (a credit when the bank paid less), not as a
 * fee — see `billAccounts`.
 *
 * So is a private fund's contribution that its notices paid partly with interest
 * (FUND_NOTICE, transfers/fundContributions.ts): the fund's statement counts the whole
 * contribution, the bank wired less, and the rest was interest the fund owed the investor.
 * That interest never left the fund, so it stays on the fund's leg, as growth there.
 *
 * Returns transactionId → amount to move out of that row's transfer flow (Σ legs).
 */
export function transferDifferenceAdjustments(
  matches: { differenceCents: number; method?: string | null; legs: { id: string; amountCents: number; accountId?: string }[] }[],
  billAccounts: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) {
    if (m.differenceCents === 0) continue;
    const kept = m.method === FUND_NOTICE ? m.legs.find((l) => l.amountCents > 0) : m.legs.find((l) => l.accountId && billAccounts.has(l.accountId));
    const sender = kept ?? m.legs.filter((l) => l.amountCents < 0).sort((a, b) => a.amountCents - b.amountCents)[0];
    if (sender) out.set(sender.id, m.differenceCents);
  }
  return out;
}

/** TransferMatch.method of a fund contribution paired by its notices (transfers/fundContributions.ts). */
export const FUND_NOTICE = "FUND_NOTICE" as const;

/**
 * The pairings whose legs may differ: the owner's confirmed ones, and a fund contribution
 * its notices explain. Every other automatic pairing nets to zero.
 */
export const carriesDifference = (m: { status: string; method?: string | null }) => m.status === "CONFIRMED" || m.method === FUND_NOTICE;

/** The account ids of landlords' bill accounts, whose transfer differences are spending. */
export const billAccountIds = (accounts: { id: string; subtype: string | null }[]) => new Set(accounts.filter((a) => a.subtype === "BILL").map((a) => a.id));
