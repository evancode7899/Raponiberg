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
 * Returns transactionId → amount to move out of that row's transfer flow (Σ legs).
 */
export function transferDifferenceAdjustments(
  matches: { differenceCents: number; legs: { id: string; amountCents: number; accountId?: string }[] }[],
  billAccounts: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) {
    if (m.differenceCents === 0) continue;
    const bill = m.legs.find((l) => l.accountId && billAccounts.has(l.accountId));
    const sender = bill ?? m.legs.filter((l) => l.amountCents < 0).sort((a, b) => a.amountCents - b.amountCents)[0];
    if (sender) out.set(sender.id, m.differenceCents);
  }
  return out;
}

/** The account ids of landlords' bill accounts, whose transfer differences are spending. */
export const billAccountIds = (accounts: { id: string; subtype: string | null }[]) => new Set(accounts.filter((a) => a.subtype === "BILL").map((a) => a.id));
