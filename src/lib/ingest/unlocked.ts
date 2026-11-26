/**
 * What an import unlocked: the proven-through date (Book.horizon, the one date every page
 * runs to) and each open account's latest statement day, read before and after. Only the
 * Book's own dates, compared: no figure of its own.
 */
export type Edge = { provenThrough: string; accounts: { name: string; through: string | null }[] };

type BookLike = { horizon: { netWorth: string }; ledger: { accounts: { name: string; closed: boolean; timeline: { lastDay: string | null } }[] } };

export function edgeOf(book: BookLike): Edge {
  return {
    provenThrough: book.horizon.netWorth,
    accounts: book.ledger.accounts.filter((a) => !a.closed).map((a) => ({ name: a.name, through: a.timeline.lastDay })),
  };
}

export type Unlocked = {
  /** The proven-through date moved from → to (null when it didn't move). */
  edge: { from: string; to: string } | null;
  /** Months now proven that weren't ("2026-07"). */
  months: string[];
  /** Accounts whose latest statement moved on, or that are new. */
  accounts: { name: string; from: string | null; to: string }[];
  /** What holds the edge now: the open accounts whose statements end on it. */
  heldBy: string[];
};

const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const end = to.slice(0, 7);
  // The month `from` falls in counts only if `from` didn't already close it.
  const lastOf = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  if (from < lastOf(y, m) && from.slice(0, 7) <= end && lastOf(y, m) <= to) out.push(from.slice(0, 7));
  for (;;) {
    m++;
    if (m > 12) [y, m] = [y + 1, 1];
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    if (lastOf(y, m) <= to) out.push(key);
  }
  return out;
};

export function unlockedBetween(before: Edge, after: Edge): Unlocked {
  const was = new Map(before.accounts.map((a) => [a.name, a.through]));
  const accounts = after.accounts.flatMap((a) => {
    const from = was.get(a.name) ?? null;
    return a.through && (!from || a.through > from) ? [{ name: a.name, from, to: a.through }] : [];
  });
  const moved = after.provenThrough > before.provenThrough;
  return {
    edge: moved ? { from: before.provenThrough, to: after.provenThrough } : null,
    months: moved ? monthsBetween(before.provenThrough, after.provenThrough) : [],
    accounts,
    heldBy: after.accounts.filter((a) => a.through === after.provenThrough).map((a) => a.name),
  };
}
