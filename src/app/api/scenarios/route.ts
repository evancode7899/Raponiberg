import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { buildGoals, goalForecastOf } from "@/lib/book/reports/goals";
import { prisma } from "@/lib/db";
import { loadForecast } from "@/lib/forecast/load";
import { GOALS_KEY, normalizeGoals } from "@/lib/goals/settings";
import type { ScenarioFacts } from "@/lib/scenarios/engine";
import { scenarioFacts } from "@/lib/scenarios/facts";
import { goalReachOf, type GoalReach } from "@/lib/scenarios/goals";
import { loadJsonSetting } from "@/lib/settingsStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type ScenariosBook = { facts: ScenarioFacts; goals: GoalReach[] };

/**
 * What the scenarios read from the Book beyond the forecast (/api/forecast): the childcare
 * and housing the household pays now, and each goal's remaining need and funding kind.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedBuilt(prisma, "scenarios", async (book): Promise<ScenariosBook> => {
      const [settings, { forecast: f, data }] = await Promise.all([loadJsonSetting(prisma, GOALS_KEY, normalizeGoals), loadForecast(prisma, book)]);
      const report = buildGoals(book, settings, f ? goalForecastOf(f) : null, data.profile.settings);
      return { facts: scenarioFacts(book, data.profile.settings, data.profile.seeds?.start.asOf ?? book.horizon.netWorth), goals: goalReachOf(report) };
    }),
  );
}
