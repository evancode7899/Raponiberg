/**
 * The owner's marks on things the app shows (lib/markStore.ts keeps them in the data folder).
 * Pure, so a page can tell which marks still hold.
 */

export type Mark = {
  id: string;
  /** What it said when marked: the mark lapses once it says something else. */
  says: string;
  /** When it was marked (ISO time). */
  at: string;
  /** The day it comes back (a "remind me"); null to keep it marked for good. */
  until: string | null;
};

/**
 * Whether a mark still holds on `today` for a thing that now says `says`: the thing says what
 * it said when marked, and the day it comes back (if any) hasn't come.
 */
export function holds(m: Mark | undefined, says: string, today: string): boolean {
  return Boolean(m && m.says === says && (m.until == null || today < m.until));
}
