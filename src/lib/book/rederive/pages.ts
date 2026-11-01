import type { CardPerksReport, CardScore, PerkPeriod } from "../../cardPerks/types.ts";
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

/**
 * Card perks for each year (key: the year, alone or leading), from each card's own rows and
 * perk lines rather than the totals: the headline and each card from fee rows, offer credits
 * and perk lines; each perk line from its periods; the Best card lines from each card's
 * spending in them; the rewards mix from each card's earn lines. Valuations at the card
 * list's rates and your point values, and what the matcher reads off a statement, say why
 * there's no second route.
 */
export function rederiveCardPerks(reports: (Pick<CardPerksReport, "year" | "cards"> & Partial<Pick<CardPerksReport, "optimizer">>)[], figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const byYear = new Map(reports.map((r) => [String(r.year), r]));
  const ROUTE = "each card's fee rows, credits and perk lines, re-added";
  const sum = <T,>(xs: readonly T[], g: (x: T) => number) => xs.reduce((s, x) => s + g(x), 0);
  const lineUsed = (c: CardScore) => sum(c.perks, (l) => l.usedCents);
  const offerCredits = (c: CardScore) => sum(c.credits.filter((x) => x.kind === "OFFER"), (x) => x.amountCents);
  const feeRows = (c: CardScore) => -sum(c.fee.rows, (r) => r.amountCents);
  const held = (x: PerkPeriod) => x.status !== "NOT_HELD" && x.status !== "NOT_OFFERED";
  return rederiveList(figures, (f) => {
    const [year, ...rest] = (f.key ?? "").split("|");
    const rep = byYear.get(year!);
    if (!rep) return null;
    const cards = rep.cards;
    const card = cards.find((c) => c.accountId === rest[0]);
    const used = sum(cards, lineUsed);
    const missed = sum(cards, (c) => sum(c.perks, (l) => l.missedCents));
    const offers = sum(cards, offerCredits);
    const fees = sum(cards, feeRows);
    const rewards = sum(cards, (c) => c.rewards.valueCents);
    const v = f.value;
    switch (f.figure) {
      case "net-value":
        return [centsRoute(ROUTE, v, rewards + used + offers - fees, "rewards + perk credits used + offers − the annual fee rows")];
      case "rewards":
        return [centsRoute(ROUTE, v, rewards, "each card's rewards, as its statements print them (or expected)")];
      case "credits":
        return [centsRoute(ROUTE, v, used + offers, "each perk line's credits used, plus the offer credits")];
      case "capture":
        return [ratioRoute(ROUTE, v, used + missed > 0 ? used / (used + missed) : null, "credits used over used and lapsed, perk line by perk line")];
      case "remaining":
        return [centsRoute(ROUTE, v, sum(cards, (c) => sum(c.perks, (l) => l.remainingCents)), "what each perk line still has")];
      case "fees":
        return [centsRoute(ROUTE, v, fees, "each card's annual fee rows")];
      case "spend":
        return [centsRoute("each card's charges less its refunds", v, sum(cards, (c) => c.spend.chargesCents - c.spend.refundsCents), "card by card")];
      case "perks":
        return [centsRoute(ROUTE, v, used, "each perk line's credits used")];
      case "offers":
        return [centsRoute(ROUTE, v, offers, "the offer credits on each card")];
      case "missed":
        return [centsRoute(ROUTE, v, missed, "what each perk line let lapse")];
      case "card": {
        if (!card) return null;
        const what = rest.slice(1).join("|");
        const periods = card.perks.flatMap((l) => l.periods.filter(held));
        switch (what) {
          case "net":
            return [centsRoute(ROUTE, v, card.rewards.valueCents + lineUsed(card) + offerCredits(card) - feeRows(card), "rewards + perk credits used + offers − the annual fee rows")];
          case "perks":
            return [centsRoute("the card's perk periods, re-added", v, sum(periods, (x) => x.usedCents), "credits used, period by period")];
          case "offers":
            return [centsRoute(ROUTE, v, offerCredits(card), "the card's offer credits")];
          case "fee":
            return [centsRoute(ROUTE, v, feeRows(card), "the card's annual fee rows")];
          case "capture": {
            const lapsed = sum(card.perks, (l) => l.missedCents);
            return [ratioRoute(ROUTE, v, lineUsed(card) + lapsed > 0 ? lineUsed(card) / (lineUsed(card) + lapsed) : null, "credits used over used and lapsed")];
          }
          case "spend":
            return [centsRoute("the card's charges less its refunds", v, card.spend.chargesCents - card.spend.refundsCents, "charges − refunds")];
          case "allowance":
            return [centsRoute("the card's perk periods, re-added", v, sum(periods, (x) => x.allowanceCents), "what each period held offered")];
          case "remaining":
            return [centsRoute(ROUTE, v, sum(card.perks, (l) => l.remainingCents), "what each perk line still has")];
          case "expected":
            return [centsRoute("the card's earn lines, re-added", v, sum(card.earn, (l) => l.units), "cash back expected on each kind of spending")];
          default:
            return { none: "A card's rewards as its statements print them, or what its spending earns at the card list's rates (the Rewards tab reconciles each stretch between printed balances); what lapsed as the perk matcher reads each period; the 12 months to its latest statement, a keep-or-cancel view." };
        }
      }
      case "perk": {
        const line = card?.perks.find((l) => l.id === rest[1]);
        if (!line) return null;
        const periods = line.periods.filter(held);
        return [centsRoute("the line's periods, re-added", v, rest[2] === "used" ? sum(periods, (x) => x.usedCents) : sum(periods, (x) => x.allowanceCents), "period by period")];
      }
      case "period":
        return { none: "A perk period as the matcher reads the statements: each credit it found is a row with its own proof (listed in the chain); what's left is the card's terms less those." };
      case "act": {
        const open = card?.perks.find((l) => l.id === rest[1])?.periods.find((x) => x.status === "OPEN");
        if (!open) return { none: "What a perk's open period still has this year: its terms less the credits found in it (Credits lists each)." };
        return [centsRoute("the open period in the Credits grid", v, open.allowanceCents - open.usedCents, "offered less used")];
      }
      case "optimizer": {
        const row = rest.slice(0, -1).join("|");
        const col = rest.at(-1);
        const lines = rep.optimizer?.lines ?? [];
        if (row === "all" && col === "spend") return [centsRoute("each kind of purchase, re-added", v, sum(lines, (l) => l.spendCents), "line by line")];
        if (row === "all" && col === "actual") return [centsRoute("each kind of purchase, re-added", v, sum(lines, (l) => l.actualCents), "line by line")];
        if (row === "all" && col === "missed") return [centsRoute("each kind of purchase, re-added", v, sum(lines, (l) => l.bestCents - l.actualCents), "best less earned, line by line")];
        const line = lines.find((l) => l.key === row);
        if (line && col === "spend") return [centsRoute("each card's spending on it, re-added", v, sum(line.byCard, (b) => b.spendCents), "card by card")];
        return { none: "Purchases valued at the card list's rates and your point values: a what-if over the statement rows, not a sum of them." };
      }
      case "mix": {
        const label = rest.slice(0, -1).join("|");
        const cents = sum(cards, (c) => sum(c.earn.filter((l) => l.label.replace(/ \(past the cap\)$/, "") === label), (l) => l.units * (c.rewards.kind === "CASH" ? 1 : c.centsPerPoint)));
        return [centsRoute("each card's earn lines, re-added", v, Math.round(cents), "expected rewards on that spending at each card's point value", 1)];
      }
      case "pool":
        return { none: "Rewards as the statements print their balances, reconciled stretch by stretch against what the spending should earn (each balance opens its statement)." };
      default:
        return null;
    }
  });
}

/** HSA › Growth: both accounts' worth in the plan year by the closed form (a geometric series for the taxable account), not the year-by-year loop. */
export function rederiveHsa(r: Pick<HsaReport, "growth"> & Partial<Pick<HsaReport, "expenses">>, figures: readonly DerivedFigure[]): Record<string, Rederivation> {
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
  const expenses = r.expenses ?? [];
  // Bills re-added from the log, by the year (or patient, kind) each is dated.
  const billSum = (keep: (e: (typeof expenses)[number]) => boolean, open = false) => expenses.filter((e) => keep(e) && (!open || !e.reimbursement)).reduce((s, e) => s + e.amountCents, 0);
  return rederiveList(figures, (f) => {
    switch (f.figure) {
      case "edge":
        return [centsRoute("both accounts in closed form", f.value, Math.round(open * hsa) - Math.round(open * taxable), "(1 + r)ⁿ in the HSA; the taxable account grows (1 + r − dividend tax) a year, its basis a geometric series", 2)];
      case "taxable-value":
        return [centsRoute("the taxable account in closed form", f.value, Math.round(open * taxable), "(1 + r − dividend tax)ⁿ, its basis a geometric series, the gain taxed at sale", 2)];
      case "year": {
        const [, year, col] = (f.key ?? "").split("|");
        if (col === "reimbursedInYearCents") return [centsRoute("reimbursements re-added from the log", f.value, expenses.filter((e) => e.reimbursement?.date?.startsWith(year!)).reduce((s, e) => s + e.amountCents, 0), "bills whose reimbursement is dated that year")];
        return [centsRoute("bills re-added from the log", f.value, billSum((e) => e.date.startsWith(year!), col === "unreimbursedCents"), "bills dated that year")];
      }
      case "breakdown": {
        const [scope, key, col] = (f.key ?? "").split("|");
        const of = (e: (typeof expenses)[number]) => (scope === "patient" ? (e.patient || "Unassigned") === key : e.kind === key);
        return [centsRoute("bills re-added from the log", f.value, billSum(of, col === "open"), `bills by ${scope}`)];
      }
      case "expense":
        return { none: "An expense as you logged it: the log is its own source (its paying row, where tied, opens its own proof)." };
      case "expense-growth":
      case "growth-rate":
      case "strategy":
        return { none: "The HSA growth model on your settings and the rate it states: the growth total and the edge are re-derived in closed form; these are its per-bill and per-$1,000 parts." };
      case "default":
        return { none: "What a blank setting falls back to, as the page it comes from works it out (the HSA's measured return, the forecast's return, the Taxes page's marginal rate, the taxable statements' dividend yield, the tax engine's gain rate): each is proven there." };
      case "found-likely":
        return { none: "Statement rows the qualifier flags as care, each a row with its own proof (listed in the chain)." };
      default:
        return null;
    }
  });
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
export const FORECAST_WHY = "The forecast's own schedule and balances on the saved drivers: a projection, not a sum of statements. Its ledger cells and seeds are proven as forecast figures, and the pay and letters behind each bonus by their own proofs.";
export const BUILT_WHY = "A part of the period's roll-forward as the report splits it: the change proof re-adds opening + those flows = closing from each account's timeline, and the closing balance is proven from its statements.";
export const TAXES_WHY = "The tax engine's own lines for each return (joint, each spouse separately), as the Worksheet states them: the tax estimate's proofs re-derive the engine's inputs from the Book.";
export const FUNDS_WHY = "As the manager's notices and capital statements print it: each notice is its own source, and the chain re-adds what's worked from them.";
