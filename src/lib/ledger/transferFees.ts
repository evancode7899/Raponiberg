/**
 * A confirmed transfer whose legs don't net to zero lost (or gained) money in transit —
 * typically a rollover or wire fee. The shortfall is booked on the sending leg's account
 * as a fee (or, if money was gained, as growth), so the transfer itself nets to zero
 * across accounts and the cost shows up in "growth net of fees" instead of lingering as
 * money in transit.
 *
 * Returns transactionId → amount to move out of that row's transfer flow (Σ legs).
 */
export function transferDifferenceAdjustments(
  matches: { differenceCents: number; legs: { id: string; amountCents: number }[] }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) {
    if (m.differenceCents === 0) continue;
    const sender = m.legs.filter((l) => l.amountCents < 0).sort((a, b) => a.amountCents - b.amountCents)[0];
    if (sender) out.set(sender.id, m.differenceCents);
  }
  return out;
}
