import type { Prisma, PrismaClient } from "@prisma/client";
import type { Book } from "../book/load.ts";
import { taxLink } from "../forecast/forecast.ts";
import { loadForecast } from "../forecast/load.ts";
import { loadProfileSettings } from "../profile/settings.ts";
import { buildTaxReport } from "../tax/buildTaxReport.ts";
import { TAX_YEARS } from "../tax/params.ts";
import type { LinkedKey } from "./inputs.ts";

/** One input the Mortgage page links: the figure, and where it comes from (shown beside the slider). */
export type MortgageLink = { value: number; from: string };
export type MortgageLinks = Record<LinkedKey, MortgageLink | null>;

/**
 * The figures the Mortgage page starts from instead of typed guesses: the forecast's
 * return and inflation (the assumptions every page shares), and from the tax engine this
 * year's federal marginal rate, standard deduction (joint) and Connecticut income tax.
 * Each is null when it can't be had (no proven starting point, a withheld tax year). Read
 * by api/mortgage/links and by the Mortgage figures' proofs alike.
 */
export async function buildMortgageLinks(db: PrismaClient | Prisma.TransactionClient, book: Book): Promise<{ year: number; links: MortgageLinks }> {
  const [{ forecast }, profile] = await Promise.all([loadForecast(db, book), loadProfileSettings(db)]);
  const a = profile.outlook;
  const year = Number(book.today.slice(0, 4));
  const params = TAX_YEARS[year] ?? null;
  const tax = params ? buildTaxReport(book, year, { forecast: forecast ? taxLink(forecast) : null }) : null;
  const ok = tax && !tax.blocked ? tax : null;
  return {
    year,
    links: {
      investReturn: { value: a.returnRate, from: "the Forecast's return" },
      inflation: { value: a.inflation, from: "the Forecast's inflation" },
      fedMarginalRate: ok ? { value: ok.marginal.federal, from: `the Taxes page's ${year} federal marginal rate` } : null,
      standardDeduction: params ? { value: params.federal.standardDeduction.MFJ / 100, from: `${year} law (joint)` } : null,
      stateIncomeTax: ok ? { value: Math.round(ok.scenarios.mfj.ct.totalTax / 100), from: `the Taxes page's ${year} Connecticut tax` } : null,
    },
  };
}
