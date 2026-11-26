import { holds, type Mark } from "../marks.ts";

/** What the feed needs to know of an item to hide it: its id and what it says. */
type Decidable = { id: string; says: string };

/** How many items the Dashboard's feed shows. */
export const FEED_SHOWN = 12;

/**
 * The feed as the owner left it: items dismissed (or put off to a day not yet come) are
 * hidden while they still say what they said, and the rest fill the list up to `limit`.
 */
export function visibleFeed<T extends Decidable>(feed: readonly T[], marks: readonly Mark[], today: string, limit = FEED_SHOWN): { shown: T[]; hidden: (T & { mark: Mark })[] } {
  const byId = new Map(marks.map((m) => [m.id, m]));
  const shown: T[] = [];
  const hidden: (T & { mark: Mark })[] = [];
  for (const f of feed) {
    const m = byId.get(f.id);
    if (m && holds(m, f.says, today)) hidden.push({ ...f, mark: m });
    else if (shown.length < limit) shown.push(f);
  }
  return { shown, hidden };
}
