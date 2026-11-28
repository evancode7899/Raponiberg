import type { Book } from "../book/load.ts";
import { typicalMonthlyLiving } from "../book/reports/living.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import type { FinancialProfileSettings } from "../profile/settings.ts";

export { coverGap, DEFAULT_NEED_YEARS, MAX_NEED_YEARS, type CoverNeed } from "./needMath.ts";
import type { CoverNeed } from "./needMath.ts";

export function coverNeed(book: Book, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, years: number): CoverNeed {
  const living = typicalMonthlyLiving(book, settings);
  const nw = buildNetWorth(book, { granularity: "month" });
  return {
    years,
    living: living ? { monthlyCents: living.cents, months: living.months, from: living.from, to: living.to } : null,
    balances: nw.current.blockers.length ? null : { asOf: nw.provenThrough, assetsCents: nw.summary.assetsCents, debtsCents: -nw.summary.debtsCents },
  };
}

