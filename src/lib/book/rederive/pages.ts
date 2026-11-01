import type { CardPerksReport } from "../../cardPerks/types.ts";
import type { HsaReport } from "../../hsa/report.ts";
import type { PolicyView } from "../../insurance/report.ts";
import type { DerivedFigure } from "../derived/types.ts";
import type { Book } from "../load.ts";
import { centsRoute, ratioRoute, rederiveList } from "../proof/independence.ts";
import type { Rederivation } from "../proof/types.ts";

/**
 * The smaller pages' derived figures worked out a second way (F5), or declared: card perks
 * from each card's own fee rows, credits and perk lines; HSA's edge by the closed form of
 * both accounts' growth; insurance premiums paid from the Book's rows. Counts of a report's
 * own verdicts (integrity tiles, limits still open) and facts as a document prints them (a
 * fund notice, a policy schedule, the tax plan's amounts) say why there's no second route.
 */

/** Card perks for each year (key: the year), from each card's own rows and perk lines rather than the year's totals. */
export function rederiveCardPerks(reports: Pick<CardPerksReport, "year" | "cards">[], figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const byYear = new Map(reports.map((r) => [String(r.year), r.cards]));
  const ROUTE = "each card's fee rows, credits and perk lines, re-added";
  return rederiveList(figures, (f) => {
    const cards = byYear.get(f.key ?? "");
    if (!cards) return null;
    const sum = <T,>(xs: T[], g: (x: T) => number) => xs.reduce((s, x) => s + g(x), 0);
    const used = sum(cards, (c) => sum(c.perks, (l) => l.usedCents));
    const missed = sum(cards, (c) => sum(c.perks, (l) => l.missedCents));
    const offers = sum(cards, (c) => sum(c.credits.filter((x) => x.kind === "OFFER"), (x) => x.amountCents));
    const fees = sum(cards, (c) => -sum(c.fee.rows, (r) => r.amountCents));
    const rewards = sum(cards, (c) => c.rewards.valueCents);
    switch (f.figure) {
      case "net-value":
        return [centsRoute(ROUTE, f.value, rewards + used + offers - fees, "rewards + perk credits used + offers − the annual fee rows")];
      case "rewards":
        return [centsRoute(ROUTE, f.value, rewards, "each card's rewards, as its statements print them (or expected)")];
      case "credits":
        return [centsRoute(ROUTE, f.value, used + offers, "each perk line's credits used, plus the offer credits")];
      case "capture":
        return [ratioRoute(ROUTE, f.value, used + missed > 0 ? used / (used + missed) : null, "credits used over used and lapsed, perk line by perk line")];
      case "remaining":
        return [centsRoute(ROUTE, f.value, sum(cards, (c) => sum(c.perks, (l) => l.remainingCents)), "what each perk line still has")];
      default:
        return null;
    }
  });
}

/** HSA › Growth: both accounts' worth in the plan year by the closed form (a geometric series for the taxable account), not the year-by-year loop. */
export function rederiveHsa(r: Pick<HsaReport, "growth">, figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const g = r.growth;
  const a = g.assumptions;
  const open = g.path[0]?.hsaCents ?? 0;
  const n = a.years;
  const hsa = 1 + (Math.pow(1 + a.rate, n) - 1) * (a.growthCovered ? 1 : 1 - a.exitRate);
  const d = Math.min(Math.max(0, a.dividendYield), Math.max(0, a.rate));
  const k = 1 + a.rate - d * a.taxableRate;
  const value = Math.pow(k, n);
  const basis = 1 + d * (1 - a.taxableRate) * (Math.abs(k - 1) < 1e-12 ? n : (value - 1) / (k - 1));
  const taxable = value - a.taxableRate * Math.max(0, value - basis);
  return rederiveList(figures, (f) =>
    f.figure === "edge" ? [centsRoute("both accounts in closed form", f.value, Math.round(open * hsa) - Math.round(open * taxable), "(1 + r)ⁿ in the HSA; the taxable account grows (1 + r − dividend tax) a year, its basis a geometric series", 2)] : null,
  );
}

/** Insurance: premiums paid re-added from the Book's own rows; the rest is the policy as it prints. */
export function rederiveInsurance(book: Book, views: PolicyView[], figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const byKey = new Map(views.map((v) => [v.policy.policyNumber, v]));
  return rederiveList(figures, (f) => {
    const v = byKey.get(f.key ?? "");
    if (!v) return null;
    if (f.figure === "paid") return [centsRoute("the Book's rows, re-added", f.value, v.payments.reduce((s, x) => s - (book.rowById.get(x.rowId)?.amountCents ?? 0), 0), "each premium row's amount as its statement prints it")];
    if (f.figure === "years-paid") return { none: "A count of the policy years the payee matching found a premium for: a verdict, not a sum." };
    return { none: "As the policy, its schedule or the insurer's summary prints it." };
  });
}

/** Figures with no second route, each with its reason. */
export const declared = (why: string) => (figures: readonly DerivedFigure[]) => rederiveList(figures, () => ({ none: why }));

export const INTEGRITY_WHY = "A count over the integrity report's own lists (the proof lists every one it counts): the checks behind it are the independent source.";
export const LIMITS_WHY = "The tax plan's verdict per yearly limit, or wages as the year's pay stubs print them: the limit's own proof and the pay proof re-add those from the Book.";
export const CALENDAR_WHY = "The tax plan's amount (W-4 extra per paycheck, a Q4 safe-harbor shortfall): Taxes › W-4 and the estimate's own proofs re-derive the plan.";
export const TAXES_WHY = "The tax engine's own lines for each return (joint, each spouse separately), as the Worksheet states them: the tax estimate's proofs re-derive the engine's inputs from the Book.";
export const FUNDS_WHY = "As the manager's notices and capital statements print it: each notice is its own source, and the chain re-adds what's worked from them.";
