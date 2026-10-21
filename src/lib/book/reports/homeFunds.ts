import type { AccountGroup } from "../../ledger/loadLedger.ts";
import type { Book } from "../load.ts";
import type { BlockerRef } from "./blockerRef.ts";
import type { FinancialProfileSettings } from "../../profile/settings.ts";
import { buildNetWorth } from "./netWorth.ts";
import { holdingsByAccount } from "./investments.ts";
import { normalizeInvestmentSettings } from "../../investments/settings.ts";
import { SPENDABLE_GROUPS } from "../definitions.ts";
import { typicalMonthlyLiving } from "./living.ts";

/** Groups that can be spent on a home without penalty: bank cash and taxable brokerage (the shared definition). */
const LIQUID: readonly AccountGroup[] = SPENDABLE_GROUPS;

export type HomeFundsAccount = {
  accountId: string;
  name: string;
  institution: string | null;
  group: AccountGroup;
  valueCents: number;
  /**
   * Money that went in: the balance it had when its first statement began plus net
   * deposits since. Withdrawals reduce it dollar for dollar, which overstates the gain
   * (a sale really returns basis pro rata), so the tax estimate errs high.
   */
  basisCents: number;
  /** Growth net of fees (plus anything unexplained) over its statement history; 0 for bank cash. */
  gainCents: number;
  /** Part of the basis that is the opening balance of its first statement (true basis unknown). */
  openingBalanceCents: number;
  /** STATEMENT: every position's cost basis is printed on its latest holdings, so the gain is the statement's; ESTIMATE: growth over the statements on file. */
  gainSource: "STATEMENT" | "ESTIMATE" | "NONE";
};

export type HomeFunds = {
  asOf: string;
  accounts: HomeFundsAccount[];
  cashCents: number;
  investmentsCents: number;
  /** Embedded gain across taxable accounts (losses offset gains, floored at zero). */
  gainCents: number;
  /** Basis that is a first statement's opening balance rather than tracked deposits. */
  untrackedBasisCents: number;
  /** Groups left out on purpose (retirement, 529, HSA, other) with their balances. */
  excluded: { group: AccountGroup; cents: number }[];
  /** Credit card balances (negative = owed); not netted, shown for context. */
  cardsCents: number;
  blockers: BlockerRef[];
};

/** What the household spends today outside housing: what's left after a home's costs has to cover it. */
export type HomeSpending = {
  /** Living cost a month (the shared definition) over the latest proven months (up to twelve), housing left out. */
  monthlyCents: number;
  months: number;
  from: string;
  to: string;
  /** The housing it leaves out a month (rent, renter's insurance, utilities): the home's own costs replace it. */
  housingMonthlyCents: number;
};

const HOUSING_CATEGORY = "Housing & utilities";

/**
 * The typical month's living cost (book/reports/living.ts: the same figure Goals and the
 * forecast use) with housing & utilities left out whole: the home's all-in cost (which
 * includes utilities) takes their place. Null with no proven month.
 */
export function buildHomeSpending(book: Book, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">): HomeSpending | null {
  const t = typicalMonthlyLiving(book, settings, { leaveOut: HOUSING_CATEGORY });
  if (!t) return null;
  return { monthlyCents: t.cents, months: t.months, from: t.from, to: t.to, housingMonthlyCents: t.leftOutCents };
}

/**
 * What the household could put toward a home from the Book: bank cash plus taxable
 * investments at the proven-through date, with each investment account's embedded gain
 * (its growth over every statement on file) so a capital-gains haircut can be applied.
 * Retirement, 529 and HSA balances are listed but never counted.
 */
export function buildHomeFunds(book: Book): HomeFunds {
  const nw = buildNetWorth(book, { granularity: "year" });
  const held = holdingsByAccount(book, normalizeInvestmentSettings({}));
  const byId = new Map<string, { growth: number; unexplained: number; contributions: number; newlyTracked: number }>();
  for (const p of nw.periods) {
    for (const a of p.byAccount) {
      const cur = byId.get(a.accountId) ?? { growth: 0, unexplained: 0, contributions: 0, newlyTracked: 0 };
      cur.growth += a.growthNetOfFeesCents;
      cur.unexplained += a.unexplainedCents;
      cur.contributions += a.contributionsCents;
      cur.newlyTracked += a.newlyTrackedCents;
      byId.set(a.accountId, cur);
    }
  }

  const accounts: HomeFundsAccount[] = [];
  const excluded = new Map<AccountGroup, number>();
  let cardsCents = 0;
  for (const a of nw.accounts) {
    if (a.closed || a.currentCents === 0) continue;
    if (a.group === "Credit cards") {
      cardsCents += a.currentCents;
      continue;
    }
    if (!LIQUID.includes(a.group)) {
      excluded.set(a.group, (excluded.get(a.group) ?? 0) + a.currentCents);
      continue;
    }
    const f = byId.get(a.id);
    const isInv = a.group === "Taxable investments";
    // The statement's own cost basis when every position prints one (cash is its own basis);
    // else the growth over its statement history, which errs high (see basisCents).
    const rows = isInv ? held.positions.filter((p) => p.accountId === a.id) : [];
    const printed = rows.length > 0 && rows.every((p) => p.kind !== "ACCOUNT" && (p.costBasisCents != null || p.kind === "CASH"));
    const basisPrinted = printed ? rows.reduce((s, p) => s + (p.costBasisCents ?? p.valueCents), 0) : null;
    const gain = !isInv ? 0 : basisPrinted != null ? a.currentCents - basisPrinted : f ? f.growth + f.unexplained : 0;
    accounts.push({
      accountId: a.id,
      name: a.name,
      institution: a.institution,
      group: a.group,
      valueCents: a.currentCents,
      basisCents: a.currentCents - gain,
      gainCents: gain,
      openingBalanceCents: isInv && f && basisPrinted == null ? f.newlyTracked : 0,
      gainSource: !isInv ? "NONE" : basisPrinted != null ? "STATEMENT" : "ESTIMATE",
    });
  }
  accounts.sort((x, y) => y.valueCents - x.valueCents);
  const sum = (xs: HomeFundsAccount[], f: (a: HomeFundsAccount) => number) => xs.reduce((s, a) => s + f(a), 0);
  const inv = accounts.filter((a) => a.group === "Taxable investments");
  return {
    asOf: nw.provenThrough,
    accounts,
    cashCents: sum(accounts.filter((a) => a.group === "Cash"), (a) => a.valueCents),
    investmentsCents: sum(inv, (a) => a.valueCents),
    gainCents: Math.max(0, sum(inv, (a) => a.gainCents)),
    untrackedBasisCents: sum(inv, (a) => Math.max(0, a.openingBalanceCents)),
    excluded: [...excluded].map(([group, cents]) => ({ group, cents })),
    cardsCents,
    blockers: nw.current.blockers,
  };
}
