import { minIso, periodsBetween } from "../../dates/isoDate.ts";
import { isSp500Fund } from "../../investments/sp500.ts";
import { decompose, dietzParts, MIN_RETURN_CAPITAL_CENTS, valueAt } from "../../ledger/timeline.ts";
import type { DerivedFigure } from "../derived/types.ts";
import { FEE_YEARS } from "../derived/investments.ts";
import { household } from "../householdView.ts";
import type { Book } from "../load.ts";
import { centsRoute, invariant, ratioRoute, rederiveList, textRoute } from "../proof/independence.ts";
import type { Rederivation, RederivedRoute } from "../proof/types.ts";
import type { InvestmentsReport, PositionRow } from "../reports/investments.ts";

/**
 * Investments' derived figures worked out a second way (F5): position by position from
 * each one's printed value, expense ratio and cost (never the report's own fee or gain per
 * position, nor its totals), the money held from the ledger's balances summed account by
 * account, and each growth series from the account's timeline itself.
 */
export function rederiveInvestments(book: Book, rep: Pick<InvestmentsReport, "asOf" | "positions" | "accounts" | "growth">, figures: readonly DerivedFigure[], returnRate: number | null = null): Record<string, Rederivation> {
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
      case "class": {
        const cls = f.key as keyof NonNullable<PositionRow["weights"]> | "UNCLASSIFIED";
        const cents = cls === "UNCLASSIFIED" ? sum(P.filter((p) => !p.weights), (p) => p.valueCents) : sum(P, (p) => Math.round(p.valueCents * (p.weights?.[cls] ?? 0)));
        return [centsRoute(POS, v, cents, "each position's value × its weight in the class", P.length)];
      }
      case "idle-cash":
        return [centsRoute(POS, v, sum(P.filter((p) => p.accountId === f.key), (p) => Math.round(p.valueCents * (p.weights?.CASH ?? 0))), "the account's positions × their cash part")];
      case "concentration":
        return [centsRoute(POS, v, sum(P.filter((p) => p.key === f.key), (p) => p.valueCents), "the security's positions in every account")];
      case "unclassified":
        return [centsRoute(POS, v, sum(P.filter((p) => !p.weights && p.key === f.key), (p) => p.valueCents), "its positions without a classification")];
      case "ratio-known":
        return [centsRoute(POS, v, known, "positions with a known expense ratio")];
      case "cost-known":
        return [centsRoute(POS, v, sum(withCost, (p) => p.valueCents), "taxable positions with a printed cost")];
      case "account-fee": {
        const a = rep.accounts.find((x) => x.accountId === f.key);
        if (!a) return null;
        return [centsRoute("the account's timeline fees over its last twelve months", v, decompose(timeline.get(a.accountId)!, a.feesWindow.from, a.feesWindow.to).feesCents, "the fees each statement takes, over the window")];
      }
      case "position": {
        const [acct, key, lot, col] = (f.key ?? "").split("|");
        const p = P.find((x) => x.accountId === acct && x.key === key && String(x.lot ?? 0) === lot);
        if (!p) return null;
        if (col === "gain" && p.costBasisCents != null) return [centsRoute(POS, v, gain(p), "value less printed cost")];
        if (col === "fee") return [centsRoute(POS, v, fee(p), "value × expense ratio")];
        if (col === "cost-20y" && returnRate != null) {
          // Year by year, the fund with and without its fee: what the fee took from the ending value.
          let gross = p.valueCents;
          let net = p.valueCents;
          for (let i = 0; i < FEE_YEARS; i++) {
            gross *= 1 + returnRate;
            net *= 1 + returnRate - p.expenseRatio!;
          }
          return [centsRoute("the fund grown year by year with and without its fee", v, Math.round(gross - net), `${FEE_YEARS} years at the forecast's return`, 1)];
        }
        return { none: "As the statement prints it (price, cost basis), or the fund's published expense ratio where none prints: each is its own source." };
      }
      case "drift":
      case "difference":
      case "fee-return":
        return { none: "Your target share of everything classified less what the class holds; holdings on file less the statement balance; the forecast's return on the saved drivers. The class's dollars and the balance are re-derived on their own." };
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


/**
 * Investments › Returns worked out a second way: each quarter's portfolio return from every
 * investment account's timeline month by month (Modified Dietz), chained, never the report's
 * own; the S&P 500's from the statements' holdings re-read from the Book; each balance and the
 * money in from the timelines; the chains and counts from the quarters' own figures.
 */
export function rederiveReturns(book: Book, rep: Pick<InvestmentsReport, "returns">, figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const ledger = household(book).ledger;
  const accounts = ledger.accounts.filter((a) => a.isInvestment);
  const through = book.horizon.netWorth;
  const quarters = new Map(rep.returns.quarters.map((q) => [q.quarter, q]));
  const fig = new Map(figures.map((f) => [`${f.figure}|${f.key ?? ""}`, f.value]));
  const ratioOf = (figure: string, key: string) => {
    const v = fig.get(`${figure}|${key}`);
    return v && "ratio" in v ? v.ratio : null;
  };
  const DIETZ = "each month re-worked from every investment account's timeline (Modified Dietz), chained";
  const quarterReturn = (start: string, end: string) => {
    let g = 1;
    let months = 0;
    for (const m of periodsBetween(start, minIso(end, through), "month")) {
      const to = minIso(m.end, through);
      let gain = 0;
      let capital = 0;
      for (const a of accounts) {
        if (!a.timeline.firstDay || a.timeline.firstDay > to || (a.timeline.lastDay ?? to) < m.start) continue;
        const p = dietzParts(a.timeline, m.start, to);
        gain += p.gainCents;
        capital += p.capitalCents;
      }
      if (capital < MIN_RETURN_CAPITAL_CENTS) continue;
      g *= 1 + gain / capital;
      months++;
    }
    return months ? g - 1 : null;
  };
  const sp500Position = (documentId: string) => book.holdings.find((h) => h.documentId === documentId)?.positions.find((p) => isSp500Fund(p));
  const balance = (iso: string) => accounts.reduce((s, a) => (a.timeline.firstDay && a.timeline.firstDay <= iso ? s + valueAt(a.timeline, iso).cents : s), 0);
  const w = rep.returns.window;

  return rederiveList(figures, (f) => {
    const v = f.value;
    const [, quarter, col] = (f.key ?? "").split("|");
    switch (f.figure) {
      case "ret-quarter": {
        const q = quarters.get(quarter!);
        if (!q) return null;
        if (col === "portfolio") return [ratioRoute(DIETZ, v, quarterReturn(q.start, q.end), `${q.start} to ${q.end}`, 1e-9)];
        const s = q.sp500?.source;
        if (!s) return null;
        const STMT = "the statements' holdings, re-read from the Book";
        if (s.kind === "printed") return [ratioRoute(STMT, v, sp500Position(s.documentId)?.printedIndex?.threeMonth ?? null, "the S&P 500 Index's 3-month return the statement prints", 1e-12)];
        if (s.kind === "unit-value") {
          const at = (id: string) => {
            const p = sp500Position(id);
            return p?.quantity ? p.valueCents / p.quantity : null;
          };
          const a = at(s.from.documentId);
          const b = at(s.to.documentId);
          return [ratioRoute(STMT, v, a && b ? b / a - 1 : null, "the trust's value over its units at each end", 1e-12)];
        }
        if (s.kind === "backed-out") {
          const year = sp500Position(s.documentId)?.printedIndex?.oneYear;
          const later = s.after.map((x) => ratioOf("ret-quarter", `returns|${x.quarter}|sp500`));
          return [ratioRoute(`${STMT}, and the later quarters' own figures`, v, year != null && later.every((x) => x != null) ? (1 + year) / later.reduce((g, x) => g * (1 + x!), 1) - 1 : null, "(1 + the printed year) ÷ the three later quarters − 1", 1e-12)];
        }
        return { none: "The fund's monthly statements, price and the dividends its account's statements print, chained as Net worth's benchmark chains them: each month's line links its statement." };
      }
      case "ret-cum": {
        if (!w) return null;
        const upto = w.points.slice(0, w.points.findIndex((p) => p.quarter === quarter) + 1);
        const chained = upto.reduce((g, p) => {
          const x = ratioOf("ret-quarter", `returns|${p.quarter}|${col}`);
          return g == null || x == null ? null : g * (1 + x);
        }, 1 as number | null);
        return [ratioRoute("the quarters' own figures, chained", v, chained == null ? null : chained - 1, `${upto.length} quarters from ${w.fromQuarter}`, 1e-12)];
      }
      case "ret-value": {
        const p = w?.points.find((x) => x.quarter === quarter);
        if (!p || !w) return null;
        if (col === "actual") return [centsRoute("every investment account's balance from its timeline", v, balance(p.end), `on ${p.end}`)];
        if (col === "money-in") {
          let cents = 0;
          for (const a of accounts) {
            const t = a.timeline;
            if (!t.firstDay || t.firstDay > p.end) continue;
            const d = decompose(t, t.firstDay > w.from ? t.firstDay : w.from, p.end);
            cents += d.openingCents + d.contributionsCents;
          }
          return [centsRoute("every investment account's timeline: on hand at the start (or when first on file) and every dollar in and out since", v, cents, `${w.from} to ${p.end}`, accounts.length)];
        }
        return { none: "A what-if: the S&P 500's quarters (each re-derived on its own) applied to the same money in and out (re-derived from the timelines)." };
      }
      case "ret-since":
      case "ret-annualized":
        return { none: "The last quarter's chained figure in the table (each quarter re-derived on its own), and that over its days, a year." };
      case "ret-ahead": {
        const both = rep.returns.quarters.map((q) => [ratioOf("ret-quarter", `returns|${q.quarter}|portfolio`), ratioOf("ret-quarter", `returns|${q.quarter}|sp500`)]).filter(([a, b]) => a != null && b != null);
        return [textRoute("the quarters' own figures, counted", v, `${both.filter(([a, b]) => a! > b!).length} of ${both.length}`, "quarters with both returns, and those the portfolio's is higher")];
      }
      default:
        return null;
    }
  });
}
