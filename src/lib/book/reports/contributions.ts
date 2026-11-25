/**
 * A contribution-to-change table: how much each part moved, and its share of the total's
 * move, adding up to the change shown to the cent. Where the parts are rounded on their own
 * (a category's month, an average), what's left over is a row of its own (`rest`), never
 * spread across the parts or dropped. Pure.
 */

export type ContributionRow<K extends string = string> = { key: K; now: number; then: number; change: number; /** Of the total's change; null when the total barely moved. */ share: number | null };

export type Contributions<K extends string = string> = {
  rows: ContributionRow<K>[];
  total: { now: number; then: number; change: number };
  /** The total's change less the parts' changes (rounding): 0 when they add up on their own. */
  rest: number;
};

/** Below this the total barely moved, and a part's share of the move says nothing. */
export const SHARE_FLOOR_CENTS = 100;

export function contributions<K extends string>(parts: readonly { key: K; now: number; then: number }[], total: { now: number; then: number }): Contributions<K> {
  const change = total.now - total.then;
  const share = (c: number) => (Math.abs(change) < SHARE_FLOOR_CENTS ? null : c / change);
  const rows = parts.map((p) => ({ key: p.key, now: p.now, then: p.then, change: p.now - p.then, share: share(p.now - p.then) }));
  const rest = Math.round(change - rows.reduce((s, r) => s + r.change, 0));
  return { rows, total: { ...total, change }, rest };
}
