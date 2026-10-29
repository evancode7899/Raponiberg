import { AIRLINES, HOTELS, PROGRAMS, type CardProduct } from "./catalog.ts";
import { compileRules, matchRule } from "./rewards.ts";
import type { Holding } from "./perks.ts";
import type { OptimizerLine, PerkRow, WalletTip } from "./types.ts";

/**
 * Which card each purchase should have gone on. Every purchase is valued on the card that
 * paid (its rate, at the program's point value) and on every other card held that day;
 * the gap is what using the best card would have added. Spending caps are left out (the
 * gap is an upper bound), and rent paid through Bilt stays with Bilt.
 */

const TYPES: { key: string; label: string; test: (r: PerkRow, text: string) => boolean }[] = [
  { key: "rent", label: "Rent", test: (_, t) => /BILT HOUSING|BILT RENT|BPS\*BILT/i.test(t) },
  { key: "flights", label: "Flights", test: (_, t) => new RegExp(AIRLINES, "i").test(t) },
  { key: "hotels", label: "Hotels & travel", test: (r, t) => new RegExp(`${HOTELS}|AIRBNB|VRBO|EXPEDIA|BOOKING\\.COM|HERTZ|AVIS|AMTRAK|VIA RAIL`, "i").test(t) || (r.category === "Travel & entertainment" && /TRAVEL/i.test(t)) },
  { key: "dining", label: "Dining", test: (r) => r.category === "Dining" },
  { key: "groceries", label: "Groceries", test: (r) => r.category === "Groceries" },
  { key: "gas", label: "Gas", test: (_, t) => /SHELL\b|EXXON|MOBIL\b|CHEVRON|\bBP\b|SUNOCO|CITGO|SPEEDWAY|WAWA|VALERO|\bFUEL\b|GAS STATION|\bGAS\b/i.test(t) },
  { key: "rides", label: "Transit & rides", test: (r, t) => r.category === "Transportation" || /\bUBER\b|\bLYFT\b|\bMTA\b|\bMNR\b|TAXI/i.test(t) },
  { key: "drugstores", label: "Drugstores", test: (_, t) => /CVS|WALGREENS|DUANE READE|RITE AID|PHARMAC/i.test(t) },
  { key: "streaming", label: "Streaming", test: (_, t) => /NETFLIX|SPOTIFY|HULU|DISNEY|HBO|YOUTUBE|PEACOCK|PARAMOUNT|SIRIUS/i.test(t) },
  { key: "online", label: "Online shopping", test: (r, t) => r.category === "Shopping & gifts" && /AMAZON|AMZN|\bAMZ|ETSY|EBAY|WAYFAIR|\.COM\b|WWW\./i.test(t) },
  { key: "other", label: "Everything else", test: () => true },
];

export const spendType = (r: PerkRow) => {
  const text = `${r.payee} ${r.detail ?? ""}`;
  return TYPES.find((t) => t.test(r, text))!;
};

export type OptCard = { accountId: string; product: CardProduct; held: Holding; centsPerPoint: number };

/** Cents of value a dollar earns on a card for a row (0 for a card with no rewards). */
function centsPerDollar(card: OptCard, rules: ReturnType<typeof compileRules>, r: PerkRow): number {
  const program = PROGRAMS[card.product.program];
  if (program.kind === "NONE") return 0;
  const rate = matchRule(rules, r)?.rate ?? card.product.baseRate;
  return program.kind === "CASH" ? rate : rate * card.centsPerPoint;
}

export function optimize(cards: OptCard[], rows: PerkRow[], today: string): { lines: OptimizerLine[]; missedCents: number; spendCents: number; actualCents: number; tips: WalletTip[] } {
  const rules = new Map(cards.map((c) => [c.accountId, compileRules(c.product)]));
  const byId = new Map(cards.map((c) => [c.accountId, c]));
  const lines = new Map<string, OptimizerLine & { bestVotes: Map<string, number> }>();
  for (const r of rows) {
    const card = byId.get(r.accountId);
    if (!card || r.amountCents >= 0) continue;
    const t = spendType(r);
    if (t.key === "rent") continue;
    const dollars = -r.amountCents / 100;
    const actual = centsPerDollar(card, rules.get(card.accountId)!, r) * dollars;
    let best = { accountId: card.accountId, cpd: actual / dollars };
    for (const other of cards) {
      if (other.held.from > r.date || (!other.held.open && other.held.through < r.date)) continue;
      const cpd = centsPerDollar(other, rules.get(other.accountId)!, r);
      if (cpd > best.cpd + 1e-9) best = { accountId: other.accountId, cpd };
    }
    const line = lines.get(t.key) ?? { key: t.key, label: t.label, spendCents: 0, actualCents: 0, bestCents: 0, best: null, byCard: [], bestVotes: new Map<string, number>() };
    line.spendCents += -r.amountCents;
    line.actualCents += actual;
    line.bestCents += best.cpd * dollars;
    line.bestVotes.set(best.accountId, (line.bestVotes.get(best.accountId) ?? 0) + -r.amountCents);
    const bc = line.byCard.find((x) => x.accountId === card.accountId);
    if (bc) {
      bc.spendCents += -r.amountCents;
      bc.valueCents += actual;
    } else line.byCard.push({ accountId: card.accountId, spendCents: -r.amountCents, valueCents: actual });
    lines.set(t.key, line);
  }
  const out: OptimizerLine[] = [...lines.values()].map(({ bestVotes, ...l }) => {
    const top = [...bestVotes].sort((a, b) => b[1] - a[1])[0];
    const c = top ? byId.get(top[0]) : undefined;
    const program = c ? PROGRAMS[c.product.program] : null;
    return {
      ...l,
      actualCents: Math.round(l.actualCents),
      bestCents: Math.round(l.bestCents),
      byCard: l.byCard.map((b) => ({ ...b, valueCents: Math.round(b.valueCents) })).sort((a, b) => b.spendCents - a.spendCents),
      best: c && program ? { accountId: c.accountId } : null,
    };
  });
  out.sort((a, b) => b.bestCents - b.actualCents - (a.bestCents - a.actualCents) || b.spendCents - a.spendCents);

  // The card to reach for today, by kind of purchase: the open card earning the most on a typical row.
  const open = cards.filter((c) => c.held.open && PROGRAMS[c.product.program].kind !== "NONE");
  const sample: Record<string, Partial<PerkRow>> = {
    dining: { category: "Dining", payee: "RESTAURANT" },
    groceries: { category: "Groceries", payee: "SUPERMARKET" },
    flights: { category: "Travel & entertainment", payee: "UNITED AIRLINES" },
    hotels: { category: "Travel & entertainment", payee: "MARRIOTT HOTEL" },
    gas: { category: "Transportation", payee: "SHELL GAS" },
    rides: { category: "Transportation", payee: "UBER TRIP" },
    drugstores: { category: "Health & insurance", payee: "CVS PHARMACY" },
    streaming: { category: "Travel & entertainment", payee: "NETFLIX.COM" },
    online: { category: "Shopping & gifts", payee: "AMAZON.COM" },
    other: { category: "Other", payee: "STORE" },
  };
  const tips: WalletTip[] = [];
  for (const t of TYPES) {
    const s = sample[t.key];
    if (!s) continue;
    const row = { id: "", date: today, amountCents: -10_000, lane: "EXPENSE", accountId: "", detail: null, section: null, classifiedBy: null, statementId: "", payee: "", category: "Other", ...s } as PerkRow;
    const ranked = open
      .map((c) => ({ c, cpd: centsPerDollar(c, rules.get(c.accountId)!, row), rate: matchRule(rules.get(c.accountId)!, row)?.rate ?? c.product.baseRate }))
      // A tie goes to cash back: same value, no redeeming.
      .sort((a, b) => b.cpd - a.cpd || Number(PROGRAMS[b.c.product.program].kind === "CASH") - Number(PROGRAMS[a.c.product.program].kind === "CASH"));
    const top = ranked[0];
    if (!top || top.cpd <= 0) continue;
    const second = ranked.find((x) => x.c.accountId !== top.c.accountId);
    tips.push({ key: t.key, label: t.label, accountId: top.c.accountId, rate: top.rate, centsPerDollar: top.cpd, runnerUp: second ? { accountId: second.c.accountId, centsPerDollar: second.cpd } : null });
  }
  return {
    lines: out,
    missedCents: out.reduce((t, l) => t + Math.max(0, l.bestCents - l.actualCents), 0),
    spendCents: out.reduce((t, l) => t + l.spendCents, 0),
    actualCents: out.reduce((t, l) => t + l.actualCents, 0),
    tips,
  };
}

