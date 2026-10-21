import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { taxLink } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { loadProfileSettings } from "@/lib/profile/settings";
import { buildTaxReport } from "@/lib/tax/buildTaxReport";
import { TAX_YEARS } from "@/lib/tax/params";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** One input the Mortgage page links: the figure, and where it comes from (shown beside the slider). */
export type MortgageLink = { value: number; from: string };

/**
 * The figures the Mortgage page starts from instead of typed guesses: the forecast's
 * return and inflation (the assumptions every page shares), and from the tax engine this
 * year's federal marginal rate, standard deduction (joint) and Connecticut income tax.
 * Each is null when it can't be had (no proven starting point, a withheld tax year). The
 * page keeps a typed value where the owner types one, and shows the linked figure beside it.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedReport(prisma, "mortgage-links", async (book) => {
      const [{ forecast }, profile] = await Promise.all([loadForecast(prisma, book), loadProfileSettings(prisma)]);
      const a = profile.outlook;
      const year = Number(book.today.slice(0, 4));
      const params = TAX_YEARS[year] ?? null;
      const tax = params ? buildTaxReport(book, year, { forecast: forecast ? taxLink(forecast) : null, birthYears: profile.birthYears }) : null;
      const ok = tax && !tax.blocked ? tax : null;
      const links: Record<string, MortgageLink | null> = {
        investReturn: { value: a.returnRate, from: "the Forecast's return" },
        inflation: { value: a.inflation, from: "the Forecast's inflation" },
        fedMarginalRate: ok ? { value: ok.marginal.federal, from: `the Taxes page's ${year} federal marginal rate` } : null,
        standardDeduction: params ? { value: params.federal.standardDeduction.MFJ / 100, from: `${year} law (joint)` } : null,
        stateIncomeTax: ok ? { value: Math.round(ok.scenarios.mfj.ct.totalTax / 100), from: `the Taxes page's ${year} Connecticut tax` } : null,
      };
      return { year, links };
    }),
  );
}
