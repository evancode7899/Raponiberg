import type { RollYear } from "./rollforwards.ts";

/**
 * The lines of an investment account's year, as Net worth › Account roll-forwards shows
 * them and its proofs (book/proof/annualProof.ts) re-add them. Kept apart from
 * rollforwards.ts so the page can import it without the Book.
 */
export type RollLine = "opening" | "employee" | "employer" | "deposits" | "withdrawals" | "after-contributions" | "income" | "market" | "fees" | "closing" | "return";
export type RollTotalLine = "closing" | "contributions" | "growth";

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
