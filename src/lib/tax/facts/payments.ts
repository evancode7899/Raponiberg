import type { PaymentAttribution } from "../profile.ts";

/**
 * Tax payments and refunds found in the bank ledger (IRS Direct Pay / EFTPS, CT DRS,
 * state refunds). Each is attributed to a tax year by date — January payments are the
 * prior year's 4th-quarter estimate, February–April payments settle the prior year's
 * return, the rest are this year's estimates — and the owner can re-attribute any row.
 */

export type TaxAuthority = "FEDERAL" | "CT" | "OTHER_STATE";

export type TaxPaymentRow = {
  transactionId: string;
  date: string;
  /** Positive: paid to the authority; negative: refund received. */
  amount: number;
  payee: string;
  authority: TaxAuthority;
  attribution: PaymentAttribution;
  overridden: boolean;
  /** Why it's attributed this way: its date, the filed return (which shows what was owed), or the owner. */
  basis: "DATE" | "FILED_RETURN" | "OWNER";
};

/** What each filed return came to, by tax year: positive owed at filing, negative refunded, null when not filed (or not on file). */
export type FiledBalances = Record<number, Partial<Record<TaxAuthority, number | null>>>;

const FEDERAL = /\bIRS\b|USATAXPYMT|EFTPS|US TREASURY.*TAX/i;
const CT = /\bCT\b.*\bDRS\b|STATE OF CT|CT DEPT.*REV|CONNECTICUT.*REVENUE|CT DRS/i;
const OTHER_STATE = /NYS.*TAX|NYSTTAXRFD|NYS DTF|STATE.*TAX REF|DEPT.*TAXATION/i;

export function taxAuthority(payee: string): TaxAuthority | null {
  if (FEDERAL.test(payee)) return "FEDERAL";
  if (CT.test(payee)) return "CT";
  if (OTHER_STATE.test(payee)) return "OTHER_STATE";
  return null;
}

export function defaultAttribution(date: string, amount: number): PaymentAttribution {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (amount < 0) return { kind: "REFUND", taxYear: year - 1 };
  if (month === 1) return { kind: "ESTIMATE", taxYear: year - 1 };
  if (month <= 4) return { kind: "BALANCE_DUE", taxYear: year - 1 };
  return { kind: "ESTIMATE", taxYear: year };
}

/**
 * Tax payments and refunds from the Book's tax rows (see book/taxPayments.ts), each
 * attributed to a tax year by date unless the owner re-attributed it. A filed return
 * settles the February–April ambiguity: a payment then can only be the prior year's
 * balance due if that return showed an amount owed; when it showed a refund (or nothing
 * owed), the payment is the new year's first estimate.
 */
export function taxPaymentsFrom(
  rows: { id: string; date: string; amountCents: number; payee: string; authority: TaxAuthority }[],
  overrides: Record<string, PaymentAttribution>,
  filed: FiledBalances = {},
): TaxPaymentRow[] {
  return rows.map((r) => {
    // Ledger sign: outflow negative. Here: paid positive.
    const amount = -r.amountCents;
    const o = overrides[r.id];
    const base = { transactionId: r.id, date: r.date, amount, payee: r.payee, authority: r.authority };
    if (o) return { ...base, attribution: o, overridden: true, basis: "OWNER" as const };
    const byDate = defaultAttribution(r.date, amount);
    const owed = filed[byDate.taxYear]?.[r.authority];
    if (byDate.kind === "BALANCE_DUE" && owed != null && owed <= 0) {
      return { ...base, attribution: { kind: "ESTIMATE" as const, taxYear: byDate.taxYear + 1 }, overridden: false, basis: "FILED_RETURN" as const };
    }
    return { ...base, attribution: byDate, overridden: false, basis: owed != null && byDate.kind !== "ESTIMATE" ? ("FILED_RETURN" as const) : ("DATE" as const) };
  });
}
