import type { Prisma, PrismaClient } from "@prisma/client";
import type { Book } from "../book/load.ts";
import { bonusesOf } from "../book/reports/bonuses.ts";
import { buildGoals, goalForecastOf } from "../book/reports/goals.ts";
import { buildInvestments } from "../book/reports/investments.ts";
import { buildMoneyCalendar, calendarYears } from "../book/reports/moneyCalendar.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import { buildNetWorthChanges } from "../book/reports/netWorthChanges.ts";
import { buildSpendingReport } from "../book/reports/spending.ts";
import { buildTaxAccounts } from "../book/reports/taxAccounts.ts";
import { taxLink } from "../forecast/forecast.ts";
import { loadForecast } from "../forecast/load.ts";
import { GOALS_KEY, normalizeGoals } from "../goals/settings.ts";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings } from "../investments/settings.ts";
import { loadJsonSetting } from "../settingsStore.ts";
import { buildTaxReport } from "../tax/buildTaxReport.ts";
import { startedTaxYears } from "../tax/params.ts";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "../taxAccounts/settings.ts";
import { readRowDecisions } from "../review/rowDecisions.ts";
import { buildAnomalies } from "../book/reports/anomalies.ts";
import { buildBriefing, type Briefing } from "./briefing.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/** The Dashboard's briefing (briefing.ts) from a Book, built from the reports the other pages' routes build, the same way: the Dashboard's route and the phone digest (scripts/digest.ts) both read it. */
export async function loadBriefing(db: Db, book: Book): Promise<Briefing> {
  const [{ forecast, data }, goals, investments, retirement] = await Promise.all([
    loadForecast(db, book),
    loadJsonSetting(db, GOALS_KEY, normalizeGoals),
    loadJsonSetting(db, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings),
    loadJsonSetting(db, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings),
  ]);
  const link = forecast ? taxLink(forecast) : null;
  const settings = data.profile.settings;
  const years = calendarYears(book.today, startedTaxYears(book.today));
  const spending = buildSpendingReport(book, settings, {});
  return buildBriefing({
    book,
    changes: buildNetWorthChanges(book, { granularity: "month" }),
    netWorth: buildNetWorth(book, { granularity: "month" }),
    spending,
    anomalies: buildAnomalies(book, spending, reviewedRows()),
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
}

/** The rows the owner answered one by one: a damaged file (a finding of its own) reads as none here. */
function reviewedRows() {
  try {
    return readRowDecisions().decisions.map((d) => d.row);
  } catch {
    return [];
  }
}
