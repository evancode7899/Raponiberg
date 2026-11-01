import type { RollYear } from "./rollforwards.ts";

/**
 * The lines of an investment account's year, as Net worth › Account roll-forwards shows
 * them and its proofs (book/proof/annualProof.ts) re-add them. Kept apart from
 * rollforwards.ts so the page can import it without the Book.
 */
export type RollLine = "opening" | "employee" | "employer" | "deposits" | "withdrawals" | "after-contributions" | "income" | "market" | "fees" | "closing" | "return";
export type RollTotalLine = "closing" | "contributions" | "growth";

/**
 * The lines an account's card draws, in order: contributions, deposits, withdrawals and fees
 * only once any year (not blocked) has some; dividends and interest once any year has a
 * figure for them (a year without one draws a dash).
 */
export function shownRollLines(ys: RollYear[]): Exclude<RollLine, "return">[] {
  const any = (f: (x: RollYear) => number | null) => ys.some((x) => !x.blockers.length && (f(x) ?? 0) !== 0);
  return [
    "opening",
    ...(any((x) => x.employee) ? (["employee"] as const) : []),
    ...(any((x) => x.employer) ? (["employer"] as const) : []),
    ...(any((x) => x.deposits) ? (["deposits"] as const) : []),
    ...(any((x) => x.withdrawals) ? (["withdrawals"] as const) : []),
    "after-contributions",
    ...(ys.some((x) => x.income != null) ? (["income"] as const) : []),
    "market",
    ...(any((x) => x.fees) ? (["fees"] as const) : []),
    "closing",
  ];
}

export function rollValue(x: RollYear, l: Exclude<RollLine, "return">): number {
  switch (l) {
    case "after-contributions":
      return x.opening + x.employee + x.employer + x.deposits + x.withdrawals;
    case "income":
      return x.income ?? 0;
    case "market":
      return x.marketChange;
    default:
      return x[l];
  }
}

/** The summary table's totals: what invested accounts closed at, contributions, and income + market change + fees. */
export const rollTotalValue = (x: RollYear, l: RollTotalLine) => (l === "closing" ? x.closing : l === "contributions" ? x.employee + x.employer : (x.income ?? 0) + x.marketChange + x.fees);
