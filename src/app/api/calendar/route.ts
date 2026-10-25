import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildMoneyCalendar, calendarYears } from "@/lib/book/reports/moneyCalendar";
import { buildTaxAccounts } from "@/lib/book/reports/taxAccounts";
import { prisma } from "@/lib/db";
import { taxLink } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { loadJsonSetting } from "@/lib/settingsStore";
import { buildTaxReport } from "@/lib/tax/buildTaxReport";
import { TAX_YEARS } from "@/lib/tax/params";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "@/lib/taxAccounts/settings";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The money calendar: each dated thing to do with the amount the Taxes and Account limits
 * pages already work out, for this tax year and, until its filing date, last year. Built
 * from the same reports those pages' routes build, with the same forecast link.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedReport(prisma, "calendar", async (book) => {
      const [settings, { forecast }] = await Promise.all([loadJsonSetting(prisma, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings), loadForecast(prisma, book)]);
      const link = forecast ? taxLink(forecast) : null;
      const years = calendarYears(book.today, Object.keys(TAX_YEARS).map(Number));
      return buildMoneyCalendar(
        book.today,
        years.map((year) => ({ year, tax: buildTaxReport(book, year, { forecast: link }), accounts: buildTaxAccounts(book, year, settings, link) })),
      );
    }),
  );
}
