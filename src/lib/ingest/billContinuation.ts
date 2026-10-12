import { addDays } from "../dates/isoDate.ts";
import type { ParsedAccountSection } from "./types.ts";

/** How far back the previous bill may end for the next one to carry on from it (one cycle, with slack). */
export const BILL_CYCLE_DAYS = 45;
/** The row that says what was paid or credited between two bills. */
export const BILL_PAYMENTS = "Payments and credits";

/**
 * A bill that prints only what's still owed (see `paymentsFromPrior`), put after the
 * account's previous bill: it starts the day after that one ends, opens at what it closed
 * at, drops the charges an earlier bill already listed (still unpaid, so not new), and one
 * PERIOD row says what was paid or credited in between.
 *
 * @param earlier the account's rows from earlier bills, to recognize charges still open.
 */
export function continueBill(
  s: ParsedAccountSection,
  prior: { periodEnd: string; closingBalanceCents: number },
  earlier: { date: string; amountCents: number; description: string }[],
): ParsedAccountSection {
  const key = (t: { date: string; amountCents: number; description: string }) => `${t.date}|${t.amountCents}|${t.description}`;
  const open = new Map<string, number>();
  for (const r of earlier) open.set(key(r), (open.get(key(r)) ?? 0) + 1);
  const transactions = s.transactions.filter((t) => {
    const n = open.get(key(t)) ?? 0;
    if (n === 0) return true;
    open.set(key(t), n - 1);
    return false;
  });
  const flows = transactions.reduce((a, t) => a + t.amountCents, 0);
  const paid = s.closingBalanceCents - prior.closingBalanceCents - flows;
  return {
    ...s,
    periodStart: addDays(prior.periodEnd, 1),
    openingBalanceCents: prior.closingBalanceCents,
    transactions: paid === 0 ? transactions : [...transactions, { date: s.periodEnd, datePrecision: "PERIOD", description: BILL_PAYMENTS, amountCents: paid, section: BILL_PAYMENTS }],
  };
}
