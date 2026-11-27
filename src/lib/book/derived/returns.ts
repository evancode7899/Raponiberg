import type { ChainLine, ProofLink } from "../proof/types.ts";
import type { PortfolioReturns, ReturnsQuarter } from "../reports/portfolioReturns.ts";
import { c, cellKey, ln, r, t, type DerivedFigure } from "./types.ts";

/**
 * Investments › Returns (reports/portfolioReturns.ts): every number the tab draws, each with
 * how it is worked out. Keys: cellKey("returns", quarter, column).
 *
 *  - ret-quarter: a quarter's return, the portfolio's ("portfolio") or the S&P 500's ("sp500");
 *  - ret-cum: each chained since the comparison's start, through the quarter;
 *  - ret-value: the portfolio's dollars ("actual"), the same money in the S&P 500 ("sp500")
 *    and the money put in ("money-in"), at the quarter's end;
 *  - ret-since / ret-annualized / ret-ahead: the comparison's headline.
 */
export const returnsKey = (quarter: string, col: string) => cellKey("returns", quarter, col);

const pct = (x: number, d = 2) => `${x >= 0 ? "" : "−"}${(Math.abs(x) * 100).toFixed(d)}%`;
const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const statementLink = (q: NonNullable<ReturnsQuarter["sp500"]>, documentId: string, asOf: string): Partial<ChainLine> => {
  const id = q.statements[documentId];
  const link: ProofLink | undefined = id ? { label: `The statement of ${asOf}`, descriptor: { report: "statement", statementId: id } } : undefined;
  return { source: "proven", ...(link ? { link } : {}) };
};

/** How the S&P 500's quarter is read off the statements, line by line. */
export function sp500Lines(q: ReturnsQuarter): ChainLine[] {
  const s = q.sp500;
  if (!s) return [];
  const x = s.source;
  switch (x.kind) {
    case "printed":
      return [ln(`The S&P 500 Index over the 3 months to ${x.asOf}, as the statement holding ${x.fund} prints it`, r(s.ratio), undefined, statementLink(s, x.documentId, x.asOf))];
    case "unit-value": {
      const uv = (u: typeof x.from) => u.valueCents / 100 / u.units;
      return [
        ln(`${x.fund} on ${x.to.asOf}: ${usd(x.to.valueCents)} over ${x.to.units} units`, t(`$${uv(x.to).toFixed(4)} a unit`), undefined, statementLink(s, x.to.documentId, x.to.asOf)),
        ln(`On ${x.from.asOf}: ${usd(x.from.valueCents)} over ${x.from.units} units`, t(`$${uv(x.from).toFixed(4)} a unit`), "÷", statementLink(s, x.from.documentId, x.from.asOf)),
        ln("Change in its value per unit (a trust pays nothing out: its dividends stay in it)", r(s.ratio), "=", { note: "value per unit at the end ÷ value per unit at the start − 1" }),
      ];
    }
    case "fund-months":
      return [
        ...x.steps.map((st, i) =>
          ln(
            `${st.asOf}: ${st.price} + ${st.dividendCents == null ? "no dividends on file" : `${(st.dividendCents / 100).toFixed(2)} of dividends on ${st.quantity} shares`}, over ${st.prevPrice}`,
            r((st.price + (st.dividendCents ? st.dividendCents / 100 / st.quantity : 0)) / st.prevPrice),
            i ? "×" : undefined,
            statementLink(s, st.documentId, st.asOf),
          ),
        ),
        ln(`${x.fund}, its months chained, less one${x.total ? "" : " (price only: some month's dividends aren't on file, so it runs a little low)"}`, r(s.ratio), "=", { note: "Each month is one share's price plus the dividends a share the account's statements print, over its price the month before." }),
      ];
    case "backed-out":
      return [
        ln(`The S&P 500 Index over the year to ${x.asOf}, as printed`, r(x.oneYear), undefined, statementLink(s, x.documentId, x.asOf)),
        ...x.after.map((a) => ln(`Less ${a.quarter} (1 + its return)`, r(a.ratio), "÷")),
        ln("Backed out: (1 + the year) ÷ the three later quarters − 1", r(s.ratio), "=", { note: "From figures printed to two decimals, so good to about 0.02 of a point." }),
      ];
  }
}

export const SP500_SOURCE_WORDS: Record<NonNullable<ReturnsQuarter["sp500"]>["source"]["kind"], string> = {
  printed: "the S&P 500 Index's own return, as a statement prints it",
  "unit-value": "an S&P 500 trust's value per unit, statement to statement",
  "fund-months": "an S&P 500 fund's monthly statements, price and dividends",
  "backed-out": "backed out of the S&P 500 Index's 1-year return a later statement prints",
};

export function returnsDerived(ret: PortfolioReturns): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  for (const q of ret.quarters) {
    if (q.portfolio != null)
      out.push({
        figure: "ret-quarter",
        key: returnsKey(q.quarter, "portfolio"),
        describes: `Your portfolio's return, ${q.label}${q.through ? ` through ${q.through}` : ""}: time-weighted, net of fees, money in and out left out`,
        value: r(q.portfolio),
        lines: [
          ...q.months.map((m, i) => ln(`${m.label}: Modified Dietz over every investment account`, m.ratio == null ? t("not measured") : r(m.ratio), i ? "×" : undefined)),
          ln("Chained: (1 + each month) multiplied, less one", r(q.portfolio), "="),
        ],
      });
    if (q.sp500)
      out.push({
        figure: "ret-quarter",
        key: returnsKey(q.quarter, "sp500"),
        describes: `The S&P 500's return, ${q.label}, dividends in: ${SP500_SOURCE_WORDS[q.sp500.source.kind]}`,
        value: r(q.sp500.ratio),
        lines: sp500Lines(q),
      });
  }
  const w = ret.window;
  if (!w) return out;
  const byQuarter = new Map(ret.quarters.map((q) => [q.quarter, q]));
  w.points.forEach((p, i) => {
    const run = w.points.slice(0, i + 1).map((x) => byQuarter.get(x.quarter)!);
    for (const col of ["portfolio", "sp500"] as const)
      out.push({
        figure: "ret-cum",
        key: returnsKey(p.quarter, col),
        describes: `${col === "portfolio" ? "Your portfolio" : "The S&P 500"}, ${w.fromLabel} through ${p.label}, chained`,
        value: r(col === "portfolio" ? p.portfolioCum : p.sp500Cum),
        lines: [...run.map((q, j) => ln(q.label, r(col === "portfolio" ? q.portfolio! : q.sp500!.ratio), j ? "×" : undefined)), ln("(1 + each quarter) multiplied, less one", r(col === "portfolio" ? p.portfolioCum : p.sp500Cum), "=")],
      });
    const prev = i ? w.points[i - 1]! : null;
    out.push(
      {
        figure: "ret-value",
        key: returnsKey(p.quarter, "actual"),
        describes: `Your portfolio at the end of ${p.label}: every investment account's balance`,
        value: c(p.actualCents),
        lines: [ln(`Every investment account's balance on ${p.end}`, c(p.actualCents), undefined, { source: "proven" })],
      },
      {
        figure: "ret-value",
        key: returnsKey(p.quarter, "sp500"),
        describes: `Had it all been in the S&P 500 since ${w.fromLabel}: its value at the end of ${p.label}`,
        value: c(p.sp500Cents),
        lines: [
          ln(prev ? `At the end of ${prev.label} (${usd(prev.sp500Cents)}), grown by the S&P 500's ${pct(byQuarter.get(p.quarter)!.sp500!.ratio)}` : `What the portfolio held when ${p.label} began (${usd(w.openingCents)}), grown by the S&P 500's ${pct(byQuarter.get(p.quarter)!.sp500!.ratio)}`, c(p.grownCents)),
          ...p.flows.map((f) =>
            ln(
              f.firstOnFile ? `${usd(f.cents)} already in an account whose first statement begins ${f.day}, grown from then` : `${usd(f.cents)} put in${f.cents < 0 ? " (taken out)" : ""} the month of ${f.day.slice(0, 7)}, grown from mid-month`,
              c(f.grownCents),
              "+",
              { note: `${(f.weight * 100).toFixed(0)}% of the quarter in the S&P 500, which grows evenly through it` },
            ),
          ),
          ln(`At the end of ${p.label}`, c(p.sp500Cents), "="),
        ],
      },
      {
        figure: "ret-value",
        key: returnsKey(p.quarter, "money-in"),
        describes: `Money in through the end of ${p.label}: what the portfolio held at the start of ${w.fromLabel}, plus every dollar put in, less every dollar taken out`,
        value: c(p.moneyInCents),
        lines: [ln(prev ? `Through ${prev.label}` : `On hand when ${w.fromLabel} began`, c(prev ? prev.moneyInCents : w.openingCents)), ...p.flows.map((f) => ln(f.firstOnFile ? `Already in an account first on file ${f.day}` : `Put in the month of ${f.day.slice(0, 7)}`, c(f.cents), "+")), ln(`Through ${p.label}`, c(p.moneyInCents), "=")],
      },
    );
  });
  const last = w.points.at(-1)!;
  const n = w.points.length;
  for (const col of ["portfolio", "sp500"] as const) {
    const cum = col === "portfolio" ? last.portfolioCum : last.sp500Cum;
    const who = col === "portfolio" ? "Your portfolio" : "The S&P 500";
    out.push({
      figure: "ret-since",
      key: col,
      describes: `${who} since ${w.fromLabel}, through ${w.toLabel}: chained, ${col === "portfolio" ? "net of fees" : "dividends in"}`,
      value: r(cum),
      lines: [ln(`${n} quarter${n === 1 ? "" : "s"}, each (1 + its return), multiplied, less one`, r(cum), undefined, { note: "The last quarter's chained figure in the table." })],
    });
    if (w.annualized) {
      const a = col === "portfolio" ? w.annualized.portfolio : w.annualized.sp500;
      out.push({ figure: "ret-annualized", key: col, describes: `${who} since ${w.fromLabel}, a year`, value: r(a), lines: [ln("Chained since the start", r(cum)), ln(`Over ${w.days} days, a year: (1 + chained)^(365 ÷ ${w.days}) − 1`, r(a))] });
    }
  }
  const both = ret.quarters.filter((q) => q.portfolio != null && q.sp500);
  const ahead = both.filter((q) => q.portfolio! > q.sp500!.ratio);
  out.push({
    figure: "ret-ahead",
    describes: "Quarters your portfolio beat the S&P 500, of those with both figures",
    value: t(`${ahead.length} of ${both.length}`),
    lines: [ln("Quarters with both returns", t(String(both.length))), ln("Your portfolio's higher", t(String(ahead.length)))],
    parts: both.map((q) => ({ label: q.label, value: r(q.portfolio! - q.sp500!.ratio), sub: q.portfolio! > q.sp500!.ratio ? "ahead" : "behind" })),
  });
  return out;
}
