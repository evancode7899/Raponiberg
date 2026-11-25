import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { bonusesOf } from "@/lib/book/reports/bonuses";
import { buildGoals, goalForecastOf } from "@/lib/book/reports/goals";
import { buildInvestments } from "@/lib/book/reports/investments";
import { buildMoneyCalendar, calendarYears } from "@/lib/book/reports/moneyCalendar";
import { buildNetWorth } from "@/lib/book/reports/netWorth";
import { buildNetWorthChanges } from "@/lib/book/reports/netWorthChanges";
import { buildSpendingReport } from "@/lib/book/reports/spending";
import { buildTaxAccounts } from "@/lib/book/reports/taxAccounts";
import { buildBriefing } from "@/lib/dashboard/briefing";
import { prisma } from "@/lib/db";
import { taxLink } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { GOALS_KEY, normalizeGoals } from "@/lib/goals/settings";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings } from "@/lib/investments/settings";
import { loadJsonSetting } from "@/lib/settingsStore";
import { buildTaxReport } from "@/lib/tax/buildTaxReport";
import { startedTaxYears } from "@/lib/tax/params";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "@/lib/taxAccounts/settings";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The Dashboard's panels beyond net worth and cash flow (lib/dashboard/briefing.ts), built from the reports the other pages' routes build, the same way. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedBuilt(prisma, "briefing", async (book) => {
      const [{ forecast, data }, goals, investments, retirement] = await Promise.all([
        loadForecast(prisma, book),
        loadJsonSetting(prisma, GOALS_KEY, normalizeGoals),
        loadJsonSetting(prisma, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings),
        loadJsonSetting(prisma, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings),
      ]);
      const link = forecast ? taxLink(forecast) : null;
      const settings = data.profile.settings;
      const years = calendarYears(book.today, startedTaxYears(book.today));
      return buildBriefing({
        book,
        changes: buildNetWorthChanges(book, { granularity: "month" }),
        netWorth: buildNetWorth(book, { granularity: "month" }),
        spending: buildSpendingReport(book, settings, {}),
        calendar: buildMoneyCalendar(
          book.today,
          years.map((year) => ({ year, tax: buildTaxReport(book, year, { forecast: link }), accounts: buildTaxAccounts(book, year, retirement, link) })),
        ),
        bonuses: bonusesOf(book),
        goals: buildGoals(book, goals, forecast ? goalForecastOf(forecast) : null, settings),
        investments: buildInvestments(book, investments),
        returnRate: settings.outlook.returnRate,
        forecast,
        profile: data.profile,
      });
    }),
  );
}
