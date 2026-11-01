import type { InvestmentsReport } from "../reports/investments.ts";
import { c, cellKey, ln, r, type DerivedFigure } from "./types.ts";

/** A growth series' key: its account, or the household's ("all"). */
export const growthKey = (accountId: string | null) => accountId ?? "all";

/** The Investments page's derived figures: the stock share, fund and account fees, taxable gains, and each growth series' latest point. */
export function investmentsDerived(rep: InvestmentsReport): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  const share = (cls: string) => rep.allocation.find((x) => x.cls === cls)?.share ?? 0;
  const us = share("US_STOCK");
  const intl = share("INTL_STOCK");
  out.push({
    figure: "stocks",
    describes: `Stocks: US and international, of all holdings, as of ${rep.asOf}`,
    value: r(us + intl),
    lines: [ln("US stocks", r(us)), ln("International stocks", r(intl), "+"), ln("Stocks", r(us + intl), "=")],
    parts: rep.allocation.map((x) => ({ label: x.cls, value: c(x.cents), sub: `${(x.share * 100).toFixed(1)}% of holdings` })),
  });
  const fee = rep.positions.filter((p) => (p.annualFeeCents ?? 0) > 0);
  const f = rep.fees;
  out.push({
    figure: "fund-costs",
    describes: "Fund expenses a year, at today's balances",
    value: c(f.annualCents),
    lines: [
      ln("Held in funds with a known expense ratio", c(f.knownCents), undefined, { source: "proven" }),
      ...(f.weightedRatio != null ? [ln("× their value-weighted expense ratio", r(f.weightedRatio), "×")] : []),
      ln("Fund expenses a year", c(f.annualCents), "="),
    ],
    parts: fee.map((p) => ({ label: p.symbol ?? p.name, value: c(p.annualFeeCents!), sub: `${p.expenseRatio != null ? `${(p.expenseRatio * 100).toFixed(2)}%` : "?"} of ${Math.round(p.valueCents / 100).toLocaleString("en-US")} dollars` })),
    note: "Each fund's value × its expense ratio.",
  });
  if (f.weightedRatio != null)
    out.push({
      figure: "weighted-ratio",
      describes: "Value-weighted expense ratio",
      value: r(f.weightedRatio),
      lines: [ln("Fund expenses a year", c(f.annualCents)), ln("÷ held with a known ratio", c(f.knownCents), "÷"), ln("Weighted expense ratio", r(f.weightedRatio), "=")],
    });
  out.push({
    figure: "account-fees",
    describes: "Fees the accounts deducted over the last 12 months",
    value: c(f.accountFeesLast12Cents),
    lines: [
      ...rep.accounts.filter((a) => a.feesLast12Cents).map((a, i) => ln(`${a.name} (${a.feesWindow.from} – ${a.feesWindow.to})`, c(a.feesLast12Cents), i ? "+" : undefined, { source: "proven" })),
      ln("Account fees, last 12 months", c(f.accountFeesLast12Cents), "="),
    ],
  });
  out.push({
    figure: "ratio-unknown",
    describes: "Held where no expense ratio is known",
    value: c(f.unknownCents),
    lines: [ln("Invested", c(rep.totalCents), undefined, { source: "proven" }), ln("Held with a known ratio", c(f.knownCents), "−"), ln("Ratio unknown", c(f.unknownCents), "=")],
  });
  const g = rep.gains.taxable;
  const known = rep.positions.filter((p) => p.unrealizedCents != null);
  for (const [figure, describes, v] of [
    ["unrealized", "Unrealized gain on taxable positions with a printed cost", g.unrealizedCents],
    ["gains", "Taxable positions above cost", g.gainCents],
    ["losses", "Taxable positions below cost", g.lossCents],
  ] as const)
    out.push({
      figure,
      describes,
      value: c(v),
      lines: [
        ...(figure !== "losses" ? [ln("Positions above cost", c(g.gainCents), undefined, { source: "proven" as const })] : []),
        ...(figure !== "gains" ? [ln("Positions below cost", c(g.lossCents), figure === "losses" ? undefined : "+", { source: "proven" as const })] : []),
        ...(figure === "unrealized" ? [ln("Unrealized gain", c(v), "=")] : []),
      ],
      parts: known.filter((p) => (figure === "gains" ? p.unrealizedCents! > 0 : figure === "losses" ? p.unrealizedCents! < 0 : true)).map((p) => ({ label: p.symbol ?? p.name, value: c(p.unrealizedCents!) })),
      note: "Value less the cost basis the statement prints.",
    });
  out.push({
    figure: "cost-unknown",
    describes: "Taxable positions without a printed cost basis",
    value: c(g.costUnknownCents),
    lines: [ln("Taxable positions without a basis", c(g.costUnknownCents), undefined, { source: "proven" })],
  });
  // By tax treatment: each treatment's value, its share of everything, and its classes' shares.
  for (const t of rep.byTreatment) {
    out.push({ figure: "treatment", key: t.treatment, describes: `Held ${t.treatment.toLowerCase()}`, value: c(t.cents), lines: [ln("Positions held that way, added up", c(t.cents), undefined, { source: "proven" })] });
    if (rep.totalCents) out.push({ figure: "treatment-share", key: t.treatment, describes: `Held ${t.treatment.toLowerCase()}: share of everything invested`, value: r(t.cents / rep.totalCents), lines: [ln("Held that way", c(t.cents)), ln("÷ everything invested", c(rep.totalCents)), ln("Share", r(t.cents / rep.totalCents))] });
    for (const a of t.allocation) out.push({ figure: "treatment-class", key: `${t.treatment}|${a.cls}`, describes: `Held ${t.treatment.toLowerCase()}: ${a.cls} share`, value: r(a.share), lines: [ln(a.cls, c(a.cents)), ln(`÷ held ${t.treatment.toLowerCase()}`, c(t.cents)), ln("Share", r(a.share))] });
  }
  for (const s of rep.growth) {
    // Quarter by quarter: money in, value and growth to date at each quarter-end.
    for (const x of s.points) {
      const k = (col: string) => cellKey(growthKey(s.accountId), x.end, col);
      out.push(
        { figure: "growth-point", key: k("money-in"), describes: `${s.name}: money in through ${x.label}`, value: c(x.investedCents), lines: [ln("Deposits, rollovers and opening balances, net of withdrawals", c(x.investedCents), undefined, { source: "proven" })] },
        { figure: "growth-point", key: k("value"), describes: `${s.name}: value at the end of ${x.label}`, value: c(x.valueCents), lines: [ln(`Value, ${x.end}`, c(x.valueCents), undefined, { source: "proven" })] },
        { figure: "growth-point", key: k("growth"), describes: `${s.name}: growth through ${x.label}`, value: c(x.valueCents - x.investedCents), lines: [ln("Value", c(x.valueCents)), ln("Money in", c(x.investedCents), "−"), ln("Growth", c(x.valueCents - x.investedCents), "=")] },
      );
    }
    const last = s.points.at(-1);
    if (!last) continue;
    const key = growthKey(s.accountId);
    out.push(
      { figure: "growth-value", key, describes: `${s.name}: value at the end of ${last.label}`, value: c(last.valueCents), lines: [ln(`Value, ${last.end}`, c(last.valueCents), undefined, { source: "proven" })] },
      { figure: "growth-money-in", key, describes: `${s.name}: money in through ${last.label}`, value: c(last.investedCents), lines: [ln("Deposits, rollovers and opening balances, net of withdrawals", c(last.investedCents), undefined, { source: "proven" })] },
      {
        figure: "growth-growth",
        key,
        describes: `${s.name}: growth through ${last.label}`,
        value: c(last.valueCents - last.investedCents),
        lines: [ln("Value", c(last.valueCents)), ln("Money in", c(last.investedCents), "−"), ln("Growth", c(last.valueCents - last.investedCents), "=")],
      },
    );
  }
  return out;
}
