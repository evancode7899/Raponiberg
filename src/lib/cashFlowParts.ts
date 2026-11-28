import type { MerchantMonth, SpendingMonth, SpendingReport } from "./book/reports/spending.ts";

/**
 * Cash flow's payload in two parts (GET /api/dashboard/cash-flow?parts=…): the report without
 * each month's merchant list ("lean": all but the Merchants and Year over year tabs and the drill-downs read
 * nothing else, and it's most of the bytes), and the merchant lists alone ("merchants"), asked
 * for when a tab needs them. Joined again they are the report, value for value.
 */
export type CashFlowMerchants = { months: Record<string, MerchantMonth[]>; current: MerchantMonth[] | null };

const lean = (m: SpendingMonth): SpendingMonth => ({ ...m, merchants: [] });

export function leanReport<R extends Pick<SpendingReport, "months" | "current">>(r: R): R & { merchantsApart: true } {
  return { ...r, months: r.months.map(lean), current: r.current ? lean(r.current) : null, merchantsApart: true };
}

export function merchantsOf(r: Pick<SpendingReport, "months" | "current">): CashFlowMerchants {
  return { months: Object.fromEntries(r.months.map((m) => [m.start, m.merchants])), current: r.current?.merchants ?? null };
}

/** The lean report with its merchant lists put back. */
export function withMerchants<R extends Pick<SpendingReport, "months" | "current">>(r: R, m: CashFlowMerchants): R {
  return { ...r, months: r.months.map((x) => ({ ...x, merchants: m.months[x.start] ?? [] })), current: r.current ? { ...r.current, merchants: m.current ?? [] } : null };
}
