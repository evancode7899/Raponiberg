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
  car: null,
  "cash-flow": null,
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
