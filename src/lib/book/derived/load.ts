import { garagePage } from "../../car/page.ts";
import { CAR_KEY, normalizeGarage } from "../../car/settings.ts";
import { CASH_FLOW_CHECKS } from "../proof/cashFlowProof.ts";
import { carDerived } from "./car.ts";
import { cashFlowDerived } from "./cashFlow.ts";
import { insuranceDerived } from "./insurance.ts";
import { loadInsurancePage } from "../../insurance/page.ts";
import { fundsDerived } from "./funds.ts";
import { loadFundsPage } from "../../funds/page.ts";
import { accountLimitsDerived, calendarDerived, hsaPageDerived } from "./planning.ts";
import { loadHsaReport } from "../../hsa/loadReport.ts";
import { taxLink } from "../../forecast/forecast.ts";
import { loadForecast } from "../../forecast/load.ts";
import { buildTaxReport } from "../../tax/buildTaxReport.ts";
import { TAX_YEARS } from "../../tax/params.ts";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "../../taxAccounts/settings.ts";
import { buildMoneyCalendar, calendarYears, type CalendarYear } from "../reports/moneyCalendar.ts";
import { buildTaxAccounts } from "../reports/taxAccounts.ts";
import { integrityDerived } from "./integrity.ts";
import { taxesDerived } from "./taxes.ts";
import { forecastDerived } from "./forecast.ts";
import type { TaxReport } from "../../tax/buildTaxReport.ts";
import { builtDerived, changeStepsDerived, changeTypicalDerived, netWorthDerived } from "./netWorth.ts";
import { buildNetWorthChanges } from "../reports/netWorthChanges.ts";
import { buildNetWorth } from "../reports/netWorth.ts";
import { NET_WORTH_CHECKS } from "../proof/netWorthProof.ts";
import { cardPerksDerived } from "./cardPerks.ts";
import { loadCardPerksPage } from "../../cardPerks/page.ts";
import { loadBudget } from "../../budget/settings.ts";
import { loadProfileSettings } from "../../profile/settings.ts";
import { buildSpendingReport } from "../reports/spending.ts";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings } from "../../investments/settings.ts";
import { loadJsonSetting } from "../../settingsStore.ts";
import { perBook } from "../proof/common.ts";
import type { DerivedScope } from "../proof/derivedProof.ts";
import { INVESTMENTS_CHECKS } from "../proof/investmentsProof.ts";
import type { ProofContext, Rederivation } from "../proof/types.ts";
import { buildInvestments } from "../reports/investments.ts";
import { investmentsDerived } from "./investments.ts";
import type { DerivedFigure, DerivedPage } from "./types.ts";
import { rederiveCashFlow } from "../rederive/cashFlow.ts";
import { rederiveNetWorth } from "../rederive/netWorth.ts";
import { rederiveInvestments } from "../rederive/investments.ts";
import { rederiveCar } from "../rederive/car.ts";
import { CALENDAR_WHY, declared, FUNDS_WHY, INTEGRITY_WHY, LIMITS_WHY, TAXES_WHY, BUILT_WHY, FORECAST_WHY, rederiveCardPerks, rederiveHsa, rederiveInsurance } from "../rederive/pages.ts";

/**
 * Each page's derived figures, from its report built as the page's route builds it, once
 * per Book: the proof kind (proof/derivedProof.ts) and the sweep (proof/sweep.ts) both read
 * them here, so the sweep holds exactly the list the proofs prove.
 */

/**
 * `rederived`: figures worked out again on the server by a route that shares nothing with
 * the page's report (F5's independent proofs, proof/independence.ts), by derivedKey; a
 * figure without one re-reads the page's report only.
 */
export type DerivedList = { figures: DerivedFigure[]; scope: DerivedScope | null; through: string; rederived?: Readonly<Record<string, Rederivation>> };

const LOADERS: Record<DerivedPage, ((ctx: ProofContext) => Promise<DerivedList>) | null> = {
  investments: async ({ book, db }) => {
    const r = buildInvestments(book, await loadJsonSetting(db, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings));
    const figures = investmentsDerived(r);
    return { figures, rederived: rederiveInvestments(book, r, figures), scope: { query: { affects: "NET_WORTH", from: r.asOf, to: r.asOf }, checks: INVESTMENTS_CHECKS }, through: r.asOf };
  },
  car: async ({ book, db }) => {
    const g = garagePage(book, await loadJsonSetting(db, CAR_KEY, normalizeGarage));
    const from = g.cars.flatMap((c) => c.months.map((m) => `${m.month}-01`)).sort()[0] ?? g.statementsThrough;
    const figures = carDerived(g);
    return { figures, rederived: rederiveCar(g, figures), scope: { query: { affects: "CASH_FLOW", from, to: g.statementsThrough }, checks: CASH_FLOW_CHECKS }, through: g.statementsThrough };
  },
  "cash-flow": async ({ book, db }) => {
    const [settings, budget] = await Promise.all([loadProfileSettings(db), loadBudget(db)]);
    const r = buildSpendingReport(book, settings);
    const from = r.months[0]?.start ?? book.horizon.cashFlow;
    const figures = cashFlowDerived(r, budget.targets);
    return { figures, rederived: rederiveCashFlow(book, settings, r, figures), scope: { query: { affects: "CASH_FLOW", from, to: r.months.at(-1)?.end ?? from }, checks: CASH_FLOW_CHECKS }, through: r.months.at(-1)?.end ?? from };
  },
  "card-perks": async ({ book, db }) => {
    const first = await loadCardPerksPage(db, undefined, book);
    const years = await Promise.all(first.report.years.map((y) => (y === first.report.year ? first : loadCardPerksPage(db, y, book))));
    // Each year's figures read that year's card statements: a finding over them withholds the year (as the page's blockers do).
    const cards = book.accounts.filter((a) => a.type === "CREDIT_CARD").map((a) => a.id);
    const scoped = (y: number) => ({ query: { affects: "CASH_FLOW" as const, from: `${y}-01-01`, to: `${y}-12-31` < book.horizon.cashFlow ? `${y}-12-31` : book.horizon.cashFlow, accountIds: cards }, checks: CASH_FLOW_CHECKS });
    const figures = years.flatMap((p) => cardPerksDerived(p.report).map((f) => ({ ...f, scope: scoped(p.report.year) })));
    return { figures, rederived: rederiveCardPerks(years.map((p) => p.report), figures), scope: null, through: book.horizon.cashFlow };
  },
  "net-worth": async ({ book }) => {
    const r = buildNetWorth(book, { granularity: "month" });
    const from = r.proven.returns.portfolio?.from ?? r.current.asOf;
    const changes = (["month", "quarter", "year"] as const).map((granularity) => buildNetWorthChanges(book, { granularity }));
    // How it was built, at each granularity its control offers.
    const built = [r, ...(["quarter", "year"] as const).map((granularity) => buildNetWorth(book, { granularity }))].flatMap(builtDerived);
    const figures = [...netWorthDerived(r), ...changes.flatMap(changeStepsDerived), ...changes.flatMap(changeTypicalDerived), ...built];
    return { figures, rederived: { ...rederiveNetWorth(book, figures, r.proven.returns.portfolio?.from ?? null, changes), ...declared(BUILT_WHY)(built) }, scope: { query: { affects: "NET_WORTH", from, to: r.current.asOf }, checks: NET_WORTH_CHECKS }, through: r.current.asOf };
  },
  integrity: async ({ book }) => {
    const figures = integrityDerived({ ...book.integrity, horizon: book.horizon });
    return { figures, rederived: declared(INTEGRITY_WHY)(figures), scope: null, through: book.horizon.netWorth };
  },
  hsa: async ({ db, book }) => {
    const r = await loadHsaReport(db);
    const figures = hsaPageDerived(r);
    return { figures, rederived: rederiveHsa(r, figures), scope: null, through: book.horizon.netWorth };
  },
  "account-limits": async (ctx) => {
    const ys = await taxYears(ctx);
    const figures = ys.flatMap((y) => accountLimitsDerived(y.accounts));
    return { figures, rederived: declared(LIMITS_WHY)(figures), scope: null, through: ctx.book.horizon.cashFlow };
  },
  taxes: async (ctx) => {
    const figures = (await taxYears(ctx)).flatMap((y) => (y.tax.blocked ? [] : taxesDerived(y.tax as TaxReport)));
    return { figures, rederived: declared(TAXES_WHY)(figures), scope: null, through: ctx.book.horizon.cashFlow };
  },
  forecast: async ({ book, db }) => {
    const { forecast, data } = await loadForecast(db, book);
    const figures = forecast && data.profile.seeds ? forecastDerived(forecast, data.profile.seeds) : [];
    return { figures, rederived: declared(FORECAST_WHY)(figures), scope: null, through: book.horizon.netWorth };
  },
  calendar: async (ctx) => {
    const ys = await taxYears(ctx);
    const on = calendarYears(ctx.book.today, Object.keys(TAX_YEARS).map(Number));
    const figures = calendarDerived(buildMoneyCalendar(ctx.book.today, ys.filter((y) => on.includes(y.year))));
    return { figures, rederived: declared(CALENDAR_WHY)(figures), scope: null, through: ctx.book.horizon.cashFlow };
  },
  "lp-funds": async ({ book, db }) => {
    const figures = fundsDerived((await loadFundsPage(db, book)).funds);
    return { figures, rederived: declared(FUNDS_WHY)(figures), scope: null, through: book.horizon.netWorth };
  },
  insurance: async ({ book, db }) => {
    const { policies } = await loadInsurancePage(db, book);
    const figures = insuranceDerived(policies);
    return { figures, rederived: rederiveInsurance(book, policies, figures), scope: null, through: book.horizon.cashFlow };
  },
};

/** Each tax year to date, its tax report and account limits as the Taxes, Account limits and Calendar routes build them. */
function taxYears(ctx: ProofContext): Promise<CalendarYear[]> {
  return perBook(ctx, "derived:tax-years", async () => {
    const { book, db } = ctx;
    const [{ forecast }, retirement] = await Promise.all([loadForecast(db, book), loadJsonSetting(db, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings)]);
    const link = forecast ? taxLink(forecast) : null;
    const year = Number(book.today.slice(0, 4));
    return Object.keys(TAX_YEARS)
      .map(Number)
      .filter((y) => y <= year)
      .map((y) => ({ year: y, tax: buildTaxReport(book, y, { forecast: link }), accounts: buildTaxAccounts(book, y, retirement, link) }));
  });
}

export const DERIVED_PAGES = Object.keys(LOADERS) as DerivedPage[];

/** The pages with derived figures to sweep. */
export const sweptDerivedPages = () => DERIVED_PAGES.filter((p) => LOADERS[p]);

export function derivedList(ctx: ProofContext, page: DerivedPage): Promise<DerivedList> {
  const load = LOADERS[page];
  if (!load) return Promise.reject(new Error(`No derived figures for ${page} yet.`));
  return perBook(ctx, `derived:${page}`, () => load(ctx));
}
