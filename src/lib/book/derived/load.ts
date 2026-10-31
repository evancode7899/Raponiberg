import { garagePage } from "../../car/page.ts";
import { CAR_KEY, normalizeGarage } from "../../car/settings.ts";
import { CASH_FLOW_CHECKS } from "../proof/cashFlowProof.ts";
import { carDerived } from "./car.ts";
import { cashFlowDerived } from "./cashFlow.ts";
import { loadBudget } from "../../budget/settings.ts";
import { loadProfileSettings } from "../../profile/settings.ts";
import { buildSpendingReport } from "../reports/spending.ts";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings } from "../../investments/settings.ts";
import { loadJsonSetting } from "../../settingsStore.ts";
import { perBook } from "../proof/common.ts";
import type { DerivedScope } from "../proof/derivedProof.ts";
import { INVESTMENTS_CHECKS } from "../proof/investmentsProof.ts";
import type { ProofContext } from "../proof/types.ts";
import { buildInvestments } from "../reports/investments.ts";
import { investmentsDerived } from "./investments.ts";
import type { DerivedFigure, DerivedPage } from "./types.ts";

/**
 * Each page's derived figures, from its report built as the page's route builds it, once
 * per Book: the proof kind (proof/derivedProof.ts) and the sweep (proof/sweep.ts) both read
 * them here, so the sweep holds exactly the list the proofs prove.
 */

export type DerivedList = { figures: DerivedFigure[]; scope: DerivedScope | null; through: string };

const LOADERS: Record<DerivedPage, ((ctx: ProofContext) => Promise<DerivedList>) | null> = {
  investments: async ({ book, db }) => {
    const r = buildInvestments(book, await loadJsonSetting(db, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings));
    return { figures: investmentsDerived(r), scope: { query: { affects: "NET_WORTH", from: r.asOf, to: r.asOf }, checks: INVESTMENTS_CHECKS }, through: r.asOf };
  },
  car: async ({ book, db }) => {
    const g = garagePage(book, await loadJsonSetting(db, CAR_KEY, normalizeGarage));
    const from = g.cars.flatMap((c) => c.months.map((m) => `${m.month}-01`)).sort()[0] ?? g.statementsThrough;
    return { figures: carDerived(g), scope: { query: { affects: "CASH_FLOW", from, to: g.statementsThrough }, checks: CASH_FLOW_CHECKS }, through: g.statementsThrough };
  },
  "cash-flow": async ({ book, db }) => {
    const [settings, budget] = await Promise.all([loadProfileSettings(db), loadBudget(db)]);
    const r = buildSpendingReport(book, settings);
    const from = r.months[0]?.start ?? book.horizon.cashFlow;
    return { figures: cashFlowDerived(r, budget.targets), scope: { query: { affects: "CASH_FLOW", from, to: r.months.at(-1)?.end ?? from }, checks: CASH_FLOW_CHECKS }, through: r.months.at(-1)?.end ?? from };
  },
  "card-perks": null,
  "net-worth": null,
  integrity: null,
  hsa: null,
  "account-limits": null,
  calendar: null,
  "lp-funds": null,
  insurance: null,
};

export const DERIVED_PAGES = Object.keys(LOADERS) as DerivedPage[];

/** The pages with derived figures to sweep. */
export const sweptDerivedPages = () => DERIVED_PAGES.filter((p) => LOADERS[p]);

export function derivedList(ctx: ProofContext, page: DerivedPage): Promise<DerivedList> {
  const load = LOADERS[page];
  if (!load) return Promise.reject(new Error(`No derived figures for ${page} yet.`));
  return perBook(ctx, `derived:${page}`, () => load(ctx));
}
