import { decompose, valueAt } from "../../ledger/timeline.ts";
import type { DerivedFigure } from "../derived/types.ts";
import { household } from "../householdView.ts";
import type { Book } from "../load.ts";
import { centsRoute, invariant, ratioRoute, rederiveList } from "../proof/independence.ts";
import type { Rederivation, RederivedRoute } from "../proof/types.ts";
import type { InvestmentsReport, PositionRow } from "../reports/investments.ts";

/**
 * Investments' derived figures worked out a second way (F5): position by position from
 * each one's printed value, expense ratio and cost (never the report's own fee or gain per
 * position, nor its totals), the money held from the ledger's balances summed account by
 * account, and each growth series from the account's timeline itself.
 */
export function rederiveInvestments(book: Book, rep: Pick<InvestmentsReport, "asOf" | "positions" | "accounts" | "growth">, figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const ledger = household(book).ledger;
  const timeline = new Map(ledger.accounts.map((a) => [a.id, a.timeline]));
  const investment = new Set(ledger.accounts.filter((a) => a.isInvestment).map((a) => a.id));
  const P = rep.positions;
  const balances = rep.accounts.reduce((s, a) => s + valueAt(timeline.get(a.accountId)!, rep.asOf).cents, 0);
  const sum = (xs: PositionRow[], f: (p: PositionRow) => number) => xs.reduce((s, p) => s + f(p), 0);
  const fee = (p: PositionRow) => Math.max(0, Math.round(p.valueCents * p.expenseRatio!));
  const rated = P.filter((p) => p.expenseRatio != null);
  const known = sum(rated, (p) => Math.max(0, p.valueCents));
  const fees = sum(rated, fee);
  const taxable = P.filter((p) => p.treatment === "Taxable" && p.kind !== "CASH" && p.kind !== "ACCOUNT");
  const gain = (p: PositionRow) => p.valueCents - p.costBasisCents!;
  const withCost = taxable.filter((p) => p.costBasisCents != null);
  const tie: RederivedRoute = invariant("positions add up to the ledger's balances", { cents: sum(P, (p) => p.valueCents) }, sum(P, (p) => p.valueCents) === balances, `the positions and balancing lines make ${sum(P, (p) => p.valueCents) / 100}; the accounts' balances on ${rep.asOf} make ${balances / 100}`);
  const POS = "each position's printed value, ratio and cost, re-added";

  // Each growth series' last point: from the accounts' timelines, value at its end and every dollar put in.
  const series = new Map(rep.growth.map((s) => [s.accountId ?? "all", s]));
  const ids = rep.growth.filter((s) => s.accountId).map((s) => s.accountId!);
  const grown = (key: string, end: string) => {
    const accts = key === "all" ? ids : [key];
    let value = 0;
    let moneyIn = 0;
    for (const id of accts) {
      const t = timeline.get(id);
      if (!t?.firstDay || t.firstDay > end) continue;
      const d = decompose(t, t.firstDay, end);
      value += d.closingCents;
      moneyIn += d.openingCents + d.contributionsCents;
    }
    return { value, moneyIn };
  };
  const TL = "the account's timeline: its first opening balance and every contribution since, and its balance that day";

  return rederiveList(figures, (f) => {
    const v = f.value;
    switch (f.figure) {
      case "stocks": {
        const stocks = sum(P, (p) => (p.weights ? Math.round(p.valueCents * (p.weights.US_STOCK ?? 0)) + Math.round(p.valueCents * (p.weights.INTL_STOCK ?? 0)) : 0));
        const all = sum(P, (p) => (p.weights ? Object.values(p.weights).reduce((s, w) => s + Math.round(p.valueCents * w), 0) : p.valueCents));
        return [ratioRoute(POS, v, all ? stocks / all : 0, "US and international stock weights times each position's value, over all of them", 1e-9), tie];
      }
      case "fund-costs":
        return [centsRoute(POS, v, fees, "each fund's value × its expense ratio")];
      case "weighted-ratio":
        return [ratioRoute(POS, v, known ? fees / known : null, "fund expenses over the value held with a known ratio")];
      case "ratio-unknown":
        return [centsRoute("the accounts' balances on the ledger, less positions with a known ratio", v, Math.max(0, balances - known), "balances summed account by account"), tie];
      case "unrealized":
        return [centsRoute(POS, v, sum(withCost, gain), "value less printed cost, taxable positions")];
      case "gains":
        return [centsRoute(POS, v, sum(withCost, (p) => Math.max(0, gain(p))), "positions above their printed cost")];
      case "losses":
        return [centsRoute(POS, v, sum(withCost, (p) => Math.min(0, gain(p))), "positions below their printed cost")];
      case "cost-unknown":
        return [centsRoute(POS, v, sum(taxable.filter((p) => p.costBasisCents == null), (p) => p.valueCents), "taxable positions with no printed cost")];
      case "account-fees":
        return [
          centsRoute(
            "each account's timeline fees over its last twelve months",
            v,
            rep.accounts.reduce((s, a) => (investment.has(a.accountId) ? s + decompose(timeline.get(a.accountId)!, a.feesWindow.from, a.feesWindow.to).feesCents : s), 0),
            "the fees each statement takes, over the window",
            rep.accounts.length,
          ),
        ];
      case "growth-point": {
        const [acct, end, col] = (f.key ?? "").split("|");
        if (!series.get(acct!)?.points.some((x) => x.end === end)) return null;
        const g = grown(acct!, end!);
        return [centsRoute(TL, v, col === "value" ? g.value : col === "money-in" ? g.moneyIn : g.value - g.moneyIn, `through ${end}`, 1)];
      }
      case "treatment":
        return [centsRoute(POS, v, sum(rep.positions.filter((p) => p.treatment === f.key), (p) => p.valueCents), "positions held that way")];
      case "treatment-share":
      case "treatment-class":
        return { none: "A share of positions this page lists, each a holding with its own statement; the treatment's value is re-added from the positions." };
      case "growth-value":
      case "growth-money-in":
      case "growth-growth": {
        const s = series.get(f.key ?? "");
        const last = s?.points.at(-1);
        if (!last) return null;
        const g = grown(f.key!, last.end);
        const cents = f.figure === "growth-value" ? g.value : f.figure === "growth-money-in" ? g.moneyIn : g.value - g.moneyIn;
        return [centsRoute(TL, v, cents, `through ${last.end}`, 1)];
      }
      default:
        return null;
    }
  });
}

