import type { Book } from "../book/load.ts";
import type { PersonPayYear } from "../book/pay.ts";
import { cashFlowContributions } from "../book/reports/cashFlow.ts";

/**
 * From "Saved from take-home" (Cash flow) to "Saved incl. retirement" (Annual), over the
 * same window. The two read the same Cash flow rows for everything but pay and taxes
 * (book/definitions.ts), so what separates them is named here line by line:
 *
 *   saved from take-home
 *   + 401(k) and HSA deferrals and employer money (on the stubs, never deposited)
 *   + brokerage dividends (income on brokerage statements, not bank rows)
 *   + net pay the stubs show that Cash flow has no paycheck deposit for, split by why
 *   − paycheck deposits on Cash flow with no stub this year
 *   ± tax rows, by bank date (Annual) vs. Cash flow's day
 *   = saved incl. retirement
 *
 * `unexplained` is whatever those lines leave (rounding of statement totals spread over
 * their days); it is shown, never folded into another line.
 */
export type SavedBridge = {
  takeHome: number;
  deferrals: number;
  employer: number;
  dividends: number;
  /** Year-to-date net pay with no stub on file for it (an earlier paycheck, another payroll's stubs). */
  payYtdOnly: number;
  /** Net pay on stubs on file that no tracked account received (an account without statements, a split deposit). */
  payNotDeposited: number;
  /** Net pay on this year's stubs whose deposit Cash flow counts in another year, or not as a paycheck. */
  payOtherYear: number;
  /** Paycheck deposits on Cash flow tied to no stub this year (a positive amount, subtracted). */
  depositsWithoutStub: number;
  /** Taxes paid and refunds by bank date (Annual) less the same rows as Cash flow counts them. */
  taxTiming: number;
  unexplained: number;
  saved: number;
};

export type SavedBridgeLine = Exclude<keyof SavedBridge, "saved">;

/** The lines in the order they're shown, each signed as it adds to the bridge. */
export const SAVED_BRIDGE_LINES: SavedBridgeLine[] = ["takeHome", "deferrals", "employer", "dividends", "payYtdOnly", "payNotDeposited", "payOtherYear", "depositsWithoutStub", "taxTiming", "unexplained"];
export const savedBridgeSign = (l: SavedBridgeLine): 1 | -1 => (l === "depositsWithoutStub" ? -1 : 1);

/** The parts of a bridge before `unexplained`, added with their signs. */
export function savedBridgeParts(b: Omit<SavedBridge, "unexplained" | "saved">): number {
  return SAVED_BRIDGE_LINES.filter((l) => l !== "unexplained").reduce((s, l) => s + savedBridgeSign(l) * b[l as Exclude<SavedBridgeLine, "unexplained">], 0);
}

export function savedBridge(
  book: Book,
  x: {
    from: string;
    to: string;
    /** Each person's pay for the window's year, as the waterfall read it. */
    pays: PersonPayYear[];
    dividends: number;
    /** The waterfall's tax rows (taxPayments.ts), and what it counted from them. */
    taxIds: Set<string>;
    taxesPaid: number;
    refunds: number;
    /** Saved incl. retirement, as the waterfall worked it out. */
    saved: number;
  },
): SavedBridge {
  // Cash flow's own selection and rounding (cashFlow.ts), so `takeHome` is its figure.
  let income = 0;
  let spending = 0;
  let taxIncome = 0;
  let taxSpending = 0;
  const paycheck = new Map<string, number>();
  for (const { row: r, cents } of cashFlowContributions(book, [{ start: x.from, end: x.to }], null)) {
    if (r.lane === "INCOME") income += cents;
    else if (r.lane === "EXPENSE") spending -= cents;
    else continue;
    if (x.taxIds.has(r.id)) {
      if (r.lane === "INCOME") taxIncome += cents;
      else taxSpending -= cents;
    } else if (r.lane === "INCOME" && r.category === "Paycheck" && r.reimbursement?.source !== "stub") paycheck.set(r.id, (paycheck.get(r.id) ?? 0) + cents);
  }
  const takeHome = Math.round(income) - Math.round(spending);

  const sum = (f: (p: PersonPayYear) => number) => x.pays.reduce((s, p) => s + f(p), 0);
  const stubs = x.pays.flatMap((p) => p.employers.flatMap((e) => e.stubs));
  const stubNet = stubs.reduce((s, st) => s + st.printed.netCurrent, 0);
  // One deposit can carry two paychecks: each linked row once.
  const linked = [...new Set(stubs.map((s) => s.depositTransactionId).filter((id): id is string => !!id))].map((id) => book.rowById.get(id)).filter((r) => r != null);
  const linkedCents = linked.reduce((s, r) => s + r.amountCents, 0);
  const linkedHere = linked.reduce((s, r) => s + (paycheck.get(r.id) ?? 0), 0);
  const paycheckCents = [...paycheck.values()].reduce((s, v) => s + v, 0);

  const parts = {
    takeHome,
    deferrals: sum((p) => p.totals.deferrals),
    employer: sum((p) => p.totals.employerRetirement + p.totals.employerHsa),
    dividends: x.dividends,
    payYtdOnly: sum((p) => p.totals.net) - stubNet,
    payNotDeposited: stubNet - linkedCents,
    payOtherYear: Math.round(linkedCents - linkedHere),
    depositsWithoutStub: Math.round(paycheckCents - linkedHere),
    taxTiming: Math.round(x.refunds - taxIncome - (x.taxesPaid - taxSpending)),
  };
  return { ...parts, unexplained: x.saved - savedBridgeParts(parts), saved: x.saved };
}
