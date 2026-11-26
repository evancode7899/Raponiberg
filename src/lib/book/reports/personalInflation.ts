import type { RecurringCharge } from "./spending.ts";

/**
 * Personal inflation, like for like: what each recurring bill charges now against what the
 * same bill charged a year before (its own charges, one year apart), and by category and in
 * all, weighted by what the bills cost. A change in how much is bought never counts: only
 * the same bill, twice, and only bills for a set amount (subscriptions, rent, premiums): a
 * metered bill moves with use, and a tax payment isn't a price. Spending that varies (groceries, dining) has no like-for-like price
 * here; Year over year shows how its dollars moved. Pure.
 */

/** Categories whose bills aren't prices of anything bought. */
const NOT_PRICES = new Set(["Taxes & fees"]);

export type PriceChange = { key: string; name: string; category: string; then: { rowId: string; date: string; cents: number }; now: { rowId: string; date: string; cents: number }; change: number };
export type PriceGroup = { category: string; thenCents: number; nowCents: number; change: number; bills: PriceChange[] };
export type PersonalInflation = { bills: PriceChange[]; categories: PriceGroup[]; all: { thenCents: number; nowCents: number; change: number } | null };

export function personalInflation(recurring: readonly RecurringCharge[]): PersonalInflation {
  const bills = recurring
    // Bills for a set amount only (a metered bill moves with use), and never a tax payment (not a price).
    .filter((b) => b.kind === "bill" && b.fixed && b.active && b.yearAgo && b.yearAgo.cents > 0 && !NOT_PRICES.has(b.category))
    .map((b): PriceChange => ({ key: b.key, name: b.name, category: b.category, then: b.yearAgo!, now: { rowId: b.lastRowId, date: b.lastDate, cents: b.lastCents }, change: b.lastCents / b.yearAgo!.cents - 1 }))
    .sort((a, b) => b.change - a.change || a.key.localeCompare(b.key));
  const groups = new Map<string, PriceChange[]>();
  for (const b of bills) groups.set(b.category, [...(groups.get(b.category) ?? []), b]);
  const group = (category: string, xs: PriceChange[]): PriceGroup => {
    const thenCents = xs.reduce((s, x) => s + x.then.cents, 0);
    const nowCents = xs.reduce((s, x) => s + x.now.cents, 0);
    return { category, thenCents, nowCents, change: nowCents / thenCents - 1, bills: xs };
  };
  const categories = [...groups].map(([c, xs]) => group(c, xs)).sort((a, b) => b.nowCents - a.nowCents);
  const all = bills.length ? group("all", bills) : null;
  return { bills, categories, all: all && { thenCents: all.thenCents, nowCents: all.nowCents, change: all.change } };
}
