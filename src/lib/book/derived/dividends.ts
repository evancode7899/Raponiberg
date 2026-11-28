import type { DividendCalendar } from "../reports/dividends.ts";
import { c, cellKey, ln, type DerivedFigure } from "./types.ts";

/**
 * Investments › Dividends (reports/dividends.ts): each cell of the calendar (a security's
 * payments in a month), each security's twelve months, each month across them, and the
 * whole. Every payment links the statement that prints it. Keys: cellKey("div", row, month).
 */
export const divKey = (row: string, month: string) => cellKey("div", row, month);

export function dividendsDerived(d: DividendCalendar): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  const pay = (p: DividendCalendar["securities"][number]["payments"][number], i: number) =>
    ln(`${p.date}, as the statement prints it`, c(p.cents), i ? "+" : undefined, { source: "proven", ...(p.statementId ? { link: { label: `The statement holding ${p.date}`, descriptor: { report: "statement", statementId: p.statementId } } } : {}) });
  for (const s of d.securities) {
    for (const [month, cents] of Object.entries(s.byMonth)) {
      const ps = s.payments.filter((p) => p.date.startsWith(month));
      out.push({ figure: "div", key: divKey(s.key, month), describes: `${s.security} in ${s.accountName}: dividends paid in ${month}`, value: c(cents), lines: [...ps.map(pay), ...(ps.length > 1 ? [ln("Paid in the month", c(cents), "=")] : [])] });
    }
    out.push({ figure: "div", key: divKey(s.key, "total"), describes: `${s.security} in ${s.accountName}: dividends over the twelve months to ${d.through}`, value: c(s.totalCents), lines: [...s.payments.map(pay), ln("Twelve months", c(s.totalCents), "=")] });
  }
  for (const m of d.months) {
    if (!m.cents) continue;
    const parts = d.securities.filter((s) => s.byMonth[m.key]);
    out.push({ figure: "div", key: divKey("all", m.key), describes: `Dividends paid in ${m.label}, every account`, value: c(m.cents), lines: [...parts.map((s, i) => ln(`${s.security} (${s.accountName})`, c(s.byMonth[m.key]!), i ? "+" : undefined)), ln(m.label, c(m.cents), "=")] });
  }
  if (d.securities.length)
    out.push({
      figure: "div",
      key: divKey("all", "total"),
      describes: `Dividends over the twelve months ${d.from} to ${d.through}, every account`,
      value: c(d.totalCents),
      lines: [...d.securities.map((s, i) => ln(`${s.security} (${s.accountName})`, c(s.totalCents), i ? "+" : undefined)), ln("Twelve months", c(d.totalCents), "=")],
      parts: d.securities.map((s) => ({ label: s.security, value: c(s.totalCents), sub: s.accountName })),
    });
  return out;
}
